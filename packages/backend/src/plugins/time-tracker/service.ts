// Time Tracker business logic. Direct SQL against the (tenant-bound) DB,
// mirroring OSS service conventions: prepared statements, plain SQL, no ORM.
// Entry data is user-owned: non-admins may only see and modify their own
// entries. Projects are shared team objects; mutations are admin-only at the
// route layer.

import { getDb } from "../../database/connection";
import { createInvoice } from "../../services/invoice.service";
import type { InvoiceWithItems } from "../../types/invoice";

export interface Actor {
  userId: string;
  isAdmin: boolean;
}

// --- Edit guard (extension seam) --------------------------------------------

export interface TimeEntryEditGuardInput {
  entry: TtTimeEntry;
  actor: Actor;
}

/**
 * Optional guard consulted before any entry mutation. Returns an error message
 * to reject the edit, or null to allow. Overlays (e.g. cloud timesheet
 * approvals) install a guard via setTimeEntryEditGuard; OSS default allows all.
 */
export type TimeEntryEditGuard = (input: TimeEntryEditGuardInput) => string | null;

let editGuard: TimeEntryEditGuard | null = null;

export function setTimeEntryEditGuard(guard: TimeEntryEditGuard | null): void {
  editGuard = guard;
}

function assertEditAllowed(entry: TtTimeEntry, actor: Actor): void {
  if (editGuard) {
    const error = editGuard({ entry, actor });
    if (error) throw new Error(error);
  }
}

export interface TtProject {
  id: string;
  name: string;
  customer_id: string | null;
  default_rate: number | null;
  billable: number;
  color: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

export interface TtTimeEntry {
  id: string;
  project_id: string;
  description: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  rate: number | null;
  billable: number;
  is_billed: number;
  invoice_id: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

const nowIso = () => new Date().toISOString();

// --- Projects ---------------------------------------------------------------

export function listProjects(includeArchived = false): TtProject[] {
  const db = getDb();
  const where = includeArchived ? "" : "WHERE is_archived = 0";
  return db
    .query(`SELECT * FROM tt_projects ${where} ORDER BY name COLLATE NOCASE`)
    .all() as TtProject[];
}

export interface ProjectInput {
  name: string;
  customer_id?: string | null;
  default_rate?: number | null;
  billable?: boolean;
  color?: string | null;
  is_archived?: boolean;
}

export function createProject(input: ProjectInput): TtProject {
  const db = getDb();
  const id = crypto.randomUUID().replace(/-/g, "");
  db.run(
    `INSERT INTO tt_projects (id, name, customer_id, default_rate, billable, color, is_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.customer_id ?? null,
      input.default_rate ?? null,
      input.billable === false ? 0 : 1,
      input.color ?? null,
      input.is_archived ? 1 : 0,
    ],
  );
  return getProject(id) as TtProject;
}

export function getProject(id: string): TtProject | null {
  const db = getDb();
  return (db.query("SELECT * FROM tt_projects WHERE id = ?").get(id) as TtProject) ?? null;
}

export function updateProject(id: string, input: ProjectInput): TtProject | null {
  const existing = getProject(id);
  if (!existing) return null;
  const db = getDb();
  db.run(
    `UPDATE tt_projects
       SET name = ?, customer_id = ?, default_rate = ?, billable = ?, color = ?,
           is_archived = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      input.name ?? existing.name,
      input.customer_id !== undefined ? input.customer_id : existing.customer_id,
      input.default_rate !== undefined ? input.default_rate : existing.default_rate,
      input.billable !== undefined ? (input.billable ? 1 : 0) : existing.billable,
      input.color !== undefined ? input.color : existing.color,
      input.is_archived !== undefined ? (input.is_archived ? 1 : 0) : existing.is_archived,
      id,
    ],
  );
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const db = getDb();
  const res = db.run("DELETE FROM tt_projects WHERE id = ?", [id]);
  return res.changes > 0;
}

// --- Entries ----------------------------------------------------------------

export interface EntryFilters {
  project_id?: string;
  billed?: boolean;
  from?: string;
  to?: string;
  user_id?: string;
}

export type TtTimeEntryWithProject = TtTimeEntry & { project_name: string };

export function listEntries(actor: Actor, filters: EntryFilters = {}): TtTimeEntryWithProject[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  // Non-admins are hard-scoped to their own entries; admins may filter by user.
  if (!actor.isAdmin) {
    conditions.push("e.user_id = ?");
    params.push(actor.userId);
  } else if (filters.user_id) {
    conditions.push("e.user_id = ?");
    params.push(filters.user_id);
  }
  if (filters.project_id) {
    conditions.push("e.project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.billed !== undefined) {
    conditions.push("e.is_billed = ?");
    params.push(filters.billed ? 1 : 0);
  }
  if (filters.from) {
    conditions.push("e.started_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("e.started_at <= ?");
    params.push(filters.to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .query(
      `SELECT e.*, p.name as project_name
         FROM tt_time_entries e JOIN tt_projects p ON e.project_id = p.id
         ${where}
         ORDER BY e.started_at DESC`,
    )
    .all(...params) as TtTimeEntryWithProject[];
}

export function getEntry(id: string): TtTimeEntry | null {
  const db = getDb();
  return (db.query("SELECT * FROM tt_time_entries WHERE id = ?").get(id) as TtTimeEntry) ?? null;
}

export interface ManualEntryInput {
  project_id: string;
  description?: string | null;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  rate?: number | null;
  billable?: boolean;
}

/** Normalize ended_at/duration: derive whichever is missing from the other. */
function normalizeDuration(
  startedAt: string,
  endedAt?: string | null,
  durationSeconds?: number | null,
): { ended_at: string | null; duration_seconds: number | null } {
  if (endedAt) {
    const secs = Math.max(
      0,
      Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
    );
    return { ended_at: endedAt, duration_seconds: durationSeconds ?? secs };
  }
  if (durationSeconds != null) {
    const ended = new Date(new Date(startedAt).getTime() + durationSeconds * 1000).toISOString();
    return { ended_at: ended, duration_seconds: durationSeconds };
  }
  return { ended_at: null, duration_seconds: null };
}

export function createEntry(userId: string, input: ManualEntryInput): TtTimeEntry {
  const db = getDb();
  const project = getProject(input.project_id);
  if (!project) throw new Error("Project not found");
  const id = crypto.randomUUID().replace(/-/g, "");
  const { ended_at, duration_seconds } = normalizeDuration(
    input.started_at,
    input.ended_at,
    input.duration_seconds,
  );
  const billable = input.billable !== undefined ? (input.billable ? 1 : 0) : project.billable;
  db.run(
    `INSERT INTO tt_time_entries
       (id, project_id, description, started_at, ended_at, duration_seconds, rate, billable, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.project_id,
      input.description ?? null,
      input.started_at,
      ended_at,
      duration_seconds,
      input.rate ?? null,
      billable,
      userId,
    ],
  );
  return getEntry(id) as TtTimeEntry;
}

export interface EntryUpdateInput {
  project_id?: string;
  description?: string | null;
  started_at?: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  rate?: number | null;
  billable?: boolean;
}

export function updateEntry(actor: Actor, id: string, input: EntryUpdateInput): TtTimeEntry | null {
  const existing = getEntry(id);
  if (!existing) return null;
  if (!actor.isAdmin && existing.user_id !== actor.userId) return null;
  const blocked = editGuard?.({ entry: existing, actor });
  if (blocked) throw new Error(blocked);
  const db = getDb();
  const startedAt = input.started_at ?? existing.started_at;
  const { ended_at, duration_seconds } =
    input.ended_at !== undefined || input.duration_seconds !== undefined || input.started_at
      ? normalizeDuration(
          startedAt,
          input.ended_at !== undefined ? input.ended_at : existing.ended_at,
          input.duration_seconds !== undefined ? input.duration_seconds : existing.duration_seconds,
        )
      : { ended_at: existing.ended_at, duration_seconds: existing.duration_seconds };
  db.run(
    `UPDATE tt_time_entries
       SET project_id = ?, description = ?, started_at = ?, ended_at = ?,
           duration_seconds = ?, rate = ?, billable = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      input.project_id ?? existing.project_id,
      input.description !== undefined ? input.description : existing.description,
      startedAt,
      ended_at,
      duration_seconds,
      input.rate !== undefined ? input.rate : existing.rate,
      input.billable !== undefined ? (input.billable ? 1 : 0) : existing.billable,
      id,
    ],
  );
  return getEntry(id);
}

export function deleteEntry(actor: Actor, id: string): boolean {
  const existing = getEntry(id);
  if (!existing) return false;
  if (!actor.isAdmin && existing.user_id !== actor.userId) return false;
  const blocked = editGuard?.({ entry: existing, actor });
  if (blocked) throw new Error(blocked);
  const db = getDb();
  const res = db.run("DELETE FROM tt_time_entries WHERE id = ?", [id]);
  return res.changes > 0;
}

// --- Timer ------------------------------------------------------------------

export function getActiveTimer(userId: string): TtTimeEntryWithProject | null {
  const db = getDb();
  return (
    (db
      .query(
        `SELECT e.*, p.name as project_name
           FROM tt_time_entries e JOIN tt_projects p ON e.project_id = p.id
           WHERE e.user_id = ? AND e.ended_at IS NULL
           ORDER BY e.started_at DESC LIMIT 1`,
      )
      .get(userId) as TtTimeEntryWithProject) ?? null
  );
}

export interface TimerStartInput {
  project_id: string;
  description?: string | null;
  rate?: number | null;
}

/** One running timer per user. Throws if one is already active. */
export function startTimer(userId: string, input: TimerStartInput): TtTimeEntry {
  if (getActiveTimer(userId)) throw new Error("A timer is already running");
  const project = getProject(input.project_id);
  if (!project) throw new Error("Project not found");
  const db = getDb();
  const id = crypto.randomUUID().replace(/-/g, "");
  db.run(
    `INSERT INTO tt_time_entries
       (id, project_id, description, started_at, rate, billable, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.project_id,
      input.description ?? null,
      nowIso(),
      input.rate ?? null,
      project.billable,
      userId,
    ],
  );
  return getEntry(id) as TtTimeEntry;
}

export function stopTimer(userId: string): TtTimeEntry | null {
  const active = getActiveTimer(userId);
  if (!active) return null;
  const db = getDb();
  const endedAt = nowIso();
  const seconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(active.started_at).getTime()) / 1000),
  );
  db.run(
    `UPDATE tt_time_entries
       SET ended_at = ?, duration_seconds = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [endedAt, seconds, active.id],
  );
  return getEntry(active.id);
}

// --- Summary ----------------------------------------------------------------

export interface SummaryRow {
  project_id: string;
  project_name: string;
  customer_id: string | null;
  total_seconds: number;
  billable_seconds: number;
  unbilled_seconds: number;
  unbilled_amount: number;
}

export function getSummary(actor: Actor, filters: EntryFilters = {}): SummaryRow[] {
  const db = getDb();
  const conditions: string[] = ["e.duration_seconds IS NOT NULL"];
  const params: (string | number)[] = [];
  if (!actor.isAdmin) {
    conditions.push("e.user_id = ?");
    params.push(actor.userId);
  }
  if (filters.project_id) {
    conditions.push("e.project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.from) {
    conditions.push("e.started_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("e.started_at <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  return db
    .query(
      `SELECT p.id as project_id, p.name as project_name, p.customer_id,
              SUM(e.duration_seconds) as total_seconds,
              SUM(CASE WHEN e.billable = 1 THEN e.duration_seconds ELSE 0 END) as billable_seconds,
              SUM(CASE WHEN e.billable = 1 AND e.is_billed = 0 THEN e.duration_seconds ELSE 0 END) as unbilled_seconds,
              SUM(CASE WHEN e.billable = 1 AND e.is_billed = 0
                       THEN (e.duration_seconds / 3600.0) * COALESCE(e.rate, p.default_rate, 0)
                       ELSE 0 END) as unbilled_amount
         FROM tt_time_entries e JOIN tt_projects p ON e.project_id = p.id
         ${where}
         GROUP BY p.id
         ORDER BY p.name COLLATE NOCASE`,
    )
    .all(...params) as SummaryRow[];
}

// --- Invoice from unbilled time ---------------------------------------------

export interface InvoiceFromTimeInput {
  customer_id: string;
  project_id?: string;
  from?: string;
  to?: string;
  issue_date?: string;
}

export interface InvoiceFromTimeResult {
  invoice: InvoiceWithItems;
  entry_count: number;
}

/**
 * Aggregate a customer's unbilled, billable time into a draft invoice (one line
 * per project + rate), then mark those entries billed and link the invoice.
 * Reuses the OSS createInvoice() so totals/tax/numbering follow core rules.
 */
export function createInvoiceFromUnbilled(
  input: InvoiceFromTimeInput,
): InvoiceFromTimeResult | null {
  const db = getDb();
  const conditions = [
    "e.is_billed = 0",
    "e.billable = 1",
    "e.duration_seconds IS NOT NULL",
    "p.customer_id = ?",
  ];
  const params: (string | number)[] = [input.customer_id];
  if (input.project_id) {
    conditions.push("e.project_id = ?");
    params.push(input.project_id);
  }
  if (input.from) {
    conditions.push("e.started_at >= ?");
    params.push(input.from);
  }
  if (input.to) {
    conditions.push("e.started_at <= ?");
    params.push(input.to);
  }

  const rows = db
    .query(
      `SELECT e.id, e.project_id, e.duration_seconds,
              COALESCE(e.rate, p.default_rate, 0) as eff_rate,
              p.name as project_name
         FROM tt_time_entries e JOIN tt_projects p ON e.project_id = p.id
         WHERE ${conditions.join(" AND ")}`,
    )
    .all(...params) as {
    id: string;
    project_id: string;
    duration_seconds: number;
    eff_rate: number;
    project_name: string;
  }[];

  if (rows.length === 0) return null;

  // Group by project + effective rate so distinct rates bill as separate lines.
  const groups = new Map<
    string,
    { project_name: string; rate: number; seconds: number; ids: string[] }
  >();
  for (const r of rows) {
    const key = `${r.project_id}|${r.eff_rate}`;
    const g = groups.get(key) ?? {
      project_name: r.project_name,
      rate: r.eff_rate,
      seconds: 0,
      ids: [],
    };
    g.seconds += r.duration_seconds;
    g.ids.push(r.id);
    groups.set(key, g);
  }

  const items = [...groups.values()].map((g) => ({
    description: g.project_name,
    quantity: Math.round((g.seconds / 3600) * 100) / 100,
    unit_price: g.rate,
    unit: "hour",
  }));

  const issueDate = input.issue_date ?? nowIso().slice(0, 10);
  const invoice = createInvoice({
    customer_id: input.customer_id,
    issue_date: issueDate,
    items,
  });

  const entryIds = rows.map((r) => r.id);
  const placeholders = entryIds.map(() => "?").join(", ");
  db.run(
    `UPDATE tt_time_entries
       SET is_billed = 1, invoice_id = ?, updated_at = datetime('now')
     WHERE id IN (${placeholders})`,
    [invoice.id, ...entryIds],
  );

  return { invoice, entry_count: entryIds.length };
}
