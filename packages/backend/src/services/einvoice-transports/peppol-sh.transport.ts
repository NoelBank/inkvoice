// peppol.sh transport driver. Speaks the provider's HTTP API and knows
// nothing about invoices: it receives an already-generated document and
// returns receipts / normalised webhook results.
//
// HTTP contract (our side of the peppol.sh integration):
//
//   Auth:            Authorization: Bearer <PEPPOL_SH_API_KEY>
//   Send:            POST /v1/documents
//                    Headers: Idempotency-Key: <transmissionId>
//                    Body: { sender: {scheme, value}, receiver: {scheme, value},
//                           document_type, xml, hash, document_number }
//                    202 → { document: { id, status } }
//   Lookup:          GET /v1/participants/:scheme/:value
//                    → { exists, document_types: string[], access_point_name,
//                        served_elsewhere }
//   Register:        POST /v1/participants
//                    Body: { participant: {scheme, value}, legal_name,
//                           country_code, contact_email }
//                    → { registration: { id, status, action_url, detail } }
//   Registration:    GET  /v1/participants/registrations/:ref
//                    DELETE /v1/participants/registrations/:ref
//
//   Webhooks (HMAC over the RAW body; any re-serialisation breaks the
//   signature):
//     Headers: x-peppol-sh-signature  = hex(HMAC-SHA256(rawBody, secret))
//              x-peppol-sh-timestamp  = unix seconds (must be within 5 min)
//              x-peppol-sh-event-id   = provider event id (replay guard)
//     Payloads:
//       { type: "document.received", document: { id, sender: {scheme, value},
//           file_name, content_type, xml } }
//       { type: "document.status", document: { id, status: "delivered" | "rejected",
//           detail } }
//       { type: "participant.status", registration: { id, status, detail } }
//
// Endpoint paths are isolated below (one line each) so a provider API change
// is a one-file patch, and the fetch is injected for testability.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../utils/env";
import { logger } from "../../utils/logger";
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
  documents: () => "/v1/documents",
  participant: (scheme: string, value: string) => `/v1/participants/${scheme}/${value}`,
  participants: () => "/v1/participants",
  registration: (ref: string) => `/v1/participants/registrations/${ref}`,
};

interface PeppolShPayload {
  type?: string;
  document?: {
    id?: string;
    sender?: { scheme?: string; value?: string };
    file_name?: string;
    content_type?: string;
    xml?: string;
    status?: string;
    detail?: string | null;
  };
  registration?: { id?: string; status?: string; detail?: string | null };
}

export const peppolShTransport: EinvoiceTransport = {
  id: "peppol-sh",
  label: "peppol.sh",
  networks: ["PEPPOL"],

  isConfigured: () => !!getEnv().PEPPOL_SH_API_KEY,

  async send(ctx: SendContext): Promise<SendReceipt> {
    const res = await callApi("POST", endpoints.documents(), {
      idempotencyKey: ctx.transmissionId,
      body: {
        sender: ctx.sender,
        receiver: ctx.receiver,
        document_type: ctx.documentType,
        xml: ctx.xml,
        hash: ctx.hash,
        document_number: ctx.documentNumber,
      },
    });
    const document = (res.document ?? {}) as { id?: string; status?: string };
    if (!document.id) {
      throw new TransportHttpError(
        "Provider response missing document.id",
        res.status ?? 200,
        res.body,
      );
    }
    const status = normalizeStatus(document.status);
    if (status !== "sent") {
      logger.warn(
        { providerStatus: document.status, transmissionId: ctx.transmissionId },
        "Provider accepted document with a non-sent status",
      );
    }
    return { providerMessageId: document.id, status: "sent" };
  },

  async lookupParticipant(id: ParticipantId): Promise<ParticipantCapability> {
    const res = await callApi("GET", endpoints.participant(id.scheme, id.value));
    return {
      exists: !!res.exists,
      documentTypes: Array.isArray(res.document_types)
        ? res.document_types.map((t: unknown) => String(t))
        : [],
      accessPointName: res.access_point_name != null ? String(res.access_point_name) : null,
      servedElsewhere: !!res.served_elsewhere,
    };
  },

  async registerParticipant(req: RegisterParticipantRequest): Promise<RegistrationState> {
    const res = await callApi("POST", endpoints.participants(), {
      body: {
        participant: req.participant,
        legal_name: req.legalName,
        country_code: req.countryCode,
        contact_email: req.contactEmail,
      },
    });
    return parseRegistration(res.registration);
  },

  async getRegistration(providerRef: string): Promise<RegistrationState> {
    const res = await callApi("GET", endpoints.registration(providerRef));
    return parseRegistration(res.registration ?? { id: providerRef });
  },

  async deregisterParticipant(providerRef: string): Promise<void> {
    await callApi("DELETE", endpoints.registration(providerRef));
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
}

async function callApi(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: ApiCallOptions = {},
): Promise<Record<string, unknown> & { status?: number; body?: string }> {
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
    if (!res.ok) {
      throw new TransportHttpError(
        `peppol.sh ${method} ${path} failed (${res.status})`,
        res.status,
        text.slice(0, 4000),
      );
    }
    return { ...json, status: res.status, body: text.slice(0, 4000) };
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

function parseRegistration(raw: unknown): RegistrationState {
  const r = (raw ?? {}) as {
    id?: string;
    status?: string;
    action_url?: string | null;
    detail?: string | null;
  };
  if (!r.id) throw new TransportHttpError("Provider response missing registration.id", 200);
  return {
    providerRef: r.id,
    status: normalizeParticipantStatus(r.status),
    actionUrl: r.action_url ?? null,
    detail: r.detail ?? null,
  };
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
