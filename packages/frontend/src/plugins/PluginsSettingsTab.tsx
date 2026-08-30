// Admin Plugins management tab: lists registered plugins with an enable/disable
// toggle. Registered as a cloud-only Settings tab (the Settings route is already
// admin-gated). Display metadata comes from the frontend plugin registry; the
// enabled state and writes go through the plugins store / backend.

import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { getPlugins } from "./registry";
import { usePluginsStore } from "./use-plugins.store";

export function PluginsSettingsTab() {
  const { t } = useTranslation();
  const enabled = usePluginsStore((s) => s.enabled);
  const loaded = usePluginsStore((s) => s.loaded);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);
  const setEnabled = usePluginsStore((s) => s.setEnabled);

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  const plugins = getPlugins();

  const toggle = async (id: string, next: boolean) => {
    try {
      await setEnabled(id, next);
      toast.success(t(next ? "plugins.enabled_toast" : "plugins.disabled_toast"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("plugins.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("plugins.description")}</p>
        {plugins.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("plugins.empty")}</p>
        )}
        {plugins.map((p) => {
          const isOn = enabled.includes(p.id);
          return (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 border rounded-lg p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <p.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(p.nameKey)}</div>
                  <div className="text-xs text-muted-foreground">{t(p.descriptionKey)}</div>
                </div>
              </div>
              <Button
                variant={isOn ? "outline" : "default"}
                size="sm"
                disabled={!loaded}
                onClick={() => toggle(p.id, !isOn)}
              >
                {isOn ? t("plugins.disable") : t("plugins.enable")}
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
