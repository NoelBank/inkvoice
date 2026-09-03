import crypto from "node:crypto";
import { BUILTIN_TEMPLATES, readTemplateFile } from "../services/builtin-templates";
import { getEnv } from "../utils/env";
import { logger } from "../utils/logger";
import { hashPassword } from "../utils/password";
import { getDb } from "./connection";

function seedBuiltinTemplates(): void {
  const db = getDb();

  for (const tmpl of BUILTIN_TEMPLATES) {
    const html = readTemplateFile(tmpl.file);
    const existing = db
      .query("SELECT id, html_content FROM templates WHERE type = 'builtin' AND name = ?")
      .get(tmpl.name) as { id: string; html_content: string } | null;

    if (existing) {
      // Update HTML content if changed
      if (existing.html_content !== html) {
        db.run(
          "UPDATE templates SET html_content = ?, description = ?, updated_at = datetime('now') WHERE id = ?",
          [html, tmpl.description, existing.id],
        );
        logger.info({ template: tmpl.name }, "Updated builtin template");
      }
    } else {
      const id = crypto.randomBytes(16).toString("hex");
      db.run(
        "INSERT INTO templates (id, name, description, html_content, css_content, type, is_default) VALUES (?, ?, ?, ?, ?, 'builtin', ?)",
        [id, tmpl.name, tmpl.description, html, "", tmpl.isDefault ? 1 : 0],
      );
      logger.info({ template: tmpl.name }, "Created builtin template");
    }
  }

  // Remove old "Default" builtin template if it exists, reassigning any references
  const oldDefault = db
    .query("SELECT id FROM templates WHERE type = 'builtin' AND name = 'Default'")
    .get() as { id: string } | null;
  if (oldDefault) {
    const inkvoice = db
      .query("SELECT id FROM templates WHERE type = 'builtin' AND name = 'Inkvoice'")
      .get() as { id: string } | null;
    if (inkvoice) {
      db.run("UPDATE invoices SET template_id = ? WHERE template_id = ?", [
        inkvoice.id,
        oldDefault.id,
      ]);
      db.run("UPDATE quotes SET template_id = ? WHERE template_id = ?", [
        inkvoice.id,
        oldDefault.id,
      ]);
    }
    db.run("DELETE FROM templates WHERE id = ?", [oldDefault.id]);
    logger.info("Removed old 'Default' builtin template.");
  }

  // Ensure at least one template is default
  const hasDefault = db
    .query("SELECT COUNT(*) as count FROM templates WHERE is_default = 1")
    .get() as { count: number };
  if (hasDefault.count === 0) {
    const inkvoice = db
      .query("SELECT id FROM templates WHERE type = 'builtin' AND name = 'Inkvoice'")
      .get() as { id: string } | null;
    if (inkvoice) {
      db.run("UPDATE templates SET is_default = 1 WHERE id = ?", [inkvoice.id]);
    }
  }
}

export async function seed(): Promise<void> {
  const db = getDb();
  const env = getEnv();

  // Seed admin user if no users exist
  const userCount = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const id = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(env.ADMIN_PASS);
    // Explicit role: the user_role migration upgrades pre-existing admins to
    // Owner, but on a fresh DB it runs before this seed — without this the
    // admin would fall back to the column default ('Viewer').
    db.run(
      "INSERT INTO users (id, username, password_hash, is_admin, is_active, role) VALUES (?, ?, ?, 1, 1, 'Owner')",
      [id, env.ADMIN_USER, passwordHash],
    );
    logger.info({ username: env.ADMIN_USER }, "Admin user created");
  }

  // Seed default settings
  const settingsCount = db.query("SELECT COUNT(*) as count FROM settings").get() as {
    count: number;
  };
  if (settingsCount.count === 0) {
    const defaults: [string, string][] = [
      ["company_name", "My Company"],
      ["company_email", ""],
      ["company_phone", ""],
      ["company_address", ""],
      ["company_tax_id", ""],
      ["company_logo", ""],
      ["currency", "USD"],
      ["base_currency", "USD"],
      ["exchange_rate_auto_fetch", "false"],
      ["tax_label", "Tax"],
      ["invoice_number_pattern", "INV-{YYYY}-{SEQ4}"],
      ["quote_number_pattern", "QT-{YYYY}-{SEQ4}"],
      ["credit_note_number_pattern", "CN-{YYYY}-{SEQ4}"],
      ["default_payment_terms", "Net 30"],
      ["default_notes", ""],
      ["locale", "en-US"],
      ["date_format", "YYYY-MM-DD"],
      ["number_format", "1,000.00"],
      ["fiscal_year_start_month", "1"],
      ["public_url", ""],
      ["pdf_qr_code_enabled", "false"],
      ["pdf_epc_qr_enabled", "false"],
      ["company_country", ""],
      ["einvoice_format", "zugferd"],
      ["einvoice_enabled", "false"],
      ["einvoice_attach_pdf", "true"],
      ["einvoice_kleinunternehmer", "false"],
      ["company_peppol_scheme", "0208"],
    ];
    const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of defaults) {
      stmt.run(key, value);
    }
    logger.info("Default settings created.");
  } else {
    // Backfill any newly-added default keys for existing installs.
    const newDefaults: [string, string][] = [
      ["public_url", ""],
      ["pdf_qr_code_enabled", "false"],
      ["pdf_epc_qr_enabled", "false"],
      ["company_country", ""],
      ["einvoice_format", "zugferd"],
      ["einvoice_enabled", "false"],
      ["einvoice_attach_pdf", "true"],
      ["einvoice_kleinunternehmer", "false"],
      ["company_peppol_scheme", "0208"],
      ["quote_number_pattern", "QT-{YYYY}-{SEQ4}"],
      ["credit_note_number_pattern", "CN-{YYYY}-{SEQ4}"],
    ];
    const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of newDefaults) stmt.run(key, value);
  }

  // Seed default tax definition
  const taxCount = db.query("SELECT COUNT(*) as count FROM tax_definitions").get() as {
    count: number;
  };
  if (taxCount.count === 0) {
    // Prefer German VAT presets when the locale/country points at Germany,
    // otherwise fall back to a generic "No Tax" definition (existing behavior).
    const country = (
      (
        db.query("SELECT value FROM settings WHERE key = 'company_country'").get() as {
          value: string;
        } | null
      )?.value || ""
    ).toUpperCase();
    const locale = (
      (
        db.query("SELECT value FROM settings WHERE key = 'locale'").get() as {
          value: string;
        } | null
      )?.value || ""
    ).toLowerCase();
    const german = country === "DE" || locale.startsWith("de");

    if (german) {
      const presets: [string, number, string, string, number][] = [
        ["Umsatzsteuer 19% (Standard)", 19, "S", "Umsatzsteuer regelsatz", 1],
        ["Umsatzsteuer 7 % (ermäßigt)", 7, "AA", "Ermäßigter Steuersatz (z. B. Lebensmittel)", 0],
        ["Umsatzsteuer 0 %", 0, "Z", "Steuerfreie Lieferungen (z. B. innergemeinschaftlich)", 0],
        ["Steuerbefreit (§ 4 UStG)", 0, "E", "Steuerbefreite Leistungen", 0],
      ];
      const stmt = db.prepare(
        "INSERT INTO tax_definitions (id, name, rate, description, category_code, is_default, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)",
      );
      for (const [name, rate, code, desc, isDefault] of presets) {
        stmt.run(crypto.randomBytes(16).toString("hex"), name, rate, desc, code, isDefault);
      }
      logger.info("German VAT presets created (19 %/7 %/0 %/exempt).");
    } else {
      const id = crypto.randomBytes(16).toString("hex");
      db.run(
        "INSERT INTO tax_definitions (id, name, rate, description, is_default, is_active) VALUES (?, ?, ?, ?, 1, 1)",
        [id, "No Tax", 0, "No tax applied"],
      );
      logger.info("Default tax definition created.");
    }
  }

  // Seed product categories
  for (const name of ["service", "goods", "subscription", "other"]) {
    db.run(
      "INSERT OR IGNORE INTO product_categories (id, name, is_builtin) VALUES (lower(hex(randomblob(16))), ?, 1)",
      [name],
    );
  }

  // Seed product units. Older versions allowed built-in rows to be renamed,
  // leaving custom-looking units protected from deletion. Demote those legacy
  // rows before restoring the canonical built-ins.
  db.exec(`
    UPDATE product_units
    SET is_builtin = 0
    WHERE is_builtin = 1
      AND name NOT IN ('piece', 'hour', 'month', 'day', 'kg', 'meter', 'lump_sum')
  `);
  for (const [name, symbol] of [
    ["piece", "pc"],
    ["hour", "hr"],
    ["month", "mo"],
    ["day", "d"],
    ["kg", "kg"],
    ["meter", "m"],
    ["lump_sum", "ls"],
  ] as const) {
    db.run(
      "INSERT OR IGNORE INTO product_units (id, name, symbol, is_builtin) VALUES (lower(hex(randomblob(16))), ?, ?, 1)",
      [name, symbol],
    );
  }

  // Seed/sync builtin templates (runs every startup to keep templates up-to-date)
  seedBuiltinTemplates();
}
