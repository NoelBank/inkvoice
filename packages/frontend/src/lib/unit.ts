import type { TFunction } from "@/i18n";

const BUILTIN_UNIT_KEYS: Record<string, string> = {
  piece: "invoices.unit_piece",
  hour: "invoices.unit_hour",
  month: "invoices.unit_month",
  day: "invoices.unit_day",
  kg: "invoices.unit_kg",
  meter: "invoices.unit_meter",
  lump_sum: "invoices.unit_lump_sum",
};

/** Localize built-in units while preserving the names of custom units. */
export function formatUnitLabel(t: TFunction, unit: string | null | undefined): string {
  if (!unit) return "";
  const key = BUILTIN_UNIT_KEYS[unit];
  return key ? t(key) : unit;
}
