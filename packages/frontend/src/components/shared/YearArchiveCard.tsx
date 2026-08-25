import { AlertTriangle, CheckCircle2, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatCurrency, formatDate } from "@/lib/utils";

interface MissingReceipt {
  id: string;
  expense_date: string;
  vendor: string | null;
  description: string | null;
  total: number;
  currency: string;
}

/** Current year first — the archive is usually pulled for the year just ended. */
function selectableYears(): number[] {
  const current = new Date().getFullYear();
  return Array.from({ length: 8 }, (_, i) => current - i);
}

export function YearArchiveCard() {
  const { t } = useTranslation();
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [missing, setMissing] = useState<MissingReceipt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listMissingReceipts(year);
      setMissing(res.data ?? []);
    } catch (err) {
      toast.error(formatApiError(err, t));
      setMissing(null);
    } finally {
      setLoading(false);
    }
  }, [year, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const download = async () => {
    setDownloading(true);
    try {
      // Fetched rather than linked so the session cookie applies and the
      // archive stats header can be surfaced afterwards.
      const res = await fetch(`/api/v1/export/year/${year}`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `inkvoice-${year}.zip`;
      link.click();
      URL.revokeObjectURL(url);

      const stats = JSON.parse(res.headers.get("X-Archive-Stats") ?? "{}");
      toast.success(
        t("reports.archive_downloaded", {
          files: String(stats.files ?? 0),
          expenses: String(stats.expenses ?? 0),
          invoices: String(stats.invoices ?? 0),
        }),
      );
    } catch {
      toast.error(t("reports.archive_failed"));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <p className="text-sm text-muted-foreground">{t("reports.archive_intro")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t("reports.archive_year")}:</span>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="form-select w-32"
          >
            {selectableYears().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Button onClick={download} disabled={downloading}>
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t("reports.archive_download")}
          </Button>
        </div>

        {loading && (
          <div className="flex justify-center py-6" role="status">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        )}

        {!loading && missing?.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-emerald-600">
            <CheckCircle2 className="h-4 w-4" />
            {t("reports.archive_complete", { year: String(year) })}
          </p>
        )}

        {!loading && missing && missing.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              {t("reports.archive_missing", { count: String(missing.length) })}
            </p>
            <p className="text-sm text-muted-foreground">{t("reports.archive_missing_hint")}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("expenses.date")}</TableHead>
                  <TableHead>{t("expenses.vendor")}</TableHead>
                  <TableHead className="text-right">{t("expenses.total")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {missing.map((expense) => (
                  <TableRow key={expense.id}>
                    <TableCell>{formatDate(expense.expense_date)}</TableCell>
                    <TableCell>{expense.vendor || expense.description || "—"}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(expense.total, expense.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        to={`/expenses/${expense.id}`}
                        className="text-sm text-primary hover:underline"
                      >
                        {t("reports.archive_add_receipt")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
