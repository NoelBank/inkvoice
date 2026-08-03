import { Layers, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatCurrency } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Customer of the invoice the action was launched from; preselected. */
  defaultCustomerId: string | null;
  /** Called with the id of the new consolidated draft. */
  onConsolidated: (invoiceId: string) => void;
}

export function ConsolidateInvoiceDialog({
  open,
  onOpenChange,
  defaultCustomerId,
  onConsolidated,
}: Props) {
  const { t } = useTranslation();
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(defaultCustomerId);
    setSelected(new Set());
    api
      .listCustomers({ limit: "100" })
      .then((r) => setCustomers((r.data as any).items || []))
      .catch(() => setCustomers([]));
  }, [open, defaultCustomerId]);

  const loadDrafts = useCallback((customer: string | null) => {
    setDrafts([]);
    if (!customer) return;
    setLoading(true);
    api
      .listInvoices({ status: "draft", type: "invoice", customer_id: customer, limit: "100" })
      .then((r) => setDrafts((r.data as any).items || []))
      .catch(() => setDrafts([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) loadDrafts(customerId);
  }, [open, customerId, loadDrafts]);

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleConsolidate = async () => {
    if (!customerId || selected.size < 2) return;
    setSaving(true);
    try {
      const res = await api.consolidateInvoices({
        customer_id: customerId,
        invoice_ids: drafts.filter((d) => selected.has(d.id)).map((d) => d.id),
      });
      toast.success(t("invoices.consolidated"));
      onOpenChange(false);
      onConsolidated(res.data.id);
    } catch (err: unknown) {
      toast.error(formatApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" /> {t("invoices.consolidate")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">{t("invoices.customer")}</span>
            <Select value={customerId || ""} onValueChange={(v) => v && setCustomerId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("invoices.select_customer")}>
                  {customers.find((c) => c.id === customerId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t("invoices.consolidate_source_invoices")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("common.selected", { count: selected.size.toString() })}
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border">
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : drafts.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t("invoices.no_drafts_to_consolidate")}
                </p>
              ) : (
                drafts.map((d) => (
                  <label
                    key={d.id}
                    htmlFor={`consolidate-${d.id}`}
                    className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-accent/50 cursor-pointer"
                  >
                    <Checkbox
                      id={`consolidate-${d.id}`}
                      checked={selected.has(d.id)}
                      onCheckedChange={(checked) => toggle(d.id, checked === true)}
                    />
                    <span className="text-sm font-medium truncate">{d.invoice_number}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {d.customer_name}
                    </span>
                    <span className="ml-auto text-sm tabular-nums font-medium">
                      {formatCurrency(d.total, d.currency)}
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("invoices.consolidate_hint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConsolidate} disabled={saving || selected.size < 2 || !customerId}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {t("invoices.consolidate_action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
