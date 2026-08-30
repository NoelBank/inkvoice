// Typed client for the Time Tracker plugin API (/api/v1/plugins/time-tracker).

import { pluginFetch } from "../api";

const BASE = "/plugins/time-tracker";

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
  project_name: string;
  description: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  rate: number | null;
  billable: number;
  is_billed: number;
  invoice_id: string | null;
  user_id: string;
}

export interface TtSummaryRow {
  project_id: string;
  project_name: string;
  customer_id: string | null;
  total_seconds: number;
  billable_seconds: number;
  unbilled_seconds: number;
  unbilled_amount: number;
}

export interface ProjectInput {
  name: string;
  customer_id?: string | null;
  default_rate?: number | null;
  billable?: boolean;
  color?: string | null;
  is_archived?: boolean;
}

export interface EntryFilters {
  project_id?: string;
  billed?: boolean;
  from?: string;
  to?: string;
  /** Admin-only server-side filter; ignored for non-admin callers. */
  user_id?: string;
}

export interface EntryInput {
  project_id: string;
  description?: string | null;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  rate?: number | null;
  billable?: boolean;
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [
    string,
    string,
  ][];
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

export const ttApi = {
  listProjects: (includeArchived = false) =>
    pluginFetch<{ data: TtProject[] }>(
      `${BASE}/projects${includeArchived ? "?include_archived=true" : ""}`,
    ).then((r) => r.data),
  createProject: (input: ProjectInput) =>
    pluginFetch<{ data: TtProject }>(`${BASE}/projects`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.data),
  updateProject: (id: string, input: Partial<ProjectInput>) =>
    pluginFetch<{ data: TtProject }>(`${BASE}/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.data),
  deleteProject: (id: string) => pluginFetch(`${BASE}/projects/${id}`, { method: "DELETE" }),

  listEntries: (filters: EntryFilters = {}) =>
    pluginFetch<{ data: TtTimeEntry[] }>(
      `${BASE}/entries${qs({
        project_id: filters.project_id,
        billed: filters.billed === undefined ? undefined : String(filters.billed),
        from: filters.from,
        to: filters.to,
        user_id: filters.user_id,
      })}`,
    ).then((r) => r.data),
  createEntry: (input: EntryInput) =>
    pluginFetch<{ data: TtTimeEntry }>(`${BASE}/entries`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.data),
  updateEntry: (id: string, input: Partial<EntryInput>) =>
    pluginFetch<{ data: TtTimeEntry }>(`${BASE}/entries/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.data),
  deleteEntry: (id: string) => pluginFetch(`${BASE}/entries/${id}`, { method: "DELETE" }),

  activeTimer: () =>
    pluginFetch<{ data: TtTimeEntry | null }>(`${BASE}/timer/active`).then((r) => r.data),
  startTimer: (input: { project_id: string; description?: string | null }) =>
    pluginFetch<{ data: TtTimeEntry }>(`${BASE}/timer/start`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.data),
  stopTimer: () =>
    pluginFetch<{ data: TtTimeEntry }>(`${BASE}/timer/stop`, { method: "POST" }).then(
      (r) => r.data,
    ),

  summary: (filters: EntryFilters = {}) =>
    pluginFetch<{ data: TtSummaryRow[] }>(
      `${BASE}/summary${qs({ project_id: filters.project_id, from: filters.from, to: filters.to })}`,
    ).then((r) => r.data),

  createInvoice: (input: {
    customer_id: string;
    project_id?: string;
    from?: string;
    to?: string;
  }) =>
    pluginFetch<{ data: { invoice: { id: string }; entry_count: number } }>(`${BASE}/invoice`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.data),
};
