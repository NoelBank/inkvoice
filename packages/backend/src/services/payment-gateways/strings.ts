/**
 * The handful of strings a payer reads on Stripe's or PayPal's own checkout
 * page. Everything else there is rendered by the provider in the payer's
 * language; only what we hand over needs translating.
 *
 * Kept as a small map rather than wired into the frontend i18n files: this
 * runs on the server, and the language is the customer's — taken from the
 * invoice, not from whoever is logged into the dashboard.
 */

const INVOICE_WORD: Record<string, string> = {
  en: "Invoice",
  de: "Rechnung",
  tr: "Fatura",
  es: "Factura",
  fr: "Facture",
};

/** Language subtag only — de-DE and de-AT share the same wording. */
export function languageOf(locale: string | null | undefined): string {
  return (locale ?? "").split("-")[0].toLowerCase();
}

/** e.g. "Rechnung INV-2026-0001" — what the payer sees as the line item. */
export function invoiceLabel(locale: string | null | undefined, invoiceNumber: string): string {
  const word = INVOICE_WORD[languageOf(locale)] ?? INVOICE_WORD.en;
  return `${word} ${invoiceNumber}`;
}

/**
 * Stripe Checkout renders in this language instead of guessing from the
 * payer's browser. "auto" keeps Stripe's own detection for anything we don't
 * have wording for.
 */
export function stripeLocale(locale: string | null | undefined): string {
  const language = languageOf(locale);
  return language in INVOICE_WORD ? language : "auto";
}

/** PayPal wants a full tag; fill in the common region for a bare language. */
const PAYPAL_DEFAULT_REGION: Record<string, string> = {
  en: "US",
  de: "DE",
  tr: "TR",
  es: "ES",
  fr: "FR",
};

export function paypalLocale(locale: string | null | undefined): string | undefined {
  const language = languageOf(locale);
  if (!(language in PAYPAL_DEFAULT_REGION)) return undefined;

  const region = (locale ?? "").split("-")[1];
  return `${language}-${(region || PAYPAL_DEFAULT_REGION[language]).toUpperCase()}`;
}
