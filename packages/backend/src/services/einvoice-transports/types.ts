// Provider-agnostic e-invoice transport abstraction.
//
// Each network provider (peppol.sh, a managed cloud account, later a French
// PDP or Polish KSeF gateway) implements `EinvoiceTransport`. The transport
// service hands it the already-generated document (archived XML plus the
// structured invoice data it was built from) and never inspects how it
// travels, so the rest of the app is unaware of which network carried a given
// invoice.

import type { XmlInvoiceData } from "../../xml/types";

/** Scheme + value identifying a business on the network (EAS/ISO 6523). */
export interface ParticipantId {
  /** EAS scheme code, e.g. "0208" (BE company no.), "9930" (DE VAT), "0088" (GLN). */
  scheme: string;
  /** Identifier value, normalised (no spaces, upper-cased). */
  value: string;
}

/** One outbound document handed to a transport. */
export interface SendContext {
  /** einvoice_transmissions.id — stable across retries, used as the provider idempotency key. */
  transmissionId: string;
  sender: ParticipantId;
  receiver: ParticipantId;
  /** "invoice" | "credit-note". Maps to UBL Invoice / CreditNote. */
  documentType: EinvoiceDocumentType;
  /** The exact XML stored in einvoice_documents.xml_content. */
  xml: string;
  /** SHA-256 of `xml`, for provider-side dedupe where supported. */
  hash: string;
  /** Human-facing reference shown in provider dashboards. */
  documentNumber: string;
  /** Structured invoice data the XML was built from (JSON-in providers). */
  data: XmlInvoiceData;
}

export type EinvoiceDocumentType = "invoice" | "credit-note";

export interface SendReceipt {
  /** Provider's document id. Stored so later status callbacks can be correlated. */
  providerMessageId: string;
  /** Provider's own view at accept time. Usually "sent". */
  status: TransmissionStatus;
}

export type TransmissionStatus =
  | "queued" // ours: row exists, not yet handed over
  | "sending" // ours: in flight
  | "sent" // provider accepted, network delivery pending
  | "delivered" // positive MLR / receiver AP confirmed
  | "rejected" // negative MLR / receiver refused the document
  | "failed"; // transport failure, retries exhausted

/** What the network knows about a participant right now. */
export interface ParticipantCapability {
  exists: boolean;
  /** Document type identifiers the receiver accepts. */
  documentTypes: string[];
  /** Access point currently serving this participant, when the provider exposes it. */
  accessPointName: string | null;
  /** True when that access point is not the one we are configured to use. */
  servedElsewhere: boolean;
}

export interface RegisterParticipantRequest {
  participant: ParticipantId;
  legalName: string;
  countryCode: string;
  contactEmail: string;
}

export interface RegistrationState {
  /** Provider's registration handle. Persisted in peppol_participants.provider_ref. */
  providerRef: string;
  status: ParticipantStatus;
  /** Where to send the user to complete KYC, when the provider hosts that step. */
  actionUrl: string | null;
  /** Human-readable reason for "conflict" or "rejected". */
  detail: string | null;
}

export type ParticipantStatus =
  | "kyc_pending" // created, awaiting the business's approval
  | "active" // published in the SMP, receiving
  | "conflict" // already registered by another access point
  | "rejected" // provider declined
  | "suspended"
  | "deregistered";

/** A raw inbound webhook, normalised so drivers verify it themselves. */
export interface TransportWebhookRequest {
  rawBody: string;
  headers: Record<string, string>;
}

/** Normalised result of one inbound webhook, interpreted by the service. */
export type TransportWebhookResult =
  | { kind: "ignored"; eventId: string }
  | {
      kind: "document";
      eventId: string;
      providerMessageId: string;
      sender: ParticipantId;
      fileName: string;
      contentType: string;
      xml: string;
    }
  | {
      kind: "status";
      eventId: string;
      providerMessageId: string;
      status: TransmissionStatus;
      detail: string | null;
    }
  | {
      kind: "participant";
      eventId: string;
      providerRef: string;
      status: ParticipantStatus;
      detail: string | null;
    };

export interface EinvoiceTransport {
  /** Stable id, also the settings-key prefix and the driver selector. */
  readonly id: string;
  /** Human-readable name shown in Settings. */
  readonly label: string;
  /** Networks this driver reaches, for UI copy. */
  readonly networks: readonly string[];
  /** True when credentials are present in the environment (or the overlay). */
  isConfigured(): boolean;

  send(ctx: SendContext): Promise<SendReceipt>;
  lookupParticipant(id: ParticipantId): Promise<ParticipantCapability>;
  registerParticipant(req: RegisterParticipantRequest): Promise<RegistrationState>;
  getRegistration(providerRef: string): Promise<RegistrationState>;
  deregisterParticipant(providerRef: string): Promise<void>;
  /** Verify and normalise an inbound callback. Throws on bad signature. */
  parseWebhook(req: TransportWebhookRequest): Promise<TransportWebhookResult>;
}

/**
 * Error thrown by drivers for provider HTTP failures. The `statusCode` lets
 * the orchestrator classify retryability (4xx other than 408/429 is permanent)
 * without knowing anything about the provider.
 */
export class TransportHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly responseBody: string | null = null,
  ) {
    super(message);
    this.name = "TransportHttpError";
  }

  /** True when a retry could plausibly succeed (network-ish or throttled). */
  isRetryable(): boolean {
    if (this.statusCode === null) return true; // network error / timeout
    return this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500;
  }
}
