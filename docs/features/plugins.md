# Plugins

Inkvoice ships optional features as **plugins**: statically compiled-in,
official modules an admin can enable or disable under **Settings → Plugins**.
Time Tracking is the first official plugin.

## Managing plugins

- Open **Settings → Plugins** (admin only). Each plugin lists its name,
  description, and an Enable/Disable toggle.
- Disabling a plugin hides its sidebar entry and its pages, and its API
  answers 404. Its data is kept; re-enabling restores everything.
- Plugins are on or off per install. Nothing is downloaded at runtime.

## Time Tracking

Track time against projects and turn unbilled hours into draft invoices.

- **Projects** group time by client work. A project can be linked to a
  customer with a default hourly rate. Project management is admin-only.
- **Timer**: start/stop a personal timer from the Time Tracking page. One
  running timer per user.
- **Entries**: manual or timer-captured time with duration, rate, and
  billable flag. Non-admin users see and edit only their own entries;
  admins see and manage all entries.
- **Summary**: per-project totals (total, billable, unbilled time and value).
- **Invoice from unbilled time**: pick a customer and date range to create a
  draft invoice from unbilled billable time (one line per project and rate).
  Requires invoice creation permission. Entries are marked billed and linked
  to the invoice.

## API

Plugin endpoints live under `/api/v1/plugins/<plugin-id>/...` and require
authentication (session JWT or API token). Notes for integrators:

- `GET /api/v1/plugins` lists the catalog with per-install enablement.
- `PUT /api/v1/plugins/:id` toggles a plugin (admin only).
- Scoped API tokens (tokens with an explicit scope list) are limited to the
  invoicing resources and cannot access plugin paths. Unscoped API tokens act
  as their owner and can access plugin endpoints.
