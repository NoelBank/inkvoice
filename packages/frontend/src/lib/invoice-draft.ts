// Short-lived snapshot of an in-progress *new* invoice, used to survive a
// detour to the customer-create page ("Add customer" from the invoice form)
// without losing the line items the user already typed. Edit-mode invoices
// autosave, so only new drafts need this. Mirrors lib/highlight-row.ts:
// sessionStorage, one-shot consume, TTL guard.
const STORAGE_KEY = "inkvoice-invoice-draft";

interface InvoiceDraft {
  form: unknown;
  items: unknown;
  expiresAt: number;
}

export function saveInvoiceDraft(form: unknown, items: unknown, ttlMs = 10 * 60 * 1000): void {
  try {
    const payload: InvoiceDraft = { form, items, expiresAt: Date.now() + ttlMs };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // storage unavailable (private mode / quota) — drafting is best-effort
  }
}

export function consumeInvoiceDraft(): { form: unknown; items: unknown } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as InvoiceDraft;
    if (Date.now() > parsed.expiresAt) return null;
    return { form: parsed.form, items: parsed.items };
  } catch {
    return null;
  }
}
