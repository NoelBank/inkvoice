# Quotes

Send quotes (estimates) to potential clients before creating an invoice.

## Quote Lifecycle

```
Draft → Sent → Accepted → Converted to Invoice
                 ↓
              Rejected
```

### Statuses

| Status | Description |
|--------|-------------|
| **Draft** | Quote is being prepared |
| **Sent** | Quote has been published and optionally emailed |
| **Accepted** | Client accepted the quote |
| **Rejected** | Client declined the quote |

## Creating a Quote

The quote form mirrors the invoice form — select a customer, add line items, set dates, and publish.

## Converting to Invoice

Once a quote is accepted, click **Convert to Invoice**. A dialog offers two modes:

- **Single invoice** — creates one draft invoice with the same customer, line items, and totals. The quote is linked to the resulting invoice for traceability.
- **Split into instalments** — creates several draft invoices that add up to the quote total (e.g. a deposit plus staged payments).

## Instalments

When converting to instalments, each row defines one invoice:

| Field | Description |
|-------|-------------|
| **Value** | The share of the quote this instalment covers, entered as a percentage or a flat amount. Toggle the unit to convert between the two. |
| **Due in days** | Days from the conversion date until the invoice is due. |
| **Label** | Optional label shown on the generated invoices (e.g. "Deposit", "Stage 2"). Unlabelled instalments default to "Deposit", "Stage 2", ... with the final one labelled "Final". |

- Presets: **Deposit 50%** (50% today, 50% in 30 days) and **Equal split** (three equal parts).
- Instalments must total 100%. The dialog validates this live and disables conversion until it resolves.
- Discounts are carried over proportionally: a percentage discount scales with the subtotal, a fixed-amount discount is split across instalments in the same share.
- Rounding drift is absorbed into the final invoice as a "Rounding adjustment" line, so the generated invoices exactly sum to the quote total.

The quote is marked **Converted** and the quote view lists each generated invoice with its number, status, and total.

## Sharing

Like invoices, published quotes get a unique public link. Customers can view the quote details and download a PDF preview.
