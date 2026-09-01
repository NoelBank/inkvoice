// Route wrapper that blocks a plugin's pages when the plugin is disabled for
// the tenant. Plugin routes register their element wrapped in this guard.

import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { usePluginsStore } from "./use-plugins.store";

export function PluginGuard({ pluginId, children }: { pluginId: string; children: ReactNode }) {
  const loaded = usePluginsStore((s) => s.loaded);
  const enabled = usePluginsStore((s) => s.enabled);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  if (!loaded) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center" role="status">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (!enabled.includes(pluginId)) return <Navigate to="/" replace />;

  return <>{children}</>;
}
