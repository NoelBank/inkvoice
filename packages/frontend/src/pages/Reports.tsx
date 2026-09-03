import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/api/client";
import { YearArchiveCard } from "@/components/shared/YearArchiveCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useTranslation } from "@/i18n";
import { toLocalIsoDate } from "@/lib/date";
import {
  endOfFiscalYear,
  parseFiscalYearStartMonth,
  startOfFiscalYear,
  subFiscalYears,
} from "@/lib/fiscal-year";
import { formatApiError } from "@/lib/format-api-error";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings.store";

const REPORT_TABS = [
  "tax-summary",
  "aging",
  "revenue-customer",
  "revenue-product",
  "profit-loss",
  "euer",
  "expenses-category",
  "cash-flow",
  "year-archive",
] as const;
type ReportTab = (typeof REPORT_TABS)[number];

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
  const w = 80;
  const h = 22;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  const pts = data
    .map((v, i) => {
      const x = (i / Math.max(1, data.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / range) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="block ml-auto" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function isReportTab(value: string | null | undefined): value is ReportTab {
  return value != null && (REPORT_TABS as readonly string[]).includes(value);
}

// Local-date formatting: the fiscal-year helpers build local-midnight Dates,
// so UTC-based toIsoDate would shift preset boundaries by one day (e.g.
// "This Year" starting Dec-31 instead of Jan-01 east of UTC).
const fmtDate = toLocalIsoDate;

function DateRangePicker({
  dateFrom,
  dateTo,
  onChange,
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
}) {
  const { t } = useTranslation();
  const fiscalStartMonth = useSettingsStore((s) =>
    parseFiscalYearStartMonth(s.settings.fiscal_year_start_month),
  );
  const now = new Date();
  const fyStart = startOfFiscalYear(now, fiscalStartMonth);
  const lastFyAnchor = subFiscalYears(now, fiscalStartMonth, 1);
  const presets = [
    {
      label: t("reports.this_month"),
      from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
      to: fmtDate(now),
    },
    {
      label: t("reports.last_month"),
      from: (() => {
        const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return fmtDate(d);
      })(),
      to: (() => {
        const d = new Date(now.getFullYear(), now.getMonth(), 0);
        return fmtDate(d);
      })(),
    },
    { label: t("reports.this_year"), from: fmtDate(fyStart), to: fmtDate(now) },
    {
      label: t("reports.last_year"),
      from: fmtDate(startOfFiscalYear(lastFyAnchor, fiscalStartMonth)),
      to: fmtDate(endOfFiscalYear(lastFyAnchor, fiscalStartMonth)),
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="date"
        value={dateFrom}
        onChange={(e) => onChange(e.target.value, dateTo)}
        className="w-auto"
      />
      <span className="text-muted-foreground text-sm">{t("common.to")}</span>
      <Input
        type="date"
        value={dateTo}
        onChange={(e) => onChange(dateFrom, e.target.value)}
        className="w-auto"
      />
      {presets.map((p) => (
        <Button key={p.label} variant="outline" size="sm" onClick={() => onChange(p.from, p.to)}>
          {p.label}
        </Button>
      ))}
    </div>
  );
}

export default function Reports() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab: string }>();
  const { smallBusiness } = useCapabilities();
  const tab: ReportTab = isReportTab(tabParam) ? tabParam : "tax-summary";
  const fiscalStartMonth = useSettingsStore((s) =>
    parseFiscalYearStartMonth(s.settings.fiscal_year_start_month),
  );
  // Revenue/product/cash-flow totals are consolidated into the base currency by
  // the backend, so they're formatted with the base currency symbol.
  const baseCurrency = useSettingsStore(
    (s) => s.settings.base_currency || s.settings.currency || "USD",
  );
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(() => fmtDate(startOfFiscalYear(now, fiscalStartMonth)));
  const [dateTo, setDateTo] = useState(() => fmtDate(now));
  const [monthsAhead, setMonthsAhead] = useState(6);
  const [euerYear, setEuerYear] = useState(now.getFullYear());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    if (tab === "year-archive") {
      // Download-only tabs: no JSON report to fetch.
      setData(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const params: Record<string, string> = {};
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;

      if (tab === "tax-summary") {
        const res = await api.getTaxSummary(params);
        setData(res.data);
      } else if (tab === "aging") {
        const res = await api.getAgingReport();
        setData(res.data);
      } else if (tab === "revenue-customer") {
        const res = await api.getRevenueByCustomer(params);
        setData(res.data);
      } else if (tab === "revenue-product") {
        const res = await api.getRevenueByProduct(params);
        setData(res.data);
      } else if (tab === "profit-loss") {
        const res = await api.getProfitLoss(params);
        setData(res.data);
      } else if (tab === "euer") {
        const res = await api.getEuerReport(euerYear);
        setData(res.data);
      } else if (tab === "expenses-category") {
        const res = await api.getExpensesByCategory(params);
        setData(res.data);
      } else if (tab === "cash-flow") {
        const res = await api.getCashFlowForecast(monthsAhead);
        setData(res.data);
      }
    } catch (e) {
      setLoadError(formatApiError(e, t));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tab, dateFrom, dateTo, monthsAhead, euerYear, t]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  useEffect(() => {
    if (tabParam && !isReportTab(tabParam)) {
      navigate("/reports/tax-summary", { replace: true });
    } else if (smallBusiness && tab === "tax-summary") {
      // Kleinunternehmer: no VAT to report, land on the EÜR instead.
      navigate("/reports/euer", { replace: true });
    }
  }, [tabParam, tab, smallBusiness, navigate]);

  const csvReport =
    tab === "revenue-customer"
      ? "revenue-by-customer"
      : tab === "revenue-product"
        ? "revenue-by-product"
        : tab === "cash-flow"
          ? "cash-flow-forecast"
          : tab === "expenses-category"
            ? "expenses-by-category"
            : tab;
  const exportCsv = () => {
    const params: Record<string, string> = {};
    if (tab === "cash-flow") {
      params.months = String(monthsAhead);
    } else if (tab === "euer") {
      params.year = String(euerYear);
    } else {
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
    }
    window.open(api.reportCsvUrl(csvReport, params), "_blank");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t("reports.title")}</h1>
        {
          <Button variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-2" /> {t("common.export_csv")}
          </Button>
        }
      </div>

      {loadError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <p className="text-sm text-muted-foreground flex-1">{loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => fetchReport()}>
            {t("common.retry")}
          </Button>
        </div>
      )}

      <Tabs
        value={tab}
        onValueChange={(v) => {
          navigate(`/reports/${v}`);
          setData(null);
        }}
      >
        <TabsList>
          {!smallBusiness && (
            <TabsTrigger value="tax-summary">{t("reports.tab_tax_summary")}</TabsTrigger>
          )}
          <TabsTrigger value="aging">{t("reports.tab_aging")}</TabsTrigger>
          <TabsTrigger value="revenue-customer">{t("reports.tab_revenue_customer")}</TabsTrigger>
          <TabsTrigger value="revenue-product">{t("reports.tab_revenue_product")}</TabsTrigger>
          <TabsTrigger value="profit-loss">{t("reports.tab_profit_loss")}</TabsTrigger>
          <TabsTrigger value="euer">{t("reports.tab_euer")}</TabsTrigger>
          <TabsTrigger value="expenses-category">{t("reports.tab_expenses_category")}</TabsTrigger>
          <TabsTrigger value="cash-flow">{t("reports.tab_cash_flow")}</TabsTrigger>
          <TabsTrigger value="year-archive">{t("reports.tab_year_archive")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab !== "aging" && tab !== "cash-flow" && tab !== "year-archive" && tab !== "euer" && (
        <DateRangePicker
          dateFrom={dateFrom}
          dateTo={dateTo}
          onChange={(f, t) => {
            setDateFrom(f);
            setDateTo(t);
          }}
        />
      )}

      {tab === "cash-flow" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("reports.months_ahead")}:</span>
          {[3, 6, 12].map((n) => (
            <Button
              key={n}
              variant={monthsAhead === n ? "default" : "outline"}
              size="sm"
              onClick={() => setMonthsAhead(n)}
            >
              {n}
            </Button>
          ))}
        </div>
      )}

      {tab === "euer" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("reports.euer_year")}:</span>
          {Array.from({ length: 5 }, (_, i) => now.getFullYear() - i).map((y) => (
            <Button
              key={y}
              variant={euerYear === y ? "default" : "outline"}
              size="sm"
              onClick={() => setEuerYear(y)}
            >
              {y}
            </Button>
          ))}
        </div>
      )}

      {tab === "year-archive" && <YearArchiveCard />}

      {loading && (
        <div className="flex justify-center py-8" role="status">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          <span className="sr-only">{t("common.loading")}</span>
        </div>
      )}

      {!loading && tab === "tax-summary" && data && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("reports.tax_name")}</TableHead>
                  <TableHead className="text-right">{t("reports.rate")}</TableHead>
                  <TableHead className="text-right">{t("reports.taxable_amount")}</TableHead>
                  <TableHead className="text-right">{t("reports.tax_collected")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      {t("reports.no_tax_data")}
                    </TableCell>
                  </TableRow>
                )}
                {data.rows?.map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>{r.tax_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.tax_rate}%</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.taxable_amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.tax_collected)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.totals &&
                  (data.totals.taxable_amount > 0 || data.totals.tax_collected > 0) && (
                    <TableRow className="font-semibold">
                      <TableCell colSpan={2}>{t("common.total")}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(data.totals.taxable_amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(data.totals.tax_collected)}
                      </TableCell>
                    </TableRow>
                  )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!loading && tab === "aging" && Array.isArray(data) && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {data.map((bucket: any, i: number) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">{bucket.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-bold tabular-nums">{formatCurrency(bucket.total)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("reports.invoices_count", { count: bucket.count })}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          {data.map(
            (bucket: any, i: number) =>
              bucket.invoices.length > 0 && (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="text-sm">{bucket.label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("reports.invoice_number")}</TableHead>
                          <TableHead>{t("reports.customer")}</TableHead>
                          <TableHead>{t("reports.due_date")}</TableHead>
                          <TableHead className="text-right">{t("reports.balance")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bucket.invoices.map((inv: any) => (
                          <TableRow
                            key={inv.id}
                            className="cursor-pointer hover:bg-accent/50"
                            onClick={() => navigate(`/invoices/${inv.id}`)}
                          >
                            <TableCell className="font-medium">{inv.invoice_number}</TableCell>
                            <TableCell>{inv.customer_name}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {inv.due_date ? formatDate(inv.due_date) : "-"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium">
                              {formatCurrency(inv.total - (inv.amount_paid || 0))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ),
          )}
        </div>
      )}

      {!loading && tab === "revenue-customer" && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("reports.customer")}</TableHead>
                  <TableHead className="text-right">{t("nav.invoices")}</TableHead>
                  <TableHead className="text-right">{t("reports.total_revenue")}</TableHead>
                  <TableHead className="text-right">{t("reports.average_invoice")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!Array.isArray(data) || data.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      {t("reports.no_revenue_data")}
                    </TableCell>
                  </TableRow>
                )}
                {Array.isArray(data) &&
                  data.map((r: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{r.customer_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.invoice_count}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.total_revenue, baseCurrency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.average_invoice, baseCurrency)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!loading && tab === "revenue-product" && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("reports.product")}</TableHead>
                  <TableHead className="text-right">{t("reports.quantity_sold")}</TableHead>
                  <TableHead className="text-right">{t("reports.total_revenue")}</TableHead>
                  <TableHead className="text-right">{t("reports.average_price")}</TableHead>
                  <TableHead className="text-right">{t("reports.trend")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!data?.rows || data.rows.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {t("reports.no_revenue_data")}
                    </TableCell>
                  </TableRow>
                )}
                {data?.rows?.map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{r.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantity_sold}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.total_revenue, baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.average_price, baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Sparkline data={r.monthly_quantities ?? []} color="var(--chart-2)" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!loading && tab === "profit-loss" && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">
                  {t("reports.total_revenue")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold tabular-nums">
                  {formatCurrency(data.revenue ?? 0, data.base_currency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">
                  {t("reports.total_expenses")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold tabular-nums">
                  {formatCurrency(data.expenses ?? 0, data.base_currency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">
                  {t("reports.net_income")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={`text-xl font-bold tabular-nums ${
                    (data.net ?? 0) < 0 ? "text-red-500 dark:text-red-400" : ""
                  }`}
                >
                  {formatCurrency(data.net ?? 0, data.base_currency)}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("reports.month")}</TableHead>
                    <TableHead className="text-right">{t("reports.total_revenue")}</TableHead>
                    <TableHead className="text-right">{t("reports.total_expenses")}</TableHead>
                    <TableHead className="text-right">{t("reports.net_income")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!data.months || data.months.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        {t("reports.no_pl_data")}
                      </TableCell>
                    </TableRow>
                  )}
                  {data.months?.map((r: any) => (
                    <TableRow key={r.month}>
                      <TableCell className="font-medium">{r.month}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.revenue, data.base_currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.expenses, data.base_currency)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          r.net < 0 ? "text-red-500 dark:text-red-400" : ""
                        }`}
                      >
                        {formatCurrency(r.net, data.base_currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {!loading && tab === "euer" && data && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("reports.euer_intro")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                label: t("reports.euer_receipts"),
                value: data.kleinunternehmer ? data.receipts.gross : data.receipts.net,
                signed: false,
              },
              {
                label: t("reports.euer_expenses"),
                value: data.kleinunternehmer ? data.expenses.gross : data.expenses.net,
                signed: false,
              },
              { label: t("reports.euer_profit"), value: data.profit, signed: true },
            ].map((c) => (
              <Card key={c.label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">{c.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p
                    className={`text-xl font-bold tabular-nums ${
                      c.signed && (c.value ?? 0) < 0 ? "text-red-500 dark:text-red-400" : ""
                    }`}
                  >
                    {formatCurrency(c.value ?? 0, data.base_currency)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("reports.euer_line")}</TableHead>
                    <TableHead className="text-right">{t("reports.euer_amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.receipts.gross === 0 && data.expenses.by_category.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center py-8 text-muted-foreground">
                        {t("reports.euer_no_data", { year: String(data.year) })}
                      </TableCell>
                    </TableRow>
                  )}
                  {data.kleinunternehmer ? (
                    <TableRow>
                      <TableCell className="font-medium">{t("reports.euer_receipts_ku")}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(data.receipts.gross, data.base_currency)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      <TableRow>
                        <TableCell className="font-medium">
                          {t("reports.euer_receipts_net")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(data.receipts.net, data.base_currency)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">
                          {t("reports.euer_vat_collected")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(data.receipts.vat, data.base_currency)}
                        </TableCell>
                      </TableRow>
                    </>
                  )}
                  {data.expenses.by_category.map((r: any) => (
                    <TableRow key={r.category}>
                      <TableCell>
                        {t("reports.euer_expense_category", {
                          category: r.category || t("reports.euer_uncategorized"),
                        })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(
                          data.kleinunternehmer ? r.gross : r.net,
                          data.base_currency,
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!data.kleinunternehmer && (
                    <TableRow>
                      <TableCell className="text-muted-foreground">
                        {t("reports.euer_input_vat")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(data.expenses.vat, data.base_currency)}
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow>
                    <TableCell className="font-medium">
                      {t("reports.euer_total_expenses")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(
                        data.kleinunternehmer ? data.expenses.gross : data.expenses.net,
                        data.base_currency,
                      )}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-semibold">{t("reports.euer_profit")}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums font-semibold ${
                        data.profit < 0 ? "text-red-500 dark:text-red-400" : ""
                      }`}
                    >
                      {formatCurrency(data.profit, data.base_currency)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {!loading && tab === "expenses-category" && data && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("expenses.category")}</TableHead>
                  <TableHead className="text-right">{t("reports.count")}</TableHead>
                  <TableHead className="text-right">{t("common.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!data.rows || data.rows.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                      {t("reports.no_expense_data")}
                    </TableCell>
                  </TableRow>
                )}
                {data.rows?.map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{r.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.total, baseCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.rows?.length > 0 && (
                  <TableRow className="font-semibold">
                    <TableCell>{t("common.total")}</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(data.total ?? 0)}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!loading && tab === "cash-flow" && Array.isArray(data) && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
                    <CartesianGrid
                      strokeDasharray="2 4"
                      stroke="currentColor"
                      className="text-border"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      formatter={(value: any) => formatCurrency(value, baseCurrency)}
                      labelClassName="text-muted-foreground"
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    {/* Animation disabled: the react-smooth grow animation can
                        freeze at its first frame (~1px-tall bars) under reduced
                        motion or throttled tabs, leaving the chart unreadable. */}
                    <Bar
                      dataKey="expected_invoiced"
                      stackId="a"
                      fill="var(--chart-1)"
                      name={t("reports.expected_invoiced")}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="expected_recurring"
                      stackId="a"
                      fill="var(--chart-3)"
                      name={t("reports.expected_recurring")}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("reports.month")}</TableHead>
                    <TableHead className="text-right">{t("reports.expected_invoiced")}</TableHead>
                    <TableHead className="text-right">{t("reports.expected_recurring")}</TableHead>
                    <TableHead className="text-right">{t("reports.expected_total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.length === 0 || data.every((r: any) => r.total === 0) ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        {t("reports.no_forecast_data")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.map((r: any) => (
                      <TableRow key={r.month}>
                        <TableCell className="font-medium">{r.month}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(r.expected_invoiced, baseCurrency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(r.expected_recurring, baseCurrency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatCurrency(r.total, baseCurrency)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
