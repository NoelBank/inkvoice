import { getDb } from "../database/connection";
import { logger } from "../utils/logger";
import { parseVatId } from "../utils/vat-id";

/**
 * Checks a customer's VAT ID against the EU VIES registry.
 *
 * This matters for reverse-charge invoices: charging no VAT is only allowed if
 * the recipient's ID is actually valid, otherwise the seller owes the tax. VIES
 * is free and needs no credentials.
 *
 * The check is best-effort by design — a self-hosted box with no outbound
 * internet, or a member state whose registry is down, must never block saving
 * a customer. Those cases report "unavailable", which is distinct from
 * "invalid" and is not persisted as a verdict.
 */

const DEFAULT_BASE_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";
const TIMEOUT_MS = 8000;

export type VatCheckStatus = "valid" | "invalid" | "unsupported" | "unavailable";

export interface VatCheckResult {
  status: VatCheckStatus;
  /** Registered name, when the member state discloses it. */
  name: string | null;
  address: string | null;
  checked_at: string | null;
  /** Present when status is "unavailable" — why the lookup couldn't happen. */
  detail?: string;
}

function baseUrl(): string {
  return (process.env.VIES_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

interface ViesResponse {
  isValid?: boolean;
  name?: string | null;
  address?: string | null;
  userError?: string;
}

export async function checkVatId(vatId: string): Promise<VatCheckResult> {
  const parsed = parseVatId(vatId);
  if (!parsed.syntaxValid) {
    // A malformed or non-EU id is answered locally; VIES would only ever
    // return an error for it.
    return { status: "unsupported", name: null, address: null, checked_at: null };
  }

  const url = `${baseUrl()}/ms/${parsed.countryCode}/vat/${parsed.number}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err, vatId: parsed.normalized }, "VIES lookup failed");
    return {
      status: "unavailable",
      name: null,
      address: null,
      checked_at: null,
      detail: "network",
    };
  }

  if (!res.ok) {
    return {
      status: "unavailable",
      name: null,
      address: null,
      checked_at: null,
      detail: `http_${res.status}`,
    };
  }

  let body: ViesResponse;
  try {
    body = (await res.json()) as ViesResponse;
  } catch {
    return {
      status: "unavailable",
      name: null,
      address: null,
      checked_at: null,
      detail: "bad_response",
    };
  }

  // VIES reports member-state outages through userError rather than HTTP codes.
  if (body.userError && body.userError !== "VALID" && body.userError !== "INVALID") {
    return {
      status: "unavailable",
      name: null,
      address: null,
      checked_at: null,
      detail: body.userError,
    };
  }

  const clean = (value: string | null | undefined): string | null => {
    const trimmed = (value ?? "").trim();
    // The registries use "---" for "not disclosed".
    return !trimmed || trimmed === "---" ? null : trimmed;
  };

  return {
    status: body.isValid ? "valid" : "invalid",
    name: clean(body.name),
    address: clean(body.address),
    checked_at: new Date().toISOString(),
  };
}

/**
 * Runs the check for a stored customer and records the verdict. An
 * "unavailable" result leaves any previous verdict untouched — a temporary
 * outage must not silently downgrade a VAT ID that checked out yesterday.
 */
export async function validateCustomerVatId(customerId: string): Promise<VatCheckResult | null> {
  const db = getDb();
  const customer = db.query("SELECT id, tax_id FROM customers WHERE id = ?").get(customerId) as {
    id: string;
    tax_id: string | null;
  } | null;
  if (!customer) return null;

  if (!customer.tax_id?.trim()) {
    return { status: "unsupported", name: null, address: null, checked_at: null };
  }

  const result = await checkVatId(customer.tax_id);
  if (result.status === "valid" || result.status === "invalid") {
    db.run(
      `UPDATE customers
         SET vat_valid = ?, vat_checked_at = ?, vat_check_name = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [result.status === "valid" ? 1 : 0, result.checked_at, result.name, customerId],
    );
  }

  return result;
}
