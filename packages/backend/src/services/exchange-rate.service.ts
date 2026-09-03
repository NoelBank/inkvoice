import { getSetting } from "./settings.service";

/**
 * The currency this install bills in. Reporting consolidates on it; documents
 * store an exchange_rate of 1 alongside their amounts, which keeps the
 * aggregate queries unchanged.
 */
export function getBaseCurrency(): string {
  return getSetting("base_currency") || getSetting("currency") || "EUR";
}
