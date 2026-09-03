import { Hono } from "hono";
import * as reportService from "../services/report.service";
import { buildCsv, type CsvColumn, csvHeaders } from "../utils/csv";
import { todayIso } from "../utils/date";

const reports = new Hono();

reports.get("/tax-summary", (c) => {
  const data = reportService.getTaxSummary({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  return c.json({ success: true, data });
});

reports.get("/tax-summary/csv", (c) => {
  const data = reportService.getTaxSummary({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  const cols: CsvColumn<(typeof data.rows)[number]>[] = [
    { header: "Tax Name", key: "tax_name" },
    { header: "Rate (%)", key: "tax_rate" },
    { header: "Taxable Amount", key: "taxable_amount" },
    { header: "Tax Collected", key: "tax_collected" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`tax-summary-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data.rows, cols));
});

reports.get("/aging", (c) => {
  const data = reportService.getAgingReport();
  return c.json({ success: true, data });
});

reports.get("/aging/csv", (c) => {
  const buckets = reportService.getAgingReport();
  type Row = {
    bucket: string;
    invoice_number: string;
    customer_name: string;
    due_date: string | null;
    total: number;
    amount_paid: number;
    balance: number;
  };
  const rows: Row[] = [];
  for (const b of buckets) {
    for (const inv of b.invoices) {
      rows.push({
        bucket: b.label,
        invoice_number: inv.invoice_number,
        customer_name: inv.customer_name,
        due_date: inv.due_date,
        total: inv.total,
        amount_paid: inv.amount_paid,
        balance: inv.total - (inv.amount_paid || 0),
      });
    }
  }
  const cols: CsvColumn<Row>[] = [
    { header: "Aging Bucket", key: "bucket" },
    { header: "Invoice #", key: "invoice_number" },
    { header: "Customer", key: "customer_name" },
    { header: "Due Date", key: "due_date" },
    { header: "Total", key: "total" },
    { header: "Paid", key: "amount_paid" },
    { header: "Balance", key: "balance" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`aging-report-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(rows, cols));
});

reports.get("/revenue-by-customer", (c) => {
  const data = reportService.getRevenueByCustomer({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  return c.json({ success: true, data });
});

reports.get("/revenue-by-customer/csv", (c) => {
  const data = reportService.getRevenueByCustomer({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  const cols: CsvColumn<(typeof data)[number]>[] = [
    { header: "Customer", key: "customer_name" },
    { header: "Invoices", key: "invoice_count" },
    { header: "Total Revenue", key: "total_revenue" },
    { header: "Average Invoice", key: "average_invoice" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`revenue-by-customer-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data, cols));
});

reports.get("/revenue-by-product", (c) => {
  const data = reportService.getRevenueByProduct({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  return c.json({ success: true, data });
});

reports.get("/revenue-by-product/csv", (c) => {
  const data = reportService.getRevenueByProduct({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  type Row = (typeof data.rows)[number] & Record<string, string | number>;
  const baseCols: CsvColumn<Row>[] = [
    { header: "Product", key: "product_name" },
    { header: "Quantity Sold", key: "quantity_sold" },
    { header: "Total Revenue", key: "total_revenue" },
    { header: "Average Price", key: "average_price" },
  ];
  const monthCols: CsvColumn<Row>[] = data.months.map((m, i) => ({
    header: `Units ${m}`,
    key: `_month_${i}`,
    formatter: (_v, row) => String(row.monthly_quantities[i] ?? 0),
  }));
  const cols = [...baseCols, ...monthCols];
  const date = todayIso();
  const headers = csvHeaders(`revenue-by-product-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data.rows as Row[], cols));
});

reports.get("/expenses-by-category", (c) => {
  const data = reportService.getExpensesByCategory({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  return c.json({ success: true, data });
});

reports.get("/expenses-by-category/csv", (c) => {
  const data = reportService.getExpensesByCategory({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  const cols: CsvColumn<(typeof data.rows)[number]>[] = [
    { header: "Category", key: "category" },
    { header: "Count", key: "count" },
    { header: "Total", key: "total" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`expenses-by-category-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data.rows, cols));
});

reports.get("/profit-loss", (c) => {
  const data = reportService.getProfitAndLoss({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  return c.json({ success: true, data });
});

reports.get("/profit-loss/csv", (c) => {
  const data = reportService.getProfitAndLoss({
    date_from: c.req.query("date_from"),
    date_to: c.req.query("date_to"),
  });
  const cols: CsvColumn<(typeof data.months)[number]>[] = [
    { header: "Month", key: "month" },
    { header: "Revenue", key: "revenue" },
    { header: "Expenses", key: "expenses" },
    { header: "Net Income", key: "net" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`profit-loss-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data.months, cols));
});

reports.get("/cash-flow-forecast", (c) => {
  const monthsParam = parseInt(c.req.query("months") || "6", 10);
  const months = Math.min(Math.max(Number.isFinite(monthsParam) ? monthsParam : 6, 1), 24);
  const data = reportService.getCashFlowForecast(months);
  return c.json({ success: true, data });
});

reports.get("/cash-flow-forecast/csv", (c) => {
  const monthsParam = parseInt(c.req.query("months") || "6", 10);
  const months = Math.min(Math.max(Number.isFinite(monthsParam) ? monthsParam : 6, 1), 24);
  const data = reportService.getCashFlowForecast(months);
  const cols: CsvColumn<(typeof data)[number]>[] = [
    { header: "Month", key: "month" },
    { header: "Outstanding Invoices", key: "expected_invoiced" },
    { header: "Recurring Invoices", key: "expected_recurring" },
    { header: "Total Expected", key: "total" },
  ];
  const date = todayIso();
  const headers = csvHeaders(`cash-flow-forecast-${date}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(data, cols));
});

// Cash-basis EÜR for one calendar year; `year` defaults to the current one.
function parseEuerYear(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return new Date().getFullYear();
  const year = Number.parseInt(raw, 10);
  if (!Number.isInteger(year) || year < 1970 || year > 2200) return null;
  return year;
}

reports.get("/euer", (c) => {
  const year = parseEuerYear(c.req.query("year"));
  if (year === null) return c.json({ success: false, error: "Invalid year" }, 400);
  return c.json({ success: true, data: reportService.getEuerReport({ year }) });
});

reports.get("/euer/csv", (c) => {
  const year = parseEuerYear(c.req.query("year"));
  if (year === null) return c.json({ success: false, error: "Invalid year" }, 400);
  const data = reportService.getEuerReport({ year });
  type Row = { line: string; amount: number };
  const rows: Row[] = data.kleinunternehmer
    ? [{ line: "Betriebseinnahmen (Kleinunternehmer, brutto)", amount: data.receipts.gross }]
    : [
        { line: "Betriebseinnahmen (netto)", amount: data.receipts.net },
        { line: "Vereinnahmte Umsatzsteuer", amount: data.receipts.vat },
      ];
  for (const r of data.expenses.by_category) {
    rows.push({
      line: `Betriebsausgaben: ${r.category || "Ohne Kategorie"}`,
      amount: data.kleinunternehmer ? r.gross : r.net,
    });
  }
  if (!data.kleinunternehmer) {
    rows.push({ line: "Gezahlte Vorsteuer", amount: data.expenses.vat });
  }
  rows.push({
    line: "Summe Betriebsausgaben",
    amount: data.kleinunternehmer ? data.expenses.gross : data.expenses.net,
  });
  rows.push({ line: "Gewinn", amount: data.profit });
  const cols: CsvColumn<Row>[] = [
    { header: "Position", key: "line" },
    { header: `Betrag (${data.base_currency})`, key: "amount" },
  ];
  const headers = csvHeaders(`euer-${year}.csv`);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(buildCsv(rows, cols));
});

export { reports };
