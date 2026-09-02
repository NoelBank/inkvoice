import { type Capabilities, deriveCapabilities } from "@/lib/capabilities";
import { useSettingsStore } from "@/stores/settings.store";

export function useCapabilities(): Capabilities {
  return useSettingsStore((s) => deriveCapabilities(s.settings));
}
