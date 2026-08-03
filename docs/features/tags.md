# Tags

Free-form tags help you organize invoices and customers, then filter and search the lists by tag.

## Adding Tags

- In the **invoice form**, the **customer form**, and on the **invoice detail page**, a chip-based tag editor lets you type tags and press **Enter** (or **comma**) to add them, and click the **×** to remove one.
- Tags are shared globally: typing a tag that already exists attaches the same tag (case-insensitive) rather than creating a duplicate.
- Existing tags appear as suggestions while you type, so reuse is one click.

## Filtering

- The **Invoices** and **Customers** list pages each have a tag filter box.
- Filtering by multiple tags matches items carrying **any** of them (e.g. `urgent,international` shows everything tagged with either).
- Matching is case-insensitive and ignores extra whitespace.

## API

- `GET /api/v1/tags` — all tags with usage counts (for filter suggestions).
- `PUT /api/v1/invoices/:id/tags` — replace an invoice's tags (full replace; allowed on any status).
- `PUT /api/v1/customers/:id/tags` — replace a customer's tags.
- `GET /api/v1/invoices?tags=a,b` and `GET /api/v1/customers?tags=a,b` — filter lists by tag.
- Invoice and customer create/update payloads also accept an optional `tags: string[]` field.
- Invoice and customer CSV exports honor the `tags` filter when exported from a filtered list.

## Notes

- Deleting an item clears its tag links; tags no longer used by anything are pruned automatically.
- Duplicating an invoice copies its tags to the new draft.
