// Installs the sidebar nav-visibility gate. The OSS Sidebar calls useNavGate()
// (which invokes whatever hook we register here) to decide whether a nav item
// tied to a pluginId should render. We back it with the plugins store, and use
// the same call site to lazily kick off the catalog fetch once the authed
// shell, and thus the Sidebar, mounts.

import { useEffect } from "react";
import { setNavGateHook } from "@/nav-registry";
import { usePluginsStore } from "./use-plugins.store";

export function installPluginNavGate(): void {
  setNavGateHook(() => {
    const enabled = usePluginsStore((s) => s.enabled);
    const loaded = usePluginsStore((s) => s.loaded);
    const ensureFetched = usePluginsStore((s) => s.ensureFetched);
    useEffect(() => {
      ensureFetched();
    }, [ensureFetched]);
    // Until the catalog loads, hide plugin nav items rather than flash them.
    return (pluginId: string) => (loaded ? enabled.includes(pluginId) : false);
  });
}
