/**
 * What the UI should show for this business. Derived from settings in one
 * place so pages ask a capability instead of poking individual switches.
 */
export interface Capabilities {
  /** Kleinunternehmer (§ 19 UStG): no VAT on invoices, no VAT reporting. */
  smallBusiness: boolean;
  /** VAT-related UI (tax rates, tax report, tax columns). */
  vat: boolean;
}

export function deriveCapabilities(settings: Record<string, string>): Capabilities {
  const smallBusiness = settings.einvoice_kleinunternehmer === "true";
  return { smallBusiness, vat: !smallBusiness };
}
