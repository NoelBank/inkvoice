# Personal edition: trimming Inkvoice to a single German Kleinunternehmer

Date: 2026-09-02

## Goal

This fork is used by exactly one person: a German freelancer under § 19 UStG
(Kleinunternehmer), employed full-time, filing taxes through a consumer tax
tool. Everything that only makes sense for other audiences is removed so the
app stays small, obvious and cheap to maintain. Anything removed can be
recovered from git history.

## Keep

Invoices, quotes, recurring invoices, credit notes, customers, products,
expenses with receipts, reminders and late fees, statements, payments
(Stripe/PayPal checkout — to be extended later), e-invoice generation
(ZUGFeRD/XRechnung) and the e-invoice inbox, templates, reports (incl. EÜR),
dashboard, backups and year archive, login with 2FA and password reset,
German and English UI.

## Remove

1. **Platform / multi-user** — user management UI and `/api/v1/users`, roles
   UI, OIDC SSO, demo mode, feedback, the plugin framework and catalog
   (including the time-tracker plugin), API tokens, outgoing webhooks, the
   activity-log page. `requirePermission` stays as-is: the single admin user
   holds every permission, so stripping RBAC from 50+ files buys nothing.
   Activity logging in the backend stays; only the page goes.
2. **Languages** — only `en` and `de` remain; `tr`, `es`, `fr` are deleted.
3. **Peppol and France** — transports, UBL-Peppol profile, Peppol/France
   settings and customer fields in the UI. Facturx/ZUGFeRD, XRechnung and the
   inbox stay.
4. **Accounting export and multi-currency** — Xero/QuickBooks CSV export, the
   exchange-rate service/route/auto-fetch, the currency-breakdown report and
   all per-document currency pickers. `exchange_rate` columns stay in the
   schema with value 1 so aggregates keep working.
5. **Docs and config** — README, CLAUDE.md, docs site, `.env.example`,
   compose files no longer mention removed features.

## Rules while trimming

- Never drop tables or edit past migrations; unused tables are harmless.
- Every block ends green: `bun run typecheck`, Biome on touched files,
  `bun run test`. One commit per block, pushed to `origin/main`.
- Remove tests together with the feature they cover; never weaken a test to
  make a removal pass.
- Update `en.ts`/`de.ts` when keys become orphaned; `en.ts` stays the type
  source.
