// Plugin detail view at /settings/plugins/:pluginId. Follows the
// /settings/templates/:id/edit sub-route pattern: the parent Settings page
// resolves to the plugins tab and this renders inside its TabsContent.
// Shows identity, version state, enablement or the blocked reason, the
// update banner, description, links, the plugin's own settings component,
// and for planned entries the demand vote. Planned entries render no switch
// and no settings; a vote that cannot be sent (egress off) is not offered.

import { ArrowLeft, BookOpen, ExternalLink, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n";
import {
  blockedChipKey,
  CATEGORIES,
  canShowUpdates,
  canVote,
  RELEASES_URL,
  voteToastKey,
} from "./catalog";
import { catalogIcon } from "./icon-map";
import { getPlugins } from "./registry";
import { usePluginsStore } from "./use-plugins.store";

export function PluginDetailView({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const entries = usePluginsStore((s) => s.entries);
  const provenance = usePluginsStore((s) => s.provenance);
  const loaded = usePluginsStore((s) => s.loaded);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const vote = usePluginsStore((s) => s.vote);
  const [voting, setVoting] = useState(false);

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  if (!loaded) return null;

  const entry = entries.find((p) => p.id === pluginId);
  if (!entry) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground space-y-4">
          <Link to="/settings/plugins" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {t("plugins.back")}
          </Link>
          <p>{t("plugins.detail_not_found")}</p>
        </CardContent>
      </Card>
    );
  }

  const Icon = catalogIcon(entry.icon);
  const categoryKnown = (CATEGORIES as readonly string[]).includes(entry.category);
  const chipKey = blockedChipKey(entry.blockedReason, provenance?.managed === true);
  const settingsPlugin = getPlugins().find((p) => p.id === entry.id);
  const SettingsPanel = settingsPlugin?.settings;
  const showSettings = entry.installed && entry.blockedReason === null && Boolean(SettingsPanel);
  const egressEnabled = provenance?.egressEnabled ?? false;

  const toggle = async (next: boolean) => {
    try {
      await setEnabled(entry.id, next);
      toast.success(t(next ? "plugins.enabled_toast" : "plugins.disabled_toast"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const sendVote = async () => {
    setVoting(true);
    try {
      const outcome = await vote(entry.id);
      const message = t(voteToastKey(outcome.status));
      if (outcome.status === "recorded") toast.success(message);
      else if (outcome.status === "already_voted") toast.info(message);
      else toast.error(message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setVoting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <Link
          to="/settings/plugins"
          className="inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("plugins.back")}
        </Link>
        <div className="flex items-start gap-3">
          <Icon className="h-8 w-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {entry.name}
              <Badge variant="outline">
                {categoryKnown ? t(`plugins.filter_${entry.category}`) : entry.category}
              </Badge>
              {chipKey && <Badge variant="secondary">{t(chipKey)}</Badge>}
            </CardTitle>
            <p className="text-sm text-muted-foreground">{entry.tagline}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("plugins.installed_version")}: {entry.installedVersion ?? "-"}
              {" · "}
              {t("plugins.latest_version")}: {entry.latestVersion ?? "-"}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entry.updateAvailable && canShowUpdates(provenance) && (
          <div className="rounded-lg border p-3 text-sm space-y-1">
            {/* updateAvailable now implies updateRequiresApp, so there is
                always a concrete app version to name. */}
            <p>
              {t("plugins.update_banner", {
                version: entry.latestVersion ?? "",
                app: entry.updateRequiresApp ?? "",
              })}
            </p>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs underline"
            >
              {t("plugins.view_release")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {entry.status !== "planned" && entry.blockedReason === null && (
          <div className="flex items-center justify-between border rounded-lg p-3">
            <span className="text-sm">
              {t(entry.enabled ? "plugins.disable" : "plugins.enable")}
            </span>
            <Switch
              checked={entry.enabled}
              disabled={!loaded}
              aria-label={`${t(entry.enabled ? "plugins.disable" : "plugins.enable")}: ${entry.name}`}
              onCheckedChange={(next) => void toggle(next)}
            />
          </div>
        )}

        {canVote(entry, egressEnabled) && (
          <div className="flex items-center justify-between border rounded-lg p-3">
            <span className="text-sm">{t("plugins.votes_count", { count: entry.votes })}</span>
            <Button size="sm" disabled={voting} onClick={() => void sendVote()}>
              <ThumbsUp className="h-4 w-4" />
              {t("plugins.vote_button")}
            </Button>
          </div>
        )}

        <p className="text-sm whitespace-pre-line">{entry.description}</p>

        {(entry.docs || entry.source) && (
          <div className="flex items-center gap-4 text-sm">
            {entry.docs && (
              <a
                href={entry.docs}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <BookOpen className="h-4 w-4" />
                {t("plugins.docs_link")}
              </a>
            )}
            {entry.source && (
              <a
                href={entry.source}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                {t("plugins.source_link")}
              </a>
            )}
          </div>
        )}

        {showSettings && SettingsPanel && (
          <>
            <Separator />
            <SettingsPanel />
          </>
        )}
      </CardContent>
    </Card>
  );
}
