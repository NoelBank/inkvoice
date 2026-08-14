import { getEnv } from "../../utils/env";
import { getSetting } from "../settings.service";
import { fakeTransport } from "./fake.transport";
import { peppolShTransport } from "./peppol-sh.transport";
import type { EinvoiceTransport } from "./types";

// All transports, in the order they should appear in Settings. The fake
// driver is only available under test / demo so a real install never offers
// "send into the void" as a choice.
const REGISTERED: EinvoiceTransport[] = [];

function baseTransports(): EinvoiceTransport[] {
  const list: EinvoiceTransport[] = [peppolShTransport];
  if (process.env.NODE_ENV === "test" || getEnv().DEMO_MODE) {
    list.push(fakeTransport);
  }
  return [...list, ...REGISTERED];
}

// Extension point: the cloud overlay registers its managed driver here (same
// trick as registerSettingsTab) so the OSS app never needs to know it exists.
export function registerTransport(t: EinvoiceTransport): void {
  const i = REGISTERED.findIndex((x) => x.id === t.id);
  if (i >= 0) REGISTERED.splice(i, 1);
  REGISTERED.push(t);
}

export function listTransports(): EinvoiceTransport[] {
  return baseTransports();
}

/** The transport selected in Settings, if it is configured and PEPPOL is on. */
export function getActiveTransport(): EinvoiceTransport | null {
  if (getSetting("peppol_enabled") !== "true") return null;
  const id = getSetting("peppol_transport") ?? "peppol-sh";
  const t = baseTransports().find((x) => x.id === id);
  return t?.isConfigured() ? t : null;
}

/** The transport selected in Settings for the France network, if enabled. */
export function getFranceTransport(): EinvoiceTransport | null {
  if (getSetting("france_enabled") !== "true") return null;
  const id = getSetting("france_transport") ?? "qonto-fr";
  const t = baseTransports().find((x) => x.id === id);
  return t?.isConfigured() ? t : null;
}

/** Every enabled + configured transport across networks (worker + webhooks). */
export function listEnabledTransports(): EinvoiceTransport[] {
  return [getActiveTransport(), getFranceTransport()].filter(
    (t): t is EinvoiceTransport => t !== null,
  );
}
