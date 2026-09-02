import { getDb } from "../database/connection";
import { extraTaxOnSideIncome } from "../utils/income-tax";
import { getBaseCurrency } from "./exchange-rate.service";
import { getSetting } from "./settings.service";

/** YYYY-MM keys for the trailing 12 months ending at the current month. */
function trailingMonthKeys(): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

/** Map per-month rows to a dense 12-element series, filling missing months with 0. */
function densifyMonthly(rows: { month: string; value: number }[]): {
  keys: string[];
  values: number[];
} {
  const keys = trailingMonthKeys();
  const byMonth = new Map(rows.map((r) => [r.month, r.value]));
  return { keys, values: keys.map((k) => byMonth.get(k) ?? 0) };
}

/** Month-over-month percentage change. Returns 0 when both are 0; 100 when going from 0 to a positive value. */
function deltaPct(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** German Arbeitnehmer-Pauschbetrag, subtracted from the configured gross
 *  salary as a rough zvE proxy for the tariff-based reserve estimate. */
const EMPLOYEE_ALLOWANCE = 1_230;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** § 19 Abs. 1 UStG (2025): Kleinunternehmer limits on gross receipts. */
const SMALL_BUSINESS_LIMIT_PREVIOUS_YEAR = 25_000;
const SMALL_BUSINESS_LIMIT_CURRENT_YEAR = 100_000;

const isoDate = (year: number, monthIndex: number): string =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;

/**
 * Estimated tax reserve for the dashboard: the VAT balance of the current
 * quarter (cash basis: VAT share of payments received minus input VAT on
 * expenses) plus an income-tax estimate on the year-to-date net profit —
 * either via the German 2025 tariff on top of a configured salary, or a flat
 * percentage when no salary is set. All amounts in base currency.
 */
export function getTaxReserve(now: Date = new Date()) {
  const db = getDb();
  const year = now.getFullYear();
  const quarterIndex = Math.floor(now.getMonth() / 3);
  const quarterStart = isoDate(year, quarterIndex * 3);
  const quarterEnd =
    quarterIndex === 3 ? isoDate(year + 1, 0) : isoDate(year, (quarterIndex + 1) * 3);
  const yearStart = isoDate(year, 0);
  const yearEnd = isoDate(year + 1, 0);
  const previousYearStart = isoDate(year - 1, 0);

  // Each payment carries its invoice's VAT proportionally (Ist-Versteuerung).
  const paymentShares = db.query(
    `SELECT
       COALESCE(SUM(p.amount * (i.tax_total / i.total) * COALESCE(i.exchange_rate, 1)), 0) as vat,
       COALESCE(SUM(p.amount * ((i.total - i.tax_total) / i.total) * COALESCE(i.exchange_rate, 1)), 0) as net
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE i.deleted_at IS NULL AND i.total != 0
       AND p.payment_date >= ? AND p.payment_date < ?`,
  );
  const expenseSums = db.query(
    `SELECT
       COALESCE(SUM(tax_amount * COALESCE(exchange_rate, 1)), 0) as vat,
       COALESCE(SUM(amount * COALESCE(exchange_rate, 1)), 0) as net
     FROM expenses
     WHERE expense_date >= ? AND expense_date < ?`,
  );

  // § 19 UStG measures the Gesamtumsatz by gross receipts (vereinnahmte
  // Entgelte); the 2025 limits are 25.000 € for the previous and 100.000 € for
  // the current calendar year.
  const grossReceipts = db.query(
    `SELECT COALESCE(SUM(p.amount * COALESCE(i.exchange_rate, 1)), 0) as gross
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE i.deleted_at IS NULL AND p.payment_date >= ? AND p.payment_date < ?`,
  );
  const previousYearGross = grossReceipts.get(previousYearStart, yearStart) as { gross: number };
  const currentYearGross = grossReceipts.get(yearStart, yearEnd) as { gross: number };

  const quarterIn = paymentShares.get(quarterStart, quarterEnd) as { vat: number; net: number };
  const quarterOut = expenseSums.get(quarterStart, quarterEnd) as { vat: number; net: number };
  const yearIn = paymentShares.get(yearStart, yearEnd) as { vat: number; net: number };
  const yearOut = expenseSums.get(yearStart, yearEnd) as { vat: number; net: number };

  const vatReserve = round2(quarterIn.vat - quarterOut.vat);
  const netProfitYtd = yearIn.net - yearOut.net;
  const profitYtd = Math.max(0, netProfitYtd);

  const salary = Number.parseFloat(getSetting("tax_reserve_annual_salary") || "");
  const joint = getSetting("tax_reserve_joint_assessment") === "true";
  const rateSetting = Number.parseFloat(getSetting("tax_reserve_income_rate") || "");
  const flatRate = Number.isFinite(rateSetting) ? rateSetting : 30;

  const mode: "tariff" | "flat" = Number.isFinite(salary) && salary > 0 ? "tariff" : "flat";
  const incomeTaxReserve =
    mode === "tariff"
      ? extraTaxOnSideIncome(Math.max(0, salary - EMPLOYEE_ALLOWANCE), profitYtd, joint)
      : round2((profitYtd * flatRate) / 100);

  return {
    vat_reserve: vatReserve,
    income_tax_reserve: incomeTaxReserve,
    profit_ytd: round2(netProfitYtd),
    total: round2(vatReserve + incomeTaxReserve),
    mode,
    flat_rate: flatRate,
    kleinunternehmer: getSetting("einvoice_kleinunternehmer") === "true",
    quarter: `${year}-Q${quarterIndex + 1}`,
    small_business: {
      previous_year: {
        year: year - 1,
        revenue: round2(previousYearGross.gross),
        limit: SMALL_BUSINESS_LIMIT_PREVIOUS_YEAR,
      },
      current_year: {
        year,
        revenue: round2(currentYearGross.gross),
        limit: SMALL_BUSINESS_LIMIT_CURRENT_YEAR,
      },
    },
  };
}

export function getStats() {
  const db = getDb();

  // All monetary aggregates are consolidated into the base currency via each
  // row's frozen exchange_rate (1 for same-as-base rows), so mixed-currency
  // installs get a meaningful single total instead of summing raw amounts.
  const baseCurrency = getBaseCurrency();

  // Revenue includes paid credit notes (negative totals subtract automatically)
  const revenue = db
    .query(
      "SELECT COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as total FROM invoices WHERE status IN ('paid', 'complete') AND deleted_at IS NULL",
    )
    .get() as { total: number };

  const outstanding = db
    .query(
      "SELECT COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as total FROM invoices WHERE status IN ('sent', 'overdue') AND deleted_at IS NULL",
    )
    .get() as { total: number };

  // Status counts for invoices only (exclude credit notes)
  const statusCounts = db
    .query(
      "SELECT status, COUNT(*) as count FROM invoices WHERE deleted_at IS NULL AND (type = 'invoice' OR type IS NULL) GROUP BY status",
    )
    .all() as { status: string; count: number }[];

  const creditNoteStats = db
    .query(
      "SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'credit_note' AND deleted_at IS NULL",
    )
    .get() as { count: number; total: number };

  // Total expenses (all-time) for the net-income figure. Revenue uses paid
  // invoices above, so net income = realised revenue − all recorded expenses.
  const expenses = db
    .query("SELECT COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as total FROM expenses")
    .get() as {
    total: number;
  };

  const customerCount = db.query("SELECT COUNT(*) as count FROM customers").get() as {
    count: number;
  };
  const productCount = db
    .query("SELECT COUNT(*) as count FROM products WHERE is_active = 1")
    .get() as { count: number };

  // Per-month trends for the last 12 months, used for sparklines on stat cards.
  // Each metric uses a per-period aggregation so the sparkline tells a story
  // (when did revenue spike? when did outstanding pile up?).
  const revenuePerMonth = db
    .query(
      `SELECT strftime('%Y-%m', issue_date) as month, COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as value
       FROM invoices
       WHERE status IN ('paid', 'complete') AND deleted_at IS NULL
         AND issue_date >= date('now', '-12 months')
       GROUP BY month`,
    )
    .all() as { month: string; value: number }[];
  const outstandingPerMonth = db
    .query(
      `SELECT strftime('%Y-%m', issue_date) as month, COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as value
       FROM invoices
       WHERE status IN ('sent', 'overdue') AND deleted_at IS NULL
         AND issue_date >= date('now', '-12 months')
       GROUP BY month`,
    )
    .all() as { month: string; value: number }[];
  const invoicesPerMonth = db
    .query(
      `SELECT strftime('%Y-%m', issue_date) as month, COUNT(*) as value
       FROM invoices
       WHERE deleted_at IS NULL AND (type = 'invoice' OR type IS NULL)
         AND issue_date >= date('now', '-12 months')
       GROUP BY month`,
    )
    .all() as { month: string; value: number }[];
  const customersPerMonth = db
    .query(
      `SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as value
       FROM customers
       WHERE created_at >= date('now', '-12 months')
       GROUP BY month`,
    )
    .all() as { month: string; value: number }[];

  const revenueSeries = densifyMonthly(revenuePerMonth);
  const outstandingSeries = densifyMonthly(outstandingPerMonth);
  const invoicesSeries = densifyMonthly(invoicesPerMonth);
  const customersSeries = densifyMonthly(customersPerMonth);

  // Compute month-over-month deltas from the last two points of each series.
  function lastTwo(values: number[]): { current: number; previous: number } {
    return { current: values[values.length - 1] ?? 0, previous: values[values.length - 2] ?? 0 };
  }
  const r = lastTwo(revenueSeries.values);
  const o = lastTwo(outstandingSeries.values);
  const i = lastTwo(invoicesSeries.values);
  const c = lastTwo(customersSeries.values);

  return {
    base_currency: baseCurrency,
    tax_reserve: getTaxReserve(),
    total_revenue: revenue.total,
    total_outstanding: outstanding.total,
    total_expenses: expenses.total,
    net_income: revenue.total - expenses.total,
    invoice_counts: Object.fromEntries(statusCounts.map((row) => [row.status, row.count])),
    total_invoices: statusCounts.reduce((sum, row) => sum + row.count, 0),
    total_credit_notes: creditNoteStats.count,
    total_credit_note_value: creditNoteStats.total,
    total_customers: customerCount.count,
    total_products: productCount.count,
    trends: {
      total_revenue: revenueSeries.values,
      total_outstanding: outstandingSeries.values,
      total_invoices: invoicesSeries.values,
      total_customers: customersSeries.values,
    },
    deltas: {
      total_revenue: deltaPct(r.current, r.previous),
      total_outstanding: deltaPct(o.current, o.previous),
      total_invoices: deltaPct(i.current, i.previous),
      total_customers: deltaPct(c.current, c.previous),
    },
  };
}

export function getRevenueChart(compareYoy = false) {
  const db = getDb();
  // Include paid credit notes (negative totals subtract from revenue)
  const rows = db
    .query(`
    SELECT strftime('%Y-%m', issue_date) as month, COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as revenue
    FROM invoices WHERE status IN ('paid', 'complete') AND deleted_at IS NULL AND issue_date >= date('now', '-12 months')
    GROUP BY month ORDER BY month
  `)
    .all() as { month: string; revenue: number }[];

  const byMonth = new Map(rows.map((r) => [r.month, r.revenue]));
  const series: { month: string; revenue: number; previous_revenue?: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    series.push({ month: key, revenue: byMonth.get(key) ?? 0 });
  }

  if (!compareYoy) return series;

  // Pull prior-year revenue spanning 12-23 months back, then map each current
  // month to the same calendar month one year earlier.
  const prevRows = db
    .query(`
    SELECT strftime('%Y-%m', issue_date) as month, COALESCE(SUM(total * COALESCE(exchange_rate, 1)), 0) as revenue
    FROM invoices WHERE status IN ('paid', 'complete') AND deleted_at IS NULL
      AND issue_date >= date('now', '-24 months')
      AND issue_date < date('now', '-12 months')
    GROUP BY month
  `)
    .all() as { month: string; revenue: number }[];
  const byPrevMonth = new Map(prevRows.map((r) => [r.month, r.revenue]));
  for (const point of series) {
    const [y, m] = point.month.split("-");
    const prevKey = `${Number(y) - 1}-${m}`;
    point.previous_revenue = byPrevMonth.get(prevKey) ?? 0;
  }
  return series;
}

export function getTopCustomersByRevenue(limit = 5) {
  const db = getDb();
  return db
    .query(
      `SELECT c.id, c.name,
              COUNT(i.id) as invoice_count,
              COALESCE(SUM(i.amount_paid * COALESCE(i.exchange_rate, 1)), 0) as total_revenue
       FROM customers c
       JOIN invoices i ON i.customer_id = c.id
       WHERE i.deleted_at IS NULL
         AND (i.type = 'invoice' OR i.type IS NULL)
         AND i.status IN ('paid', 'partially_paid')
       GROUP BY c.id
       HAVING total_revenue > 0
       ORDER BY total_revenue DESC
       LIMIT ?`,
    )
    .all(limit) as { id: string; name: string; invoice_count: number; total_revenue: number }[];
}

export function getRecentInvoices() {
  const db = getDb();
  return db
    .query(`
    SELECT i.id, i.invoice_number, i.status, i.total, i.issue_date, i.due_date, i.currency,
           c.name as customer_name
    FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
    WHERE i.deleted_at IS NULL AND (i.type = 'invoice' OR i.type IS NULL)
    ORDER BY i.created_at DESC LIMIT 5
  `)
    .all();
}
