# Customers

Manage your client directory. Each customer stores contact information and billing details used when creating invoices and quotes.

## Customer Fields

| Field | Description |
|-------|-------------|
| **Name** | Company or individual name (required) |
| **Email** | Used for sending invoices |
| **Phone** | Contact phone number |
| **Address** | Street address (line 1 and line 2) |
| **City / State / Postal Code** | Billing address |
| **Country** | ISO country code |
| **Tax ID** | VAT or GST registration number |
| **E-invoice format** | Per-customer e-invoice format override (visible when the E-Rechnung module is enabled) |
| **Tax number (Steuernummer)** | German customer's tax number, used as buyer tax number in e-invoices |
| **Leitweg-ID** | Official ID for public-sector (B2G) customers; forces XRechnung |
| **Receiver ID / scheme** | E-invoice receiver identifier (XRechnung/PEPPOL), e.g. `DE:VAT`, `0204` |
| **Notes** | Internal notes about the customer |

> E-invoice fields only appear in the form when the **E-Rechnung module** is enabled in Settings. See [E-Invoicing (E-Rechnung)](/features/e-invoicing).

## Customer Detail View

Clicking a customer shows:

- Their full contact information
- A summary of their invoice history (total invoiced, total paid, outstanding balance)
- A list of all associated invoices

## Batch Operations

Select multiple customers for bulk deletion. Customers with existing invoices cannot be deleted — remove or reassign their invoices first.

## CSV Export

Export your full customer list as a CSV file.
