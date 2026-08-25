import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import {
  buildOrderBody,
  extractApproveUrl,
  extractCapture,
  extractInvoiceId,
  formatAmount,
  isAlreadyCaptured,
  paypalBaseUrl,
  softDescriptor,
} from "../services/payment-gateways/paypal.gateway";
import {
  getEnabledGateways,
  getGateway,
  isGatewayEnabled,
  listEnabledGatewayMeta,
} from "../services/payment-gateways/registry";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

describe("PayPal pure helpers (no network)", () => {
  test("paypalBaseUrl selects sandbox vs live", () => {
    expect(paypalBaseUrl("live")).toBe("https://api-m.paypal.com");
    expect(paypalBaseUrl("sandbox")).toBe("https://api-m.sandbox.paypal.com");
    expect(paypalBaseUrl("")).toBe("https://api-m.sandbox.paypal.com");
  });

  test("formatAmount always has two decimals", () => {
    expect(formatAmount(100)).toBe("100.00");
    expect(formatAmount(99.5)).toBe("99.50");
    expect(formatAmount(0.1)).toBe("0.10");
  });

  const checkoutContext = (overrides: Record<string, unknown> = {}) => ({
    invoiceId: "inv-1",
    invoiceNumber: "INV-2026-0001",
    shareToken: "tok-1",
    amount: 220.5,
    currency: "eur",
    customerEmail: null,
    customerName: "Kunde GmbH",
    businessName: "Noel Bank",
    locale: "de-DE",
    successUrl: "https://x/success",
    cancelUrl: "https://x/cancel",
    ...overrides,
  });

  test("buildOrderBody carries invoice metadata and amount", () => {
    const body = buildOrderBody(checkoutContext());
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].reference_id).toBe("inv-1");
    expect(body.purchase_units[0].custom_id).toBe("tok-1");
    expect(body.purchase_units[0].amount.currency_code).toBe("EUR");
    expect(body.purchase_units[0].amount.value).toBe("220.50");
    expect(body.application_context.return_url).toBe("https://x/success");
    expect(body.application_context.cancel_url).toBe("https://x/cancel");
  });

  test("buildOrderBody tells the payer which invoice they are settling", () => {
    // The fixture customer is German, so the wording follows.
    const body = buildOrderBody(checkoutContext());
    expect(body.purchase_units[0].description).toBe("Rechnung INV-2026-0001");
    expect(body.purchase_units[0].soft_descriptor).toBe("INV-2026-0001");
    expect(body.application_context.brand_name).toBe("Noel Bank");
  });

  test("buildOrderBody omits brand_name when no business name is configured", () => {
    const body = buildOrderBody(checkoutContext({ businessName: null }));
    expect("brand_name" in body.application_context).toBe(false);
  });

  test("the payer reads the invoice label in their own language", () => {
    for (const [locale, expected] of [
      ["de-DE", "Rechnung INV-2026-0001"],
      ["en-US", "Invoice INV-2026-0001"],
      ["fr-FR", "Facture INV-2026-0001"],
      ["es-ES", "Factura INV-2026-0001"],
      ["tr-TR", "Fatura INV-2026-0001"],
    ] as const) {
      const body = buildOrderBody(checkoutContext({ locale }));
      expect(body.purchase_units[0].description).toBe(expected);
    }
  });

  test("PayPal is pinned to the customer's language", () => {
    expect(buildOrderBody(checkoutContext()).application_context.locale).toBe("de-DE");
    expect(buildOrderBody(checkoutContext({ locale: "de" })).application_context.locale).toBe(
      "de-DE",
    );
    expect(buildOrderBody(checkoutContext({ locale: "de-AT" })).application_context.locale).toBe(
      "de-AT",
    );
  });

  test("an unknown language leaves PayPal's own detection alone", () => {
    const body = buildOrderBody(checkoutContext({ locale: "ja-JP" }));
    expect("locale" in body.application_context).toBe(false);
    // Wording still has to fall back to something readable.
    expect(body.purchase_units[0].description).toBe("Invoice INV-2026-0001");
  });

  test("softDescriptor stays within PayPal's 22-character limit", () => {
    expect(softDescriptor("INV-2026-0001")).toBe("INV-2026-0001");
    expect(softDescriptor("RECHNUNG-2026-000000000123456")).toHaveLength(22);
    // Characters PayPal rejects are dropped rather than failing the order.
    expect(softDescriptor("INV/2026#0001")).toBe("INV20260001");
  });

  test("a long description is truncated rather than rejected by PayPal", () => {
    const body = buildOrderBody(checkoutContext({ invoiceNumber: "X".repeat(200) }));
    expect(body.purchase_units[0].description.length).toBeLessThanOrEqual(127);
  });

  test("extractApproveUrl finds the approval link or throws", () => {
    const url = extractApproveUrl({
      links: [
        { rel: "self", href: "https://x/self" },
        { rel: "approve", href: "https://x/approve" },
      ],
    });
    expect(url).toBe("https://x/approve");
    expect(() => extractApproveUrl({ links: [{ rel: "self", href: "https://x/self" }] })).toThrow();
  });

  test("extractInvoiceId reads the order reference", () => {
    expect(extractInvoiceId({ resource: { purchase_units: [{ reference_id: "inv-9" }] } })).toBe(
      "inv-9",
    );
    expect(extractInvoiceId({ resource: { purchase_units: [{}] } })).toBeNull();
    expect(extractInvoiceId({})).toBeNull();
  });

  test("extractCapture pulls amount + capture id", () => {
    const result = extractCapture({
      purchase_units: [{ payments: { captures: [{ id: "cap-1", amount: { value: "220.50" } }] } }],
    });
    expect(result).toEqual({ amount: 220.5, captureId: "cap-1" });
    expect(extractCapture({ purchase_units: [{}] })).toBeNull();
  });

  test("isAlreadyCaptured detects the idempotency case", () => {
    expect(isAlreadyCaptured({ details: [{ issue: "ORDER_ALREADY_CAPTURED" }] })).toBe(true);
    expect(isAlreadyCaptured({ details: [{ issue: "SOMETHING_ELSE" }] })).toBe(false);
    expect(isAlreadyCaptured({})).toBe(false);
  });
});

const TEST_DB = "./data/test-payment-gateways.db";
let app: Hono;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  // Start with no gateway credentials configured.
  process.env.STRIPE_SECRET_KEY = "";
  process.env.PAYPAL_CLIENT_ID = "";
  process.env.PAYPAL_SECRET = "";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

async function pay(gateway: string) {
  return app.request("http://localhost/api/v1/public/invoices/nonexistent/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gateway }),
  });
}

describe("Gateway registry", () => {
  test("getGateway resolves known gateways and rejects unknown", () => {
    expect(getGateway("stripe")?.id).toBe("stripe");
    expect(getGateway("paypal")?.id).toBe("paypal");
    expect(getGateway("bogus")).toBeUndefined();
  });

  test("no gateways are enabled without credentials or settings", () => {
    expect(getEnabledGateways()).toHaveLength(0);
    expect(listEnabledGatewayMeta()).toHaveLength(0);
  });

  test("a gateway needs BOTH credentials and the enable setting", () => {
    const paypal = getGateway("paypal")!;

    // Setting on, but no credentials → still disabled.
    updateSettings({ paypal_enabled: "true" });
    expect(isGatewayEnabled(paypal)).toBe(false);

    // Credentials without the webhook ID → still disabled (webhooks would fail).
    process.env.PAYPAL_CLIENT_ID = "test-client";
    process.env.PAYPAL_SECRET = "test-secret";
    resetEnvCache();
    expect(isGatewayEnabled(paypal)).toBe(false);

    // Full credentials + setting on → enabled.
    process.env.PAYPAL_WEBHOOK_ID = "wh-test";
    resetEnvCache();
    expect(isGatewayEnabled(paypal)).toBe(true);

    expect(listEnabledGatewayMeta()).toEqual([{ id: "paypal", label: "PayPal" }]);
  });

  test("stripe needs the webhook secret too", () => {
    const stripe = getGateway("stripe")!;
    updateSettings({ stripe_enabled: "true" });

    // Secret key alone is not enough.
    process.env.STRIPE_SECRET_KEY = "sk_test";
    resetEnvCache();
    expect(isGatewayEnabled(stripe)).toBe(false);

    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    resetEnvCache();
    expect(isGatewayEnabled(stripe)).toBe(true);
  });
});

describe("Public pay endpoint gateway selection", () => {
  test("rejects an unknown gateway", async () => {
    const res = await pay("bogus");
    expect(res.status).toBe(400);
  });

  test("rejects a disabled gateway", async () => {
    // Stripe gets disabled in this suite regardless of what prior tests set.
    process.env.STRIPE_SECRET_KEY = "";
    process.env.STRIPE_WEBHOOK_SECRET = "";
    resetEnvCache();
    const res = await pay("stripe");
    expect(res.status).toBe(400);
  });

  test("an enabled gateway passes selection (404 on missing invoice, no network)", async () => {
    // PayPal was enabled in the registry suite; selection should succeed and
    // fail only because the share token doesn't resolve to an invoice.
    const res = await pay("paypal");
    expect(res.status).toBe(404);
  });
});
