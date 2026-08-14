# France E-Invoicing (Factur-X)

French e-invoicing support: emit EN 16931-compliant **Factur-X** e-invoices with French
buyer identifiers and, on **Inkvoice Cloud**, deliver them to French businesses through a
registered Plateforme de Dématérialisation Partenaire (PDP). In France, receiving
e-invoices becomes mandatory for **all businesses** on **1 September 2026**; issuing
becomes mandatory on **1 September 2026** for grandes entreprises and ETI, and on
**1 September 2027** for PME, TPE and micro-entreprises.

## Mandate dates

| Who | Receive | Issue |
|---|---|---|
| All businesses | 1 September 2026 | see below |
| Grandes entreprises and ETI | 1 September 2026 | 1 September 2026 |
| PME, TPE and micro-entreprises | 1 September 2026 | 1 September 2027 |

## Delivery through a registered PA (Inkvoice Cloud)

French e-invoices must be exchanged over the public network through an immatriculated
PDP/PA. Inkvoice Cloud is connected to **Qonto**, a registered PA, as the delivery
provider for French e-invoicing:

- Outbound invoices are routed through Qonto to the recipient's PDP.
- Inbound documents from French suppliers arrive through Qonto.
- Delivery requires one-time onboarding: from **Settings → France**, complete the
  registration at Qonto (KYC). Until the registration is active, sending is not possible.

> **Self-hosted (OSS):** delivery is a cloud feature. Self-hosted installs emit Factur-X
> with French buyer identifiers (SIREN/SIRET) and the franchise-en-base exemption, but do
> not deliver through a PDP; exchange with French recipients still happens by sending the
> hybrid PDF/XML directly, as before.

## Emission stays Factur-X

The French mandate uses the **Factur-X** format (ZUGFeRD 2.2 / EN 16931), and emission on
the France network always produces the Factur-X hybrid PDF. In the XML, the buyer is
identified with the French business identifiers:

| Buyer ID | Scheme | When |
|---|---|---|
| **SIREN** (9 digits) | `0009` | Always, when the customer has one |
| **SIRET** (14 digits) | `0002` | Only when the customer has no SIREN |

## Customer SIREN and SIRET fields

The customer form (e-invoice section) has two French fields:

| Field | Purpose |
|---|---|
| **SIREN (France)** | Required to deliver e-invoices to a French business. 9 digits, e.g. `123456789` |
| **SIRET (France, optional)** | 14-digit establishment number, only needed if the buyer addresses a specific site, e.g. `12345678900012` |

When France e-invoicing is enabled, the form adds a **Check on Annuaire** button that
verifies the SIREN against the French annuaire (through the PA) and shows whether the
business is registered for e-invoicing. Emission reports a validation warning when a
French buyer has no SIREN.

## Franchise en base de TVA

Businesses under the franchise en base de TVA regime are exempt from VAT (art. 293 B du
CGI). The **Franchise en base** toggle in Settings (`einvoice_franchise_fr`) marks your
zero-VAT invoices as exempt in the Factur-X XML:

- Zero-VAT lines are emitted with tax category **E** instead of **Z**.
- Each exempt line carries the exemption reason `TVA non applicable, art. 293 B du CGI`.

## France settings (Inkvoice Cloud)

Under **Settings → France** (visible on Inkvoice Cloud when the France plugin is
enabled):

- **Master toggle**: enables or disables France e-invoicing
- **Your SIREN (issuer)**: the sender identity used on the France network
- **Registration status**: your Qonto registration state, with an onboarding link
  when KYC is still pending
- **Monthly usage**: documents sent and received in the current period against the plan
  quota

## Sending via the France network

1. Complete the Qonto registration and set your **sender SIREN** in **Settings → France**.
2. Make sure the customer has a **SIREN** (and optionally a SIRET) on their profile.
3. Open the invoice → **Transmission** panel → **Transmit**. The invoice is validated,
   emitted as **Factur-X**, and the recipient's SIREN is checked on the Annuaire.
4. The document is handed to Qonto, which routes it to the recipient's PDP. The
   transmission status updates as delivery progresses.

When the customer has a SIREN and the France network is enabled, the France transport is
used; otherwise delivery falls back to PEPPOL if the customer is configured for it.

## Transmission statuses

| Status | Meaning |
|---|---|
| `queued` / `sending` | Ours; not yet accepted by the PA |
| `sent` | Qonto accepted the document; network delivery is still pending |
| `delivered` / `rejected` | Set by Qonto's status callback, final for the document |
| `failed` | Retries exhausted; retry from the transmission panel |

Every attempt is recorded and shown in the invoice detail panel. Terminal transitions
fire the same outgoing webhook events as other transports (`einvoice.delivered`,
`einvoice.rejected`, etc.).

## Inbox (receiving)

Inbound Factur-X documents delivered by Qonto land directly in the **E-Rechnung inbox**
with a **Qonto** source badge. They are parsed like any other inbound e-invoice
(supplier, document number, date and total extracted automatically) and can be linked to
a customer or archived. Inbound documents count toward your monthly quota.

## Via API

```http
POST /api/v1/einvoices/:invoiceId/transmit
GET  /api/v1/einvoices/:invoiceId/transmissions
POST /api/v1/einvoices/transmissions/:id/retry
POST /api/v1/einvoices/transmissions/:id/cancel
POST /api/v1/einvoices/france/lookup       ({ siren, customer_id? })
GET  /api/v1/einvoices/inbox
```
