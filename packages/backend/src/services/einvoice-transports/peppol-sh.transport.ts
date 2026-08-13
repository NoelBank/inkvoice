// peppol.sh transport driver. Speaks the provider's HTTP API and knows
// nothing about invoices: it receives the structured invoice data (the same
// model the archived UBL XML is built from) and returns receipts / normalised
// webhook results.
//
// HTTP contract (our side of the peppol.sh v1 API, api.peppol.sh/v1/openapi.json):
//
//   Auth:            Authorization: Bearer <PEPPOL_SH_API_KEY>
//   Provision:       POST /v1/companies  → 201 { id, name, tax_id, country }
//                    (lazy: once per install, id cached in the `peppol_company_id`
//                    setting; the caller's company must be KYC'd in the
//                    peppol.sh dashboard before it can send)
//   Send:            POST /v1/documents
//                    Body: { company_id, idempotency_key, type, number,
//                           issue_date, due_date, currency, from: Party,
//                           to: Party, lines: LineItem[], note }
//                    200 → { id, status: "queued"|"sending"|"delivered"|"failed" }
//   Lookup:          GET /v1/lookup/{scheme}:{value}?domain=sml|smk
//                    200 → { participant_id, services: [{ document_type_id, ... }] }
//                    404 → participant not on the network (exists: false)
//   Registration:    NOT exposed by the provider API. peppol.sh registers its
//                    own companies (KYC in the dashboard); the transport throws.
//
//   Webhooks (HMAC over the RAW body; any re-serialisation breaks the
//   signature):
//     Headers: x-peppol-sh-signature  = hex(HMAC-SHA256(rawBody, secret))
//              x-peppol-sh-timestamp  = unix seconds (must be within 5 min)
//              x-peppol-sh-event-id   = provider event id (replay guard)
//     Payload (event object, shape of GET /v1/events):
//       { type: "delivered"|"failed"|"queued"|"sending"|"retry",
//         document_id, document_number, message, ... }
//       "delivered" → status delivered; "failed" → rejected (detail = message);
//       the rest are ignored.
//     Legacy payload shapes (document.received / document.status /
//     participant.status) are still parsed for the inbound-receive path.
//
// Endpoint paths are isolated below (one line each) so a provider API change
// is a one-file patch, and the fetch is injected for testability.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../utils/env";
import { logger } from "../../utils/logger";
import { getSetting, updateSettings } from "../settings.service";
import {
  type EinvoiceTransport,
  type ParticipantCapability,
  type ParticipantId,
  type ParticipantStatus,
  type RegisterParticipantRequest,
  type RegistrationState,
  type SendContext,
  type SendReceipt,
  type TransmissionStatus,
  TransportHttpError,
  type TransportWebhookRequest,
  type TransportWebhookResult,
} from "./types";

export const PEPPOL_SH_DEFAULT_BASE_URL = "https://api.peppol.sh";
/** Webhook timestamps older/newer than this are rejected (replay guard). */
const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// The provider's raw JSON keys are documented above; the mapping functions at
// the bottom of this file own the shape-to-type translation.
const endpoints = {
  companies: () => "/v1/companies",
  documents: () => "/v1/documents",
  lookup: (scheme: string, value: string, domain: string) =>
    `/v1/lookup/${encodeURIComponent(scheme)}:${encodeURIComponent(value)}?domain=${domain}`,
};

interface PeppolShPayload {
  type?: string;
  /** Current event shape (GET /v1/events): delivered/failed/queued/sending/retry. */
  document_id?: string;
  message?: string | null;
  /** Legacy inbound-document shape (document.received). */
  document?: {
    id?: string;
    sender?: { scheme?: string; value?: string };
    file_name?: string;
    content_type?: string;
    xml?: string;
    status?: string;
    detail?: string | null;
  };
  /** Legacy registration shape (participant.status). */
  registration?: { id?: string; status?: string; detail?: string | null };
}

export const peppolShTransport: EinvoiceTransport = {
  id: "peppol-sh",
  label: "peppol.sh",
  networks: ["PEPPOL"],

  isConfigured: () => !!getEnv().PEPPOL_SH_API_KEY,

  async send(ctx: SendContext): Promise<SendReceipt> {
    const companyId = await ensureCompanyId(ctx);
    const res = await callApi("POST", endpoints.documents(), {
      body: buildDocumentBody(ctx, companyId),
    });
    // The spec returns the Document object directly; tolerate a wrapped
    // { document: ... } as a compat fallback.
    const document = (res.document ?? res) as { id?: string; status?: string };
    if (!document.id) {
      throw new TransportHttpError(
        "Provider response missing document.id",
        res.httpStatus ?? 200,
        res.body,
      );
    }
    const status = normalizeSendStatus(document.status);
    if (status !== "sent") {
      logger.warn(
        { providerStatus: document.status, transmissionId: ctx.transmissionId },
        "Provider accepted document with a non-sent status",
      );
    }
    return { providerMessageId: document.id, status };
  },

  async lookupParticipant(id: ParticipantId): Promise<ParticipantCapability> {
    const res = await callApi("GET", endpoints.lookup(id.scheme, id.value, lookupDomain()), {
      notFoundOk: true,
    });
    if (res.httpStatus === 404) {
      return { exists: false, documentTypes: [], accessPointName: null, servedElsewhere: false };
    }
    const services = Array.isArray(res.services)
      ? (res.services as Array<Record<string, unknown>>)
      : [];
    const documentTypes = services
      .map((s) => mapDocumentType(s.document_type_id, s.document_type_name))
      .filter((t): t is "invoice" | "credit-note" => t !== null);
    return {
      exists: true,
      documentTypes: [...new Set(documentTypes)],
      accessPointName: null,
      servedElsewhere: false,
    };
  },

  async registerParticipant(_req: RegisterParticipantRequest): Promise<RegistrationState> {
    throw notSupported();
  },

  async getRegistration(): Promise<RegistrationState> {
    throw notSupported();
  },

  async deregisterParticipant(): Promise<void> {
    throw notSupported();
  },

  async parseWebhook(req: TransportWebhookRequest): Promise<TransportWebhookResult> {
    const secret = getEnv().PEPPOL_SH_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("PEPPOL_SH_WEBHOOK_SECRET is not configured");
    }

    const headers = lowercaseHeaders(req.headers);
    const signature = headers["x-peppol-sh-signature"];
    const timestamp = headers["x-peppol-sh-timestamp"];
    const eventId = headers["x-peppol-sh-event-id"];
    if (!signature || !timestamp || !eventId) {
      throw new Error("Missing webhook signature headers");
    }

    // Constant-time compare over the raw body. A re-serialised body would
    // silently fail here, which is why the route hands us the raw text.
    const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
    if (!constantTimeEqualHex(expected, signature)) {
      throw new Error("Invalid webhook signature");
    }

    const ts = Number.parseInt(timestamp, 10);
    if (
      !Number.isFinite(ts) ||
      Math.abs(Date.now() / 1000 - ts) * 1000 > WEBHOOK_TIMESTAMP_WINDOW_MS
    ) {
      throw new Error("Webhook timestamp outside the 5-minute window");
    }

    let payload: PeppolShPayload;
    try {
      payload = JSON.parse(req.rawBody) as PeppolShPayload;
    } catch {
      throw new Error("Webhook body is not valid JSON");
    }

    // Current event payloads: document.delivered / document.failed.
    if (payload.document_id) {
      if (payload.type === "delivered") {
        return {
          kind: "status",
          eventId,
          providerMessageId: payload.document_id,
          status: "delivered",
          detail: payload.message ?? null,
        };
      }
      if (payload.type === "failed") {
        return {
          kind: "status",
          eventId,
          providerMessageId: payload.document_id,
          status: "rejected",
          detail: payload.message ?? null,
        };
      }
      return { kind: "ignored", eventId }; // queued / sending / retry
    }

    // Legacy inbound-document shape (document.received) — receive path.
    if (payload.type === "document.received" && payload.document?.id) {
      return {
        kind: "document",
        eventId,
        providerMessageId: payload.document.id,
        sender: {
          scheme: payload.document.sender?.scheme ?? "",
          value: payload.document.sender?.value ?? "",
        },
        fileName: payload.document.file_name ?? "einvoice.xml",
        contentType: payload.document.content_type ?? "application/xml",
        xml: payload.document.xml ?? "",
      };
    }
    // Legacy delivery-status shape (document.status).
    if (payload.type === "document.status" && payload.document?.id) {
      const status = normalizeStatus(payload.document.status);
      if (status !== "delivered" && status !== "rejected") {
        return { kind: "ignored", eventId };
      }
      return {
        kind: "status",
        eventId,
        providerMessageId: payload.document.id,
        status,
        detail: payload.document.detail ?? null,
      };
    }
    if (payload.type === "participant.status" && payload.registration?.id) {
      return {
        kind: "participant",
        eventId,
        providerRef: payload.registration.id,
        status: normalizeParticipantStatus(payload.registration.status),
        detail: payload.registration.detail ?? null,
      };
    }

    logger.debug({ type: payload.type }, "Ignoring unknown peppol.sh webhook type");
    return { kind: "ignored", eventId };
  },
};

// ---------- helpers ----------

interface ApiCallOptions {
  idempotencyKey?: string;
  body?: unknown;
  /** 404 → return { status: 404 } instead of throwing (lookup miss). */
  notFoundOk?: boolean;
}

async function callApi(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: ApiCallOptions = {},
): Promise<Record<string, unknown> & { httpStatus?: number; body?: string }> {
  const env = getEnv();
  const base = env.PEPPOL_SH_BASE_URL.replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.PEPPOL_SH_API_KEY}`,
    Accept: "application/json",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!res.ok && !(opts.notFoundOk && res.status === 404)) {
      throw new TransportHttpError(
        `peppol.sh ${method} ${path} failed (${res.status})`,
        res.status,
        text.slice(0, 4000),
      );
    }
    return { ...json, httpStatus: res.status, body: text.slice(0, 4000) };
  } catch (err) {
    if (err instanceof TransportHttpError) throw err;
    // fetch threw: network failure or timeout. No status code → retryable.
    throw new TransportHttpError(
      err instanceof Error ? err.message : "Network error calling peppol.sh",
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The sender company's provider-side id, provisioning it once per install. */
async function ensureCompanyId(ctx: SendContext): Promise<string> {
  const cached = getSetting("peppol_company_id");
  if (cached) return cached;

  const supplier = ctx.data.supplier;
  const res = await callApi("POST", endpoints.companies(), {
    body: {
      name: supplier.name || "Inkvoice",
      tax_id: supplier.tax_id ?? undefined,
      country: supplier.country ?? undefined,
      address:
        supplier.city || supplier.street
          ? {
              street: supplier.street ?? undefined,
              city: supplier.city ?? undefined,
              postal_code: supplier.postal_code ?? undefined,
            }
          : undefined,
    },
  });
  const companyId = typeof res.id === "string" ? res.id : null;
  if (!companyId) {
    throw new TransportHttpError(
      "Provider response missing company.id",
      res.httpStatus ?? 200,
      res.body,
    );
  }
  updateSettings({ peppol_company_id: companyId });
  logger.info({ companyId }, "Provisioned peppol.sh company");
  return companyId;
}

/** DocumentCreate body for POST /v1/documents (JSON-in; the provider builds UBL). */
function buildDocumentBody(ctx: SendContext, companyId: string): Record<string, unknown> {
  const d = ctx.data;
  return {
    company_id: companyId,
    idempotency_key: ctx.transmissionId,
    type: ctx.documentType === "credit-note" ? "credit_note" : "invoice",
    number: d.invoice_number,
    issue_date: d.issue_date,
    due_date: d.due_date ?? undefined,
    currency: d.currency || "EUR",
    from: {
      name: d.supplier.name,
      tax_id: d.supplier.tax_id ?? d.supplier.tax_number ?? undefined,
      peppol_id: `${ctx.sender.scheme}:${ctx.sender.value}`,
      address:
        d.supplier.city || d.supplier.street
          ? {
              street: d.supplier.street ?? undefined,
              city: d.supplier.city ?? undefined,
              postal_code: d.supplier.postal_code ?? undefined,
            }
          : undefined,
      email: d.supplier.email ?? undefined,
    },
    to: {
      name: d.customer.name,
      tax_id: d.customer.tax_id ?? d.customer.tax_number ?? undefined,
      peppol_id: `${ctx.receiver.scheme}:${ctx.receiver.value}`,
      address:
        d.customer.city || d.customer.address_line1
          ? {
              street: d.customer.address_line1 ?? undefined,
              city: d.customer.city ?? undefined,
              postal_code: d.customer.postal_code ?? undefined,
            }
          : undefined,
      email: d.customer.email ?? undefined,
    },
    lines: d.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: mapUnitCode(i.unit),
      unit_price: i.unit_price,
      tax_rate: i.tax_rate,
    })),
    note: d.notes ?? undefined,
  };
}

/** Which SMP domain to query: smk (test) or sml (production). */
function lookupDomain(): string {
  return getSetting("peppol_environment") === "test" ? "smk" : "sml";
}

/** Map the provider's full document-type ids to our vocabulary. */
function mapDocumentType(id: unknown, name: unknown): "invoice" | "credit-note" | null {
  const haystack = `${String(id ?? "")} ${String(name ?? "")}`.toLowerCase();
  if (haystack.includes("credit")) return "credit-note";
  if (haystack.includes("invoice")) return "invoice";
  return null;
}

function mapUnitCode(unit: string): string {
  const map: Record<string, string> = {
    piece: "C62",
    hour: "HUR",
    day: "DAY",
    kg: "KGM",
    meter: "MTR",
    lump_sum: "LS",
    month: "MON",
  };
  return map[unit] || "C62";
}

function normalizeSendStatus(raw: string | undefined): TransmissionStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "failed") return "failed";
  return "sent"; // queued / sending / sent → accepted, delivery pending
}

function normalizeStatus(raw: string | undefined): TransmissionStatus {
  const s = (raw ?? "").toLowerCase();
  if (["sent", "delivered", "rejected"].includes(s)) return s as TransmissionStatus;
  return "sent";
}

function normalizeParticipantStatus(raw: string | undefined): ParticipantStatus {
  const s = (raw ?? "").toLowerCase();
  if (["kyc_pending", "active", "conflict", "rejected", "suspended", "deregistered"].includes(s)) {
    return s as ParticipantStatus;
  }
  return "kyc_pending";
}

function notSupported(): TransportHttpError {
  return new TransportHttpError(
    "peppol.sh no longer exposes participant registration through its API; register the company's participant in the peppol.sh dashboard.",
    404,
  );
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
