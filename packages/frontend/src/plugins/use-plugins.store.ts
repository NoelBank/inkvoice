// Per-tenant plugin enablement state. Backed by GET/PUT /api/v1/plugins. Drives
// the nav-visibility gate, the PluginGuard route wrapper, and the admin Plugins
// settings tab. Fetched lazily once the authenticated shell mounts.

import { create } from "zustand";
import { pluginFetch } from "./api";

interface CatalogEntry {
  id: string;
  feature: string | null;
  enabled: boolean;
}

interface PluginsState {
  enabled: string[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Fetch once; no-op if already loaded or in flight. */
  ensureFetched: () => void;
  refresh: () => Promise<void>;
  isEnabled: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  enabled: [],
  loaded: false,
  loading: false,
  error: null,

  ensureFetched: () => {
    const s = get();
    if (s.loaded || s.loading) return;
    void s.refresh();
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const res = await pluginFetch<{ data: { plugins: CatalogEntry[]; enabled: string[] } }>(
        "/plugins",
      );
      set({ enabled: res.data.enabled, loaded: true, loading: false, error: null });
    } catch (err) {
      // Mark loaded even on failure so guards resolve (deny) instead of spinning.
      set({ loading: false, loaded: true, error: (err as Error).message });
    }
  },

  isEnabled: (id) => get().enabled.includes(id),

  setEnabled: async (id, enabled) => {
    const res = await pluginFetch<{ data: { enabled: string[] } }>(`/plugins/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    set({ enabled: res.data.enabled });
  },
}));
