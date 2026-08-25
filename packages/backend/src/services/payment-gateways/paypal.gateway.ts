import { todayIso } from "../../utils/date";
import { getEnv } from "../../utils/env";
import { recordPayment } from "../payment.service";
import { invoiceLabel, paypalLocale } from "./strings";
import type { CheckoutContext, PaymentGateway, WebhookRequest, WebhookResult } from "./types";

// PayPal integration via the Orders v2 API. The flow mirrors Stripe Checkout:
//   1. createCheckout() creates an order and returns its `approve` link.
//   2. The payer approves on PayPal and is redirected back to the invoice.
//   3. PayPal fires a CHECKOUT.ORDER.APPROVED webhook; handleWebhook() verifies
//      it, captures the order, and records the payment.
// Capturing inside the webhook keeps confirmation server-side and is naturally
// idempotent — a retried webhook hits "order already captured" and records
// nothing further.

// --- Pure helpers (no network; unit-tested) -------------------------------

export function paypalBaseUrl(environment: string): string {
  return environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** PayPal requires amounts as a string with exactly two decimal places. */
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

/**
 * PayPal caps soft_descriptor at 22 characters and rejects the order outright
 * if it is longer, so this trims rather than risking a failed checkout.
 */
export function softDescriptor(invoiceNumber: string): string {
  return invoiceNumber.replace(/[^A-Za-z0-9 .-]/g, "").slice(0, 22);
}

export function buildOrderBody(ctx: CheckoutContext) {
  // What the payer sees on the PayPal page. Without it they get a bare amount
  // and the merchant name, with no way to tell which invoice they're settling.
  const description = invoiceLabel(ctx.locale, ctx.invoiceNumber);
  const descriptor = softDescriptor(ctx.invoiceNumber);
  const locale = paypalLocale(ctx.locale);

  return {
    intent: "CAPTURE" as const,
    purchase_units: [
      {
        // reference_id carries the invoice id; the webhook reads it back to
        // find the invoice. Do not repurpose it.
        reference_id: ctx.invoiceId,
        custom_id: ctx.shareToken,
        // PayPal truncates at 127 characters.
        description: description.slice(0, 127),
        ...(descriptor ? { soft_descriptor: descriptor } : {}),
        amount: {
          currency_code: ctx.currency.toUpperCase(),
          value: formatAmount(ctx.amount),
        },
      },
    ],
    application_context: {
      // Otherwise PayPal shows the raw PayPal account name as the payee.
      ...(ctx.businessName ? { brand_name: ctx.businessName.slice(0, 127) } : {}),
      // Omitted for languages we have no wording for, so PayPal keeps its own
      // detection rather than being pinned to something wrong.
      ...(locale ? { locale } : {}),
      return_url: ctx.successUrl,
      cancel_url: ctx.cancelUrl,
      user_action: "PAY_NOW" as const,
      shipping_preference: "NO_SHIPPING" as const,
    },
  };
}

export function extractApproveUrl(order: { links?: Array<{ rel: string; href: string }> }): string {
  const link = order.links?.find((l) => l.rel === "approve");
  if (!link) throw new Error("PayPal order has no approval link");
  return link.href;
}

/** The invoice id is carried in the order's purchase_unit reference_id. */
export function extractInvoiceId(event: {
  resource?: { purchase_units?: Array<{ reference_id?: string }> };
}): string | null {
  return event.resource?.purchase_units?.[0]?.reference_id ?? null;
}

export function extractCapture(captureResponse: {
  purchase_units?: Array<{
    payments?: { captures?: Array<{ id: string; amount: { value: string } }> };
  }>;
}): { amount: number; captureId: string } | null {
  const capture = captureResponse.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) return null;
  return { amount: Number.parseFloat(capture.amount.value), captureId: capture.id };
}

export function isAlreadyCaptured(errorBody: { details?: Array<{ issue?: string }> }): boolean {
  return (errorBody.details ?? []).some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
}

// --- Networked PayPal client ----------------------------------------------

async function getAccessToken(): Promise<string> {
  const env = getEnv();
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
  const res = await fetch(`${paypalBaseUrl(env.PAYPAL_ENV)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function paypalFetch(
  path: string,
  token: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const env = getEnv();
  const res = await fetch(`${paypalBaseUrl(env.PAYPAL_ENV)}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function verifyWebhookSignature(
  headers: Record<string, string>,
  event: unknown,
  token: string,
): Promise<boolean> {
  const env = getEnv();
  const { ok, data } = await paypalFetch("/v1/notifications/verify-webhook-signature", token, {
    transmission_id: headers["paypal-transmission-id"],
    transmission_time: headers["paypal-transmission-time"],
    cert_url: headers["paypal-cert-url"],
    auth_algo: headers["paypal-auth-algo"],
    transmission_sig: headers["paypal-transmission-sig"],
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return ok && data.verification_status === "SUCCESS";
}

// --- Gateway implementation -----------------------------------------------

export const paypalGateway: PaymentGateway = {
  id: "paypal",
  label: "PayPal",

  isConfigured(): boolean {
    const env = getEnv();
    return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET && env.PAYPAL_WEBHOOK_ID);
  },

  async createCheckout(ctx: CheckoutContext): Promise<{ url: string }> {
    const token = await getAccessToken();
    const { ok, status, data } = await paypalFetch(
      "/v2/checkout/orders",
      token,
      buildOrderBody(ctx),
    );
    if (!ok) throw new Error(`PayPal order creation failed (${status})`);
    return { url: extractApproveUrl(data) };
  },

  async handleWebhook({ rawBody, headers }: WebhookRequest): Promise<WebhookResult> {
    const event = JSON.parse(rawBody) as {
      event_type?: string;
      resource?: { id?: string; purchase_units?: Array<{ reference_id?: string }> };
    };

    if (event.event_type !== "CHECKOUT.ORDER.APPROVED") {
      return { handled: false, recorded: false };
    }

    const token = await getAccessToken();
    const verified = await verifyWebhookSignature(headers, event, token);
    if (!verified) throw new Error("PayPal webhook signature verification failed");

    const invoiceId = extractInvoiceId(event);
    const orderId = event.resource?.id;
    if (!invoiceId || !orderId) return { handled: true, recorded: false };

    const capture = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, token);
    if (!capture.ok) {
      // A retried webhook for an already-captured order is expected — no-op.
      if (isAlreadyCaptured(capture.data)) return { handled: true, recorded: false };
      throw new Error(`PayPal capture failed (${capture.status})`);
    }

    const result = extractCapture(capture.data);
    if (!result) return { handled: true, recorded: false };

    recordPayment(invoiceId, {
      amount: result.amount,
      payment_date: todayIso(),
      method: "card",
      reference: result.captureId,
      notes: "Paid via PayPal",
    });
    return { handled: true, recorded: true };
  },
};
