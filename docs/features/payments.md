# Online Payments

Accept payments directly from invoice links using **Stripe** or **PayPal**. Customers click a **Pay Now** button on their shared invoice page and complete payment through the gateway's hosted checkout.

You can enable either gateway or both. Each is configured with its own credentials (below) and turned on per workspace under **Settings → Payments** once its credentials are set. When more than one is enabled, the customer chooses which to pay with on the invoice page.

## Stripe

### 1. Create a Stripe Account

Sign up at [stripe.com](https://stripe.com) if you don't have an account.

### 2. Get Your API Keys

From the Stripe Dashboard, go to **Developers > API Keys** and copy:

- **Publishable key** (`pk_...`)
- **Secret key** (`sk_...`)

### 3. Configure Webhook

Create a webhook endpoint in the Stripe Dashboard:

- **URL**: `https://your-domain.com/api/v1/webhooks/stripe`
- **Events**: `checkout.session.completed`
- Copy the **Signing secret** (`whsec_...`)

### 4. Set Environment Variables

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## PayPal

### 1. Create a PayPal App

In the [PayPal Developer Dashboard](https://developer.paypal.com), create a REST app and copy its **Client ID** and **Secret**.

### 2. Configure Webhook

Add a webhook to the app:

- **URL**: `https://your-domain.com/api/v1/webhooks/paypal`
- **Event**: `CHECKOUT.ORDER.APPROVED`
- Copy the **Webhook ID** — Inkvoice uses it to verify webhook signatures

### 3. Set Environment Variables

```bash
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_ENV=live   # or "sandbox" (default) for testing
```

## How It Works

1. You publish an invoice and share the link with your customer
2. The customer opens the link and clicks **Pay Now** (choosing a gateway if more than one is enabled)
3. They're redirected to Stripe Checkout or PayPal to complete payment
4. On successful payment, the gateway's webhook marks the invoice as paid automatically
5. Both you and the customer see the updated status

## Payment Flow

```
Customer opens invoice link
  → Clicks "Pay Now"
  → Stripe / PayPal checkout created
  → Customer completes payment on the gateway
  → Gateway sends webhook to Inkvoice
  → Invoice marked as paid
  → Customer redirected back to the invoice
```

## Partial Payments

Online payments through the public invoice link always pay the full outstanding amount. For partial payments, use the **Record Payment** action from the invoice detail page in the admin UI.

## Testing

- **Stripe** — use test-mode keys (`sk_test_...`, `pk_test_...`) and Stripe's [test card numbers](https://stripe.com/docs/testing#cards).
- **PayPal** — leave `PAYPAL_ENV=sandbox` and use sandbox app credentials with a [sandbox test account](https://developer.paypal.com/tools/sandbox/accounts/) to simulate payments.
