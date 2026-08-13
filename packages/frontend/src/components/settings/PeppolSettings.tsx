import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { FormField } from "@/components/shared/FormField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { useSettingsStore } from "@/stores/settings.store";

/** EAS scheme presets, seeded from the business country where known. */
const EAS_BY_COUNTRY: Record<string, string> = {
  BE: "0208", // Belgian enterprise number (KBO/BCE)
  DE: "9930", // German VAT (USt-IdNr)
  AT: "9913", // Austrian VAT (UID)
  CH: "9957", // Swiss VAT (MWST)
  DK: "0198", // Danish VAT (CVR)
  ES: "9920", // Spanish NIF
  FI: "0037", // Finnish business identifier
  FR: "0002", // French SIREN
  GB: "0216", // UK company number
  IT: "9915", // Italian VAT (P.IVA)
  NL: "0106", // Dutch company number (KvK)
  SE: "0007", // Swedish organisation number
};

const SCHEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0088", label: "0088 — GLN" },
  { value: "0208", label: "0208 — BE enterprise number" },
  { value: "9930", label: "9930 — DE VAT (USt-IdNr)" },
  { value: "9913", label: "9913 — AT VAT (UID)" },
  { value: "9957", label: "9957 — CH VAT" },
  { value: "0198", label: "0198 — DK VAT (CVR)" },
  { value: "9920", label: "9920 — ES NIF" },
  { value: "0037", label: "0037 — FI business identifier" },
  { value: "0002", label: "0002 — FR SIREN" },
  { value: "0216", label: "0216 — UK company number" },
  { value: "9915", label: "9915 — IT VAT (P.IVA)" },
  { value: "0106", label: "0106 — NL company number (KvK)" },
  { value: "0007", label: "0007 — SE organisation number" },
];

const STATUS_STYLES: Record<string, string> = {
  kyc_pending: "bg-amber-600/10 text-amber-600 dark:text-amber-400",
  active: "bg-green-600/10 text-green-600 dark:text-green-400",
  conflict: "bg-red-600/10 text-red-600 dark:text-red-400",
  rejected: "bg-red-600/10 text-red-600 dark:text-red-400",
  suspended: "bg-muted text-muted-foreground",
  deregistered: "bg-muted text-muted-foreground",
};

export function PeppolSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const [transports, setTransports] = useState<
    Array<{ id: string; label: string; networks: string[]; configured: boolean }>
  >([]);
  const [participant, setParticipant] = useState<{
    status: string;
    scheme?: string;
    identifier?: string;
    status_detail?: string | null;
    action_url?: string | null;
    provider_ref?: string | null;
  } | null>(null);
  const [wizard, setWizard] = useState<{
    scheme: string;
    identifier: string;
    legal_name: string;
    country_code: string;
    contact_email: string;
  }>({ scheme: "", identifier: "", legal_name: "", country_code: "", contact_email: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const peppolEnabled = settings.peppol_enabled === "true";
  const environment = settings.peppol_environment || "live";
  const selectedTransport = transports.find(
    (t) => t.id === (settings.peppol_transport || "peppol-sh"),
  );
  const configured = selectedTransport?.configured ?? false;

  const refreshAll = useCallback(() => {
    api
      .listPeppolTransports()
      .then((r) => setTransports(r.data || []))
      .catch(() => {});
    if (peppolEnabled) {
      api
        .getPeppolParticipant()
        .then((r) => setParticipant(r.data))
        .catch(() => {});
    } else {
      setParticipant(null);
    }
  }, [peppolEnabled]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const save = async (patch: Record<string, string>) => {
    try {
      const res = await api.updateSettings(patch);
      await fetchSettings();
      return res;
    } catch (err) {
      toast.error(formatApiError(err, t));
      throw err;
    }
  };

  const toggle = async (key: string, on: boolean) => {
    await save({ [key]: on ? "true" : "false" });
    toast.success(t("settings.settings_saved"));
    refreshAll();
  };

  const suggestedScheme = useMemo(() => {
    const country = (settings.company_country || "").toUpperCase();
    return EAS_BY_COUNTRY[country] ?? "";
  }, [settings.company_country]);

  async function startRegistration() {
    if (!wizard.scheme || !wizard.identifier || !wizard.legal_name || !wizard.country_code) {
      toast.error(t("peppol.registration_incomplete"));
      return;
    }
    setBusy("register");
    try {
      const res = await api.registerPeppolParticipant({
        scheme: wizard.scheme,
        identifier: wizard.identifier,
        legal_name: wizard.legal_name,
        country_code: wizard.country_code,
        contact_email: wizard.contact_email,
      });
      setParticipant({
        ...(participant || {}),
        ...res.data,
        scheme: wizard.scheme,
        identifier: wizard.identifier,
      });
      if (res.data.status === "conflict") {
        toast.warning(t("peppol.registration_conflict"));
      } else if (res.data.actionUrl) {
        toast.success(t("peppol.registration_kyc_pending"));
      } else {
        toast.success(t("peppol.registration_started"));
      }
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function refreshParticipant() {
    setBusy("refresh");
    try {
      const res = await api.refreshPeppolParticipant();
      setParticipant({ ...(participant || {}), ...res.data });
      if (res.data.status === "active") toast.success(t("peppol.registration_active"));
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function deregister() {
    if (!window.confirm(t("peppol.deregister_confirm"))) return;
    setBusy("deregister");
    try {
      await api.deregisterPeppolParticipant();
      setParticipant(null);
      toast.success(t("peppol.deregistered"));
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {environment === "test" && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t("peppol.test_environment_banner")}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("peppol.master_toggle_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField label={t("peppol.master_toggle")} hint={t("peppol.master_toggle_hint")}>
            <label className="flex items-center gap-2 h-9">
              <input
                type="checkbox"
                checked={peppolEnabled}
                onChange={(e) => toggle("peppol_enabled", e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-muted-foreground">
                {t("peppol.master_toggle_label")}
              </span>
            </label>
          </FormField>
        </CardContent>
      </Card>

      {peppolEnabled && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("peppol.connection_title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label={t("peppol.transport_label")} hint={t("peppol.transport_hint")}>
                <select
                  value={settings.peppol_transport || "peppol-sh"}
                  onChange={(e) => save({ peppol_transport: e.target.value })}
                  className="form-select"
                  disabled={transports.length === 0}
                >
                  {transports.map((tr) => (
                    <option key={tr.id} value={tr.id}>
                      {tr.label} {tr.networks.join(", ")}
                    </option>
                  ))}
                </select>
              </FormField>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("peppol.credentials_status")}</span>
                {configured ? (
                  <span className="text-emerald-600 font-medium">
                    <CheckCircle2 className="h-4 w-4 inline mr-1" />
                    {t("peppol.credentials_configured")}
                  </span>
                ) : (
                  <span className="text-amber-600 font-medium">
                    <AlertTriangle className="h-4 w-4 inline mr-1" />
                    {t("peppol.credentials_missing")}
                  </span>
                )}
              </div>
              <FormField label={t("peppol.environment_label")} hint={t("peppol.environment_hint")}>
                <select
                  value={environment}
                  onChange={(e) => save({ peppol_environment: e.target.value })}
                  className="form-select"
                >
                  <option value="test">{t("peppol.environment_test")}</option>
                  <option value="live">{t("peppol.environment_live")}</option>
                </select>
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("peppol.sender_title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  label={t("peppol.sender_scheme")}
                  hint={
                    suggestedScheme
                      ? t("peppol.sender_scheme_suggested", { scheme: suggestedScheme })
                      : t("peppol.sender_scheme_hint")
                  }
                >
                  <select
                    value={settings.peppol_sender_scheme || suggestedScheme}
                    onChange={(e) => save({ peppol_sender_scheme: e.target.value })}
                    className="form-select"
                  >
                    <option value="">{t("common.none")}</option>
                    {SCHEME_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label={t("peppol.sender_id")} hint={t("peppol.sender_id_hint")}>
                  <Input
                    value={settings.peppol_sender_id || ""}
                    onChange={(e) => save({ peppol_sender_id: e.target.value })}
                    placeholder="0123456789"
                  />
                </FormField>
              </div>
              <FormField label={t("peppol.auto_send")}>
                <label className="flex items-center gap-2 h-9">
                  <input
                    type="checkbox"
                    checked={settings.peppol_auto_send === "true"}
                    onChange={(e) => toggle("peppol_auto_send", e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-muted-foreground">
                    {t("peppol.auto_send_hint")}
                  </span>
                </label>
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("peppol.receiver_title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("peppol.receiver_hint")}</p>

              {participant ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      className={
                        STATUS_STYLES[participant.status] || "bg-muted text-muted-foreground"
                      }
                    >
                      {t(`peppol.participant_status_${participant.status}`)}
                    </Badge>
                    <span className="text-sm tabular-nums">
                      {participant.scheme}:{participant.identifier}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={refreshParticipant}
                      >
                        {busy === "refresh" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        {t("peppol.refresh_status")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={busy !== null}
                        onClick={deregister}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("peppol.deregister")}
                      </Button>
                    </div>
                  </div>
                  {participant.action_url && (
                    <a
                      href={participant.action_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t("peppol.kyc_action_url")}
                    </a>
                  )}
                  {participant.status_detail && (
                    <p className="text-sm text-muted-foreground">{participant.status_detail}</p>
                  )}
                  {participant.status === "conflict" && (
                    <p className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                      <ShieldAlert className="h-4 w-4 shrink-0" />
                      {t("peppol.conflict_explainer")}
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label={t("peppol.receiver_scheme")}>
                    <select
                      value={wizard.scheme}
                      onChange={(e) => setWizard({ ...wizard, scheme: e.target.value })}
                      className="form-select"
                    >
                      <option value="">{t("common.none")}</option>
                      {SCHEME_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label={t("peppol.receiver_identifier")}>
                    <Input
                      value={wizard.identifier}
                      onChange={(e) => setWizard({ ...wizard, identifier: e.target.value })}
                      placeholder="0123456789"
                    />
                  </FormField>
                  <FormField label={t("peppol.receiver_legal_name")}>
                    <Input
                      value={wizard.legal_name}
                      onChange={(e) => setWizard({ ...wizard, legal_name: e.target.value })}
                    />
                  </FormField>
                  <FormField label={t("peppol.receiver_country")}>
                    <Input
                      value={wizard.country_code}
                      onChange={(e) =>
                        setWizard({ ...wizard, country_code: e.target.value.toUpperCase() })
                      }
                      placeholder="BE"
                      maxLength={2}
                    />
                  </FormField>
                  <FormField
                    label={t("peppol.receiver_contact_email")}
                    hint={t("peppol.receiver_contact_hint")}
                  >
                    <Input
                      type="email"
                      value={wizard.contact_email}
                      onChange={(e) => setWizard({ ...wizard, contact_email: e.target.value })}
                      placeholder="billing@example.com"
                    />
                  </FormField>
                </div>
              )}

              {!participant && (
                <Button disabled={busy !== null} onClick={startRegistration}>
                  {busy === "register" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                  {t("peppol.register_button")}
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
