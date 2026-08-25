import { Check, Copy, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type TwoFactorStatus } from "@/api/client";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";

interface Enrollment {
  secret: string;
  otpauth_uri: string;
  qr: string;
}

export function TwoFactorCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getTwoFactorStatus();
      setStatus(res.data);
    } catch (err) {
      toast.error(formatApiError(err, t));
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const res = await api.setupTwoFactor();
      setEnrollment(res.data);
      setCode("");
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async () => {
    setBusy(true);
    try {
      const res = await api.enableTwoFactor(code);
      setEnrollment(null);
      setCode("");
      setRecoveryCodes(res.data.recovery_codes);
      await refresh();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async () => {
    setBusy(true);
    try {
      await api.disableTwoFactor(password);
      toast.success(t("two_factor.disabled"));
      setDisabling(false);
      setPassword("");
      await refresh();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("two_factor.copy_failed"));
    }
  };

  if (!status) return null;

  return (
    <>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status.enabled ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldOff className="h-4 w-4 text-muted-foreground" />
            )}
            {t("two_factor.title")}
          </CardTitle>
          <CardDescription>{t("two_factor.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.enabled ? (
            <>
              <p className="text-sm">
                {t("two_factor.enabled_since", {
                  date: status.confirmed_at
                    ? new Date(status.confirmed_at).toLocaleDateString()
                    : "—",
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("two_factor.codes_remaining", {
                  count: String(status.recovery_codes_remaining),
                })}
              </p>
              {status.recovery_codes_remaining === 0 && (
                <p className="text-sm text-destructive">{t("two_factor.no_codes_warning")}</p>
              )}
              <Button variant="outline" onClick={() => setDisabling(true)}>
                {t("two_factor.disable")}
              </Button>
            </>
          ) : enrollment ? (
            <div className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t("two_factor.step_scan")}</li>
                <li>{t("two_factor.step_enter")}</li>
              </ol>
              <img
                src={enrollment.qr}
                alt={t("two_factor.qr_alt")}
                className="h-44 w-44 rounded-lg border bg-white p-2"
              />
              <div className="text-sm">
                <span className="text-muted-foreground">{t("two_factor.manual_entry")} </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {enrollment.secret}
                </code>
              </div>
              <FormField label={t("two_factor.verification_code")} required>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  className="max-w-40 text-center font-mono tracking-[0.3em]"
                />
              </FormField>
              <div className="flex gap-2">
                <Button onClick={confirmSetup} disabled={busy || code.trim().length < 6}>
                  {t("two_factor.activate")}
                </Button>
                <Button variant="ghost" onClick={() => setEnrollment(null)} disabled={busy}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={startSetup} disabled={busy}>
              {t("two_factor.enable")}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Shown exactly once — the codes are hashed server-side after this. */}
      <Dialog open={!!recoveryCodes} onOpenChange={() => setRecoveryCodes(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("two_factor.recovery_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("two_factor.recovery_hint")}</p>
          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
            {recoveryCodes?.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={copyRecoveryCodes}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {t("two_factor.copy_codes")}
            </Button>
            <Button onClick={() => setRecoveryCodes(null)}>{t("two_factor.codes_saved")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disabling} onOpenChange={(open) => !open && setDisabling(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("two_factor.disable_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("two_factor.disable_hint")}</p>
          <FormField label={t("auth.password")} required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </FormField>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisabling(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDisable} disabled={busy || !password}>
              {t("two_factor.disable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
