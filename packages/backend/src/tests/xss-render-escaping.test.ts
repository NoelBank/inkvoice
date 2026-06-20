// Security regression: address / bank-details fields are interpolated into
// print templates via Mustache's unescaped triple-brace ({{{ }}}) so multi-line
// values keep their <br> formatting. User-supplied parts must be HTML-escaped at
// the data layer so injected markup renders as inert text — independent of the
// CSP that currently happens to block script execution.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { createInvoice, markSent } from "../services/invoice.service";
import { renderInvoiceHtml } from "../services/pdf.service";
import { updateSettings } from "../services/settings.service";
import { renderStatementHtml } from "../services/statement.service";
import { resetEnvCache } from "../utils/env";
import { escapeHtml, escapeLines, escapeMultiline } from "../utils/html";

const TEST_DB = "./data/test-xss-render.db";
const IMG_PAYLOAD = `<img src=x onerror=alert(1)>`;
const SCRIPT_PAYLOAD = `<script>alert('co')</script>`;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("html escaping helpers", () => {
  test("escapeHtml neutralizes the five significant characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("escapeMultiline escapes content but keeps newlines as <br>", () => {
    expect(escapeMultiline("<b>\nLine2")).toBe("&lt;b&gt;<br>Line2");
  });

  test("escapeLines escapes each part, drops empties, joins with <br>", () => {
    expect(escapeLines(["<x>", "", null, "y"])).toBe("&lt;x&gt;<br>y");
  });
});

describe("statement render escaping (customer + company address)", () => {
  test("payloads in customer/company address are escaped, formatting preserved", () => {
    updateSettings({ company_address: `${SCRIPT_PAYLOAD}\nSuite 5` });
    const customer = createCustomer({
      name: "Acme",
      address_line1: IMG_PAYLOAD,
      city: "Springfield",
      postal_code: "12345",
    });

    const html = renderStatementHtml(customer.id, "2026-01-01", "2026-12-31");
    expect(html).toBeTruthy();

    // No raw, executable markup from either field survived.
    expect(html!).not.toContain(IMG_PAYLOAD);
    expect(html!).not.toContain(SCRIPT_PAYLOAD);
    // Escaped forms are present instead.
    expect(html!).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html!).toContain("&lt;script&gt;");
    // The <br> formatting the escaping is meant to preserve still works.
    expect(html!).toContain("<br>Suite 5");
  });
});

describe("invoice render escaping (company address + bank details)", () => {
  test("payloads in company address / bank details are escaped in the invoice HTML", () => {
    updateSettings({
      company_address: `${SCRIPT_PAYLOAD}\nHQ`,
      company_bank_details: `IBAN${IMG_PAYLOAD}`,
    });
    const customer = createCustomer({ name: "Beta Co" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-03-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
    });
    markSent(inv.id);

    const html = renderInvoiceHtml(inv.id);
    expect(html).toBeTruthy();
    // Whatever the default template renders unescaped, no raw payload survives.
    expect(html!).not.toContain(SCRIPT_PAYLOAD);
    expect(html!).not.toContain(IMG_PAYLOAD);
    // company.address is rendered unescaped in every built-in template, so its
    // escaped form must be present.
    expect(html!).toContain("&lt;script&gt;");
  });
});
