export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  /** German Steuernummer (tax number; not the USt-IdNr). */
  tax_number: string | null;
  /** Per-customer e-invoice format override (zugferd | xrechnung | peppol | auto). */
  einvoice_format: string | null;
  /** German Leitweg-ID for B2G e-invoices (schemeID "0204"). */
  leitweg_id: string | null;
  /** PEPPOL/e-invoice receiver endpoint id. */
  einvoice_receiver_id: string | null;
  /** PEPPOL/e-invoice receiver scheme (e.g. 0208 for EORI/GLN). */
  einvoice_receiver_scheme: string | null;
  notes: string | null;
  /** BCP 47 tag (e.g. "en-US", "tr-TR"); when set, PDFs render in this locale. */
  language: string | null;
  /** Optional template override; used when an invoice/quote has no template_id set. */
  default_template_id: string | null;
  /** Default currency for this customer's invoices (null = business currency). */
  currency: string | null;
  /** When true, the customer can view their invoices via a per-customer portal URL. */
  portal_enabled: number;
  created_at: string;
  updated_at: string;
}
