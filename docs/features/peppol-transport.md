# PEPPOL Transport

Send e-invoices over the PEPPOL network and receive inbound documents
automatically. Inkvoice is **not** an access point: it is an API client of
one, so there is no OpenPeppol membership, no Transport Infrastructure
Agreement and no conformance testing to run.

## What it does

- **Send** invoices and credit notes from the invoice detail view ("Send via
  PEPPOL"), with a delivery state machine: `queued → sending → sent →
  delivered` (or `rejected` / `failed`).
- **Receive** inbound PEPPOL documents straight into the **E-Rechnung inbox**
  (they carry a "PEPPOL" source badge).
- **Register** your business as a PEPPOL receiver with a three-step wizard
  (check → register → confirm KYC), including conflict detection: a business
  already served by another access point is never taken over.

## Opt-in, off by default

Like the German e-invoicing module, PEPPOL is **disabled by default** and
invisible until enabled. Enable it under **Settings → PEPPOL**, then:

1. Pick a **transport provider**. OSS ships the `peppol.sh` driver with
   bring-your-own credentials (environment variables only, never stored in
   the database).
2. Set your **sender identity** (EAS scheme + identifier). Sending works the
   moment these are set.
3. Optionally **register as a receiver** so inbound documents arrive.
4. Optionally enable **auto-send** so every sent invoice is transmitted when
   the customer is reachable.

## Environment variables (OSS, self-hosted)

| Variable | Purpose |
|---|---|
| `PEPPOL_SH_API_KEY` | Provider API key; its presence enables the peppol.sh driver |
| `PEPPOL_SH_WEBHOOK_SECRET` | HMAC secret verifying inbound callbacks; without it inbound is refused |
| `PEPPOL_SH_BASE_URL` | Override for sandbox or a self-hosted proxy. Must be https |

## Customer addressing

Each customer stores a receiver identifier under **Customers → E-Rechnung**
(`einvoice_receiver_scheme` + `einvoice_receiver_id`). The customer form has a
**Check PEPPOL** button that looks the participant up on the network and caches
the result (24 h TTL). The invoice form warns inline when the selected customer
was last checked as unreachable.

## Delivery states

- `queued` / `sending`: ours, not yet accepted by the provider.
- `sent`: the provider accepted the document. Network delivery is still
  pending — `sent` is never `delivered`.
- `delivered` / `rejected`: only ever set by the provider's status callback
  (Message Level Response).
- `failed`: retries exhausted. Backoff is 1m, 5m, 15m, 1h, 6h, 24h; permanent
  errors (4xx other than 408/429) fail immediately. Failed rows can be
  retried from the transmission panel.

Every attempt is recorded (`einvoice_transmission_attempts`) and shown in the
invoice detail panel. Terminal transitions also fire outgoing webhook events:
`einvoice.transmitted`, `einvoice.delivered`, `einvoice.rejected`,
`einvoice.failed`, `einvoice.received`.

## Inbound webhooks

The provider calls `POST /api/v1/webhooks/peppol` (public, like the payment
gateway webhooks). Verification is HMAC-SHA256 over the **raw body** with a
5-minute timestamp window and a per-event replay table. Any verification
failure returns 401 with no detail. Documents are capped at 10 MB before
anything touches SQLite.

## Swapping providers

The transport is an adapter: interface in
`packages/backend/src/services/einvoice-transports/types.ts`, drivers in the
same directory, registry selects by the `peppol_transport` setting. A new
provider is one new file plus a settings change — never a refactor.
