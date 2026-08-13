import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../database/connection";
import { seedDemoData } from "../database/seed";
import { isEmailConfigured, sendEmail, testConnection } from "../services/email.service";
import { resetDemoData } from "../services/scheduler";
import { getAllSettings, updateSettings } from "../services/settings.service";
import { getEnv } from "../utils/env";

const settings = new Hono();

settings.get("/", async (c) => {
  const data = getAllSettings();
  const emailConfigured = await isEmailConfigured();
  return c.json({
    success: true,
    data: {
      ...data,
      email_configured: emailConfigured ? "true" : "false",
      demo_mode: getEnv().DEMO_MODE ? "true" : "false",
    },
  });
});

const ALLOWED_SETTINGS = new Set([
  "company_name",
  "company_email",
  "company_phone",
  "company_address",
  "company_street",
  "company_city",
  "company_postal_code",
  "company_country",
  "company_tax_id",
  "company_tax_number",
  "company_bank_details",
  "company_logo",
  "currency",
  "base_currency",
  "exchange_rate_auto_fetch",
  "public_url",
  "pdf_qr_code_enabled",
  "tax_label",
  "invoice_number_pattern",
  "quote_number_pattern",
  "credit_note_number_pattern",
  "default_payment_terms",
  "default_notes",
  "locale",
  "email_from_name",
  "email_reply_to",
  "email_footer_text",
  "email_attach_pdf",
  "notify_on_invoice_view",
  "invoice_email_subject",
  "invoice_email_body",
  "late_fee_enabled",
  "late_fee_type",
  "late_fee_value",
  "late_fee_grace_days",
  "late_fee_frequency",
  "stripe_enabled",
  "paypal_enabled",
  "accent_color",
  "date_format",
  "number_format",
  "tax_rounding_mode",
  "default_tax_rate",
  "prices_include_tax",
  "peppol_endpoint_id",
  "peppol_scheme_id",
  "default_xml_profile",
  "pdf_embed_xml",
  "einvoice_format",
  "einvoice_enabled",
  "einvoice_attach_pdf",
  "einvoice_kleinunternehmer",
  "company_peppol_id",
  "company_peppol_scheme",
  "fiscal_year_start_month",
  "watermark_image",
  "watermark_enabled",
  "onboarding_completed",
  "peppol_enabled",
  "peppol_transport",
  "peppol_sender_scheme",
  "peppol_sender_id",
  "peppol_auto_send",
  "peppol_environment",
]);

// Number patterns with neither a sequence nor a random token render the same
// string every time, and invoice_number/quote_number are UNIQUE, so the second
// document would die on insert. An empty value is fine: it means "use the
// built-in default".
const NUMBER_PATTERN_SETTINGS = [
  "invoice_number_pattern",
  "quote_number_pattern",
  "credit_note_number_pattern",
];
const PATTERN_COUNTER_TOKEN = /\{SEQ\d*\}|\{RAND4\}/;

settings.put("/", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = z.record(z.unknown()).safeParse(raw);
  if (!parsed.success || raw === null || typeof raw !== "object") {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (!ALLOWED_SETTINGS.has(k)) continue;
    if (typeof v !== "string") {
      return c.json({ success: false, error: `Setting "${k}" must be a string` }, 400);
    }
    filtered[k] = v;
  }

  // Only reject values that actually change, so an install that already stored
  // a bad pattern can still save the rest of its settings (and fix the pattern).
  const current = getAllSettings();
  for (const key of NUMBER_PATTERN_SETTINGS) {
    const value = filtered[key];
    if (value === undefined || value === current[key] || value === "") continue;
    if (!PATTERN_COUNTER_TOKEN.test(value)) {
      return c.json(
        {
          success: false,
          error: `Setting "${key}" must contain a {SEQ} or {RAND4} token, otherwise every document would get the same number`,
        },
        400,
      );
    }
  }

  updateSettings(filtered);
  const data = getAllSettings();
  const emailConfigured = await isEmailConfigured();
  return c.json({
    success: true,
    data: { ...data, email_configured: emailConfigured ? "true" : "false" },
  });
});

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"];
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB

async function readImageUpload(
  file: unknown,
): Promise<{ ok: true; dataUri: string } | { ok: false; status: 400; error: string }> {
  if (!file || !(file instanceof File)) {
    return { ok: false, status: 400, error: "No file provided" };
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return { ok: false, status: 400, error: "Image must be under 2MB" };
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid image type. Allowed: PNG, JPEG, GIF, SVG, WebP",
    };
  }
  const buffer = await file.arrayBuffer();
  return {
    ok: true,
    dataUri: `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`,
  };
}

settings.post("/logo", async (c) => {
  const body = await c.req.parseBody();
  const result = await readImageUpload(body.logo);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  updateSettings({ company_logo: result.dataUri });
  return c.json({ success: true, data: { logo: result.dataUri } });
});

settings.post("/watermark", async (c) => {
  const body = await c.req.parseBody();
  const result = await readImageUpload(body.watermark);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  updateSettings({ watermark_image: result.dataUri });
  return c.json({ success: true, data: { watermark: result.dataUri } });
});

settings.post("/test-email", async (c) => {
  const body = await c.req.json();
  const to = body.to;
  if (!to) return c.json({ success: false, error: "Recipient email is required" }, 400);

  const verifyResult = await testConnection();
  if (!verifyResult.success) {
    return c.json({ success: false, error: verifyResult.error }, 400);
  }

  const result = await sendEmail({
    to,
    subject: "Inkvoice — SMTP Test",
    html: "<p>Your SMTP settings are working correctly.</p>",
    text: "Your SMTP settings are working correctly.",
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }
  return c.json({ success: true, data: { message: "Test email sent" } });
});

// Reset the database to seeded demo state. Only available when DEMO_MODE=true
// so this can never wipe a real customer's data.
settings.post("/reset-demo", async (c) => {
  if (!getEnv().DEMO_MODE) {
    return c.json({ success: false, error: "Demo mode is not enabled" }, 403);
  }
  await resetDemoData();
  return c.json({ success: true, data: { message: "Demo data reset" } });
});

// Populate the current database with sample customers/products/invoices.
// Refuses if the database already contains invoices so it can't clobber real data.
settings.post("/seed-sample-data", (c) => {
  const db = getDb();
  const existing = db.query("SELECT COUNT(*) as count FROM invoices").get() as { count: number };
  if (existing.count > 0) {
    return c.json(
      { success: false, error: "Cannot load sample data into a non-empty database" },
      400,
    );
  }
  seedDemoData();
  const customers = db.query("SELECT COUNT(*) as count FROM customers").get() as { count: number };
  const products = db.query("SELECT COUNT(*) as count FROM products").get() as { count: number };
  const invoices = db.query("SELECT COUNT(*) as count FROM invoices").get() as { count: number };
  return c.json({
    success: true,
    data: {
      customers: customers.count,
      products: products.count,
      invoices: invoices.count,
    },
  });
});

export { settings };
