# E-Invoicing (E-Rechnung)

German e-invoicing support: emit EN 16931-compliant e-invoices, deliver them by email, and
receive incoming e-invoices from suppliers. In Germany, receiving e-invoices has been mandatory
for all businesses since **1 January 2025**; sending becomes mandatory in **2027** (businesses
above €800k) and **2028** (all businesses).

## Opt-in module

E-Rechnung is **disabled by default** and invisible unless you turn it on — non-German users
never see the E-Rechnung UI. Enable it under **Settings → E-Rechnung (e-invoice)**:

- Shows the **E-Rechnung panel** on every invoice detail view
- Adds the **E-Rechnungen** inbox to the sidebar (`/einvoices`)
- Shows the **E-Rechnung section** in the customer form
- Enables auto-attaching the e-invoice to sent invoice emails
- The setting applies immediately after saving, no restart needed

## Formats

| Format | When it is used | Output |
|---|---|---|
| **ZUGFeRD 2.2** (Factur-X) | Default (`zugferd`) | CII XML embedded in a **PDF/A-3 hybrid PDF** |
| **XRechnung 3.0** (UBL) | Customer has a **Leitweg-ID**, or format set to `xrechnung` | UBL 2.1 XML (no hybrid PDF) |

Resolution order per invoice: **customer format → business setting → ZUGFeRD**; a customer
Leitweg-ID always forces XRechnung.

## Company requirements

For a valid e-invoice your **Settings** must contain:

- Company name and address
- Either a **VAT ID** (`DE` + 9 digits) or a **Steuernummer** in German format
  (e.g. `12/345/67890`), plus the country set to `DE`
- Optional: `E-Rechnung` default format and the **Kleinunternehmer (§19 UStG)** toggle,
  which emits reverse-charge-style zero-VAT documents

Missing or malformed fields do not block emission but are reported as validation
errors/warnings in the emit response and shown in the panel.

## Customer e-invoice fields

In the customer form (visible when the module is enabled):

| Field | Purpose |
|---|---|
| **E-invoice format** | Overrides the business default for this customer |
| **Tax number (Steuernummer)** | The customer's German tax number, used as buyer tax number |
| **Leitweg-ID** | Official ID for public-sector (B2G) customers — forces XRechnung |
| **Receiver ID / scheme** | Identifier for XRechnung delivery, e.g. `DE:VAT`, `0204` |

## Emitting an e-invoice

1. Open the invoice → **E-invoices (E-Rechnung)** panel → **Emit**.
2. The invoice is validated against EN 16931 business rules; the XML (and hybrid PDF for
   ZUGFeRD) is generated and stored as an immutable revision.
3. Download the XML or hybrid PDF from the panel.

### Via API

```http
POST /api/v1/invoices/:id/einvoice/emit
GET  /api/v1/invoices/:id/einvoices
GET  /api/v1/invoices/:id/einvoices/:recordId/xml
GET  /api/v1/invoices/:id/einvoices/:recordId/pdf
DELETE /api/v1/invoices/:id/einvoices/:recordId
```

## Sending by email

When the module is enabled, **Send** on an invoice emits the e-invoice and attaches it to the
email automatically: a **ZUGFeRD hybrid PDF** for `zugferd`, the **raw XML** for XRechnung.
Per-email control lives in the send dialog (Advanced → "Attach e-invoice"), and the global
switch is the module toggle itself.

## Inbox (receiving)

The **E-Rechnungen** page (`/einvoices`) is a mailbox for incoming e-invoices:

- **Import** — upload XRechnung (UBL) or ZUGFeRD (CII) XML files; duplicates (sha256) are rejected
- **Parse** — supplier, document number, issue date and total are extracted automatically
- **Link** — optionally link a document to a customer in your address book
- **Status** — move documents through *inbox → processed → archived*
- **Raw download** — keep the original file for tax archives (8 years, §147 AO)

### Via API

```http
GET    /api/v1/einvoices/inbox
POST   /api/v1/einvoices/inbox/import          (multipart, max 20 MB)
GET    /api/v1/einvoices/inbox/:id
GET    /api/v1/einvoices/inbox/:id/raw
POST   /api/v1/einvoices/inbox/:id/link        ({ customer_id })
POST   /api/v1/einvoices/inbox/:id/status      ({ status: inbox|processed|archived })
DELETE /api/v1/einvoices/inbox/:id
```

## Storage & retention

- Emitted revisions are stored in `einvoice_documents` (XML + optional PDF + sha256 hash).
- Incoming files are stored in `einvoice_inbox` with their original bytes.
- Deleting an emitted revision is possible but **not recommended** — e-invoices must be kept
  for tax purposes for 8 years (§147 AO).
