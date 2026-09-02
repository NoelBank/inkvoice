// Admin Plugins settings tab: master list of the merged catalog with search,
// category and status filters, a grid/list view toggle and the provenance
// footer. Renders the detail view instead when the route carries a pluginId
// (see PluginDetailView). Data comes from the plugins store; the enable
// switch writes through PUT /api/v1/plugins/:id as before.

import { LayoutGrid, List, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n";
import {
  blockedChipKey,
  CATEGORIES,
  type CatalogPluginEntry,
  type CatalogProvenance,
  canShowUpdates,
  catalogErrorKey,
  catalogOrigin,
  filterPlugins,
  footerState,
  loadViewPreference,
  type PluginsView,
  type StatusFilter,
  saveViewPreference,
} from "./catalog";
import { catalogIcon } from "./icon-map";
import { PluginDetailView } from "./PluginDetailView";
import { usePluginsStore } from "./use-plugins.store";

const STATUS_FILTERS: StatusFilter[] = ["all", "enabled", "disabled", "planned"];

function BlockedChip({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  const managed = usePluginsStore((s) => s.provenance?.managed === true);
  const key = blockedChipKey(entry.blockedReason, managed);
  if (!key) return null;
  return <Badge variant="secondary">{t(key)}</Badge>;
}

function UpdateBadge({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  const provenance = usePluginsStore((s) => s.provenance);
  if (!entry.updateAvailable || !canShowUpdates(provenance)) return null;
  return <Badge variant="secondary">{t("plugins.update_badge")}</Badge>;
}

function EnableSwitch({ entry }: { entry: CatalogPluginEntry }) {
  const { t } = useTranslation();
  const loaded = usePluginsStore((s) => s.loaded);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  // Held while the PUT is in flight, so a double click cannot fire two writes.
  const [saving, setSaving] = useState(false);
  if (entry.blockedReason !== null) return null;
  return (
    <Switch
      checked={entry.enabled}
      disabled={!loaded || saving}
      aria-label={`${t(entry.enabled ? "plugins.disable" : "plugins.enable")}: ${entry.name}`}
      onCheckedChange={(next) => {
        setSaving(true);
        setEnabled(entry.id, next)
          .then(() => toast.success(t(next ? "plugins.enabled_toast" : "plugins.disabled_toast")))
          .catch((e: Error) => toast.error(e.message))
          .finally(() => setSaving(false));
      }}
    />
  );
}

function PluginCard({ entry, view }: { entry: CatalogPluginEntry; view: PluginsView }) {
  const Icon = catalogIcon(entry.icon);
  return (
    <div
      className={
        view === "grid"
          ? "flex flex-col gap-3 border rounded-lg p-4"
          : "flex items-center justify-between gap-3 border rounded-lg p-3"
      }
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              to={`/settings/plugins/${entry.id}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {entry.name}
            </Link>
            <BlockedChip entry={entry} />
            <UpdateBadge entry={entry} />
          </div>
          <div className="text-xs text-muted-foreground line-clamp-2">{entry.tagline}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {entry.installedVersion && (
          <span className="text-xs text-muted-foreground">v{entry.installedVersion}</span>
        )}
        <EnableSwitch entry={entry} />
      </div>
    </div>
  );
}

function SyncFooter({ provenance }: { provenance: CatalogProvenance }) {
  const { t } = useTranslation();
  const refresh = usePluginsStore((s) => s.refresh);
  const turnOff = usePluginsStore((s) => s.turnOff);
  const turnOn = usePluginsStore((s) => s.turnOn);
  const loading = usePluginsStore((s) => s.loading);
  const state = footerState(provenance, Date.now());
  const age = (minutes: number | null) => {
    if (minutes === null || minutes < 1) return t("plugins.time_just_now");
    if (minutes < 60) return t("plugins.time_minutes_ago", { count: minutes });
    if (minutes < 1440) return t("plugins.time_hours_ago", { count: Math.floor(minutes / 60) });
    return t("plugins.time_days_ago", { count: Math.floor(minutes / 1440) });
  };
  // The source is whatever the operator configured, so name it rather than
  // asserting inkvoice.app at a mirror.
  const origin = catalogOrigin(provenance);
  // The catalog's own build date, so a fresh fetch of stale data reads as
  // stale data rather than as freshness.
  const published = provenance.publishedAt
    ? new Date(provenance.publishedAt).toLocaleDateString()
    : null;

  // Off is not a dead end: the same footer offers the way back, or an install
  // that switched egress off could only restore it through the settings API.
  if (state.kind === "off") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t("plugins.footer_off")}</span>
        {!provenance.managed && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={loading}
            onClick={() => turnOn().catch((e: Error) => toast.error(e.message))}
          >
            {t("plugins.footer_turn_on")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {state.kind === "synced" && (
        <span>
          {t("plugins.footer_synced", { age: age(state.ageMinutes) })}
          {published ? ` · ${t("plugins.footer_published", { date: published })}` : ""}
          {origin ? ` · ${origin}` : ""}
        </span>
      )}
      {state.kind === "stale" && (
        <span className="text-destructive">
          {t("plugins.footer_stale", {
            age: age(state.ageMinutes),
            reason: t(catalogErrorKey(state.reason)),
          })}
        </span>
      )}
      {state.kind === "failed" && (
        <span className="text-destructive">
          {t("plugins.footer_failed", { reason: t(catalogErrorKey(state.reason)) })}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={loading}
        onClick={() => void refresh({ force: true })}
      >
        <RotateCw className="h-3 w-3" />
        {t("plugins.footer_refresh")}
      </Button>
      {!provenance.managed && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => turnOff().catch((e: Error) => toast.error(e.message))}
        >
          {t("plugins.footer_turn_off")}
        </Button>
      )}
    </div>
  );
}

function PluginsMasterView() {
  const { t } = useTranslation();
  const entries = usePluginsStore((s) => s.entries);
  const provenance = usePluginsStore((s) => s.provenance);
  const loaded = usePluginsStore((s) => s.loaded);
  const error = usePluginsStore((s) => s.error);
  const refresh = usePluginsStore((s) => s.refresh);
  const ensureFetched = usePluginsStore((s) => s.ensureFetched);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [view, setView] = useState<PluginsView>(() => loadViewPreference());

  useEffect(() => {
    ensureFetched();
  }, [ensureFetched]);

  const filtered = useMemo(
    () => filterPlugins(entries, { query, category, status }),
    [entries, query, category, status],
  );

  const changeView = (next: PluginsView) => {
    setView(next);
    saveViewPreference(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("plugins.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("plugins.search_placeholder")}
            className="h-8 w-56"
          />
          <Select value={category} onValueChange={(v) => v && setCategory(v)}>
            <SelectTrigger size="sm" className="gap-1.5 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("plugins.filter_all")}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`plugins.filter_${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s}
                variant={status === s ? "default" : "outline"}
                size="sm"
                className="h-8 px-3"
                onClick={() => setStatus(s)}
              >
                {t(`plugins.status_${s}`)}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={view === "grid" ? "default" : "outline"}
              size="sm"
              className="h-8 px-2"
              aria-label={t("plugins.view_grid")}
              onClick={() => changeView("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={view === "list" ? "default" : "outline"}
              size="sm"
              className="h-8 px-2"
              aria-label={t("plugins.view_list")}
              onClick={() => changeView("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {loaded && entries.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">{t("plugins.empty")}</p>
        )}
        {/* Shown whenever the last request failed, not only on a cold start.
            Gating this on `!provenance` meant that after one good load a failing
            refresh set `error` and rendered nothing at all, so the refresh
            button looked inert. */}
        {loaded && error && (
          <div className="flex items-center gap-3 text-sm text-destructive">
            <span>
              {t(entries.length > 0 ? "plugins.refresh_failed" : "plugins.load_failed", {
                reason: error,
              })}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("plugins.footer_refresh")}
            </Button>
          </div>
        )}
        {loaded && entries.length > 0 && filtered.length === 0 && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{t("plugins.no_matches")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setCategory("all");
                setStatus("all");
              }}
            >
              {t("plugins.clear_filters")}
            </Button>
          </div>
        )}

        <div className={view === "grid" ? "grid gap-3 md:grid-cols-2" : "space-y-2"}>
          {filtered.map((p) => (
            <PluginCard key={p.id} entry={p} view={view} />
          ))}
        </div>

        {provenance && <SyncFooter provenance={provenance} />}
      </CardContent>
    </Card>
  );
}

export function PluginsSettingsTab() {
  const { pluginId } = useParams<{ pluginId?: string }>();
  if (pluginId) return <PluginDetailView pluginId={pluginId} />;
  return <PluginsMasterView />;
}
