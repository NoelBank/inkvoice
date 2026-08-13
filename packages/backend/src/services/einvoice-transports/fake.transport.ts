// In-memory fake transport, registered ONLY under NODE_ENV=test (and in demo
// mode). It records every call and answers from scripted responses, so the
// whole orchestrator can be exercised without any network. Tests script it via
// `resetFakeTransport()` and the `fakeTransportState` handle.

import type {
  EinvoiceTransport,
  ParticipantCapability,
  ParticipantId,
  RegisterParticipantRequest,
  RegistrationState,
  SendContext,
  SendReceipt,
  TransportWebhookRequest,
  TransportWebhookResult,
} from "./types";

export interface FakeTransportState {
  sent: SendContext[];
  lookups: ParticipantId[];
  registrations: RegisterParticipantRequest[];
  registrationRefs: string[];
  /** Scripted send receipt, returned by the next `send()`. */
  nextSendReceipt: SendReceipt | null;
  /** Scripted send error, thrown by the next `send()`. */
  nextSendError: Error | null;
  /** Scripted registration error, thrown by the next `registerParticipant()`. */
  nextRegisterError: Error | null;
  /** Scripted lookup result for every lookup. */
  capability: ParticipantCapability;
  /** Scripted registration result for every registerParticipant call. */
  registrationState: RegistrationState;
  /** Scripted parseWebhook result (set by tests to simulate inbound events). */
  nextWebhookResult: TransportWebhookResult | null;
}

const state: FakeTransportState = {
  sent: [],
  lookups: [],
  registrations: [],
  registrationRefs: [],
  nextSendReceipt: null,
  nextSendError: null,
  nextRegisterError: null,
  capability: {
    exists: true,
    documentTypes: ["invoice", "credit-note"],
    accessPointName: null,
    servedElsewhere: false,
  },
  registrationState: {
    providerRef: "fake-reg-1",
    status: "kyc_pending",
    actionUrl: null,
    detail: null,
  },
  nextWebhookResult: null,
};

export function resetFakeTransport(): void {
  state.sent = [];
  state.lookups = [];
  state.registrations = [];
  state.registrationRefs = [];
  state.nextSendReceipt = null;
  state.nextSendError = null;
  state.nextRegisterError = null;
  state.capability = {
    exists: true,
    documentTypes: ["invoice", "credit-note"],
    accessPointName: null,
    servedElsewhere: false,
  };
  state.registrationState = {
    providerRef: "fake-reg-1",
    status: "kyc_pending",
    actionUrl: null,
    detail: null,
  };
  state.nextWebhookResult = null;
}

/** Test handle: read recorded calls, script responses. */
export const fakeTransportState = state;

export const fakeTransport: EinvoiceTransport = {
  id: "fake",
  label: "Fake (test)",
  networks: ["test"],
  isConfigured: () => true,

  async send(ctx: SendContext): Promise<SendReceipt> {
    state.sent.push(ctx);
    if (state.nextSendError) throw state.nextSendError;
    if (state.nextSendReceipt) {
      const receipt = state.nextSendReceipt;
      state.nextSendReceipt = null;
      return receipt;
    }
    // Keyed on the transmission id, like the provider's idempotency key: the
    // same transmission always yields the same provider message id.
    return { providerMessageId: `fake-msg-${ctx.transmissionId}`, status: "sent" };
  },

  async lookupParticipant(id: ParticipantId): Promise<ParticipantCapability> {
    state.lookups.push(id);
    return { ...state.capability, documentTypes: [...state.capability.documentTypes] };
  },

  async registerParticipant(req: RegisterParticipantRequest): Promise<RegistrationState> {
    state.registrations.push(req);
    if (state.nextRegisterError) throw state.nextRegisterError;
    state.registrationRefs.push(state.registrationState.providerRef);
    return { ...state.registrationState, actionUrl: state.registrationState.actionUrl };
  },

  async getRegistration(providerRef: string): Promise<RegistrationState> {
    state.registrationRefs.push(providerRef);
    return { ...state.registrationState, providerRef };
  },

  async deregisterParticipant(providerRef: string): Promise<void> {
    state.registrationRefs.push(providerRef);
  },

  async parseWebhook(_req: TransportWebhookRequest): Promise<TransportWebhookResult> {
    if (!state.nextWebhookResult) return { kind: "ignored", eventId: "fake-ignored" };
    const result = state.nextWebhookResult;
    state.nextWebhookResult = null;
    return result;
  },
};
