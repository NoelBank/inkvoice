// Time Tracker plugin: projects, per-user time entries and timer, summaries,
// and invoice-from-unbilled-time. Mounted at /api/v1/plugins/time-tracker.
// Ownership model: non-admins see and manage only their own entries; projects
// are shared read, admin-only write; billing time into an invoice requires the
// core invoices:create permission.

import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth";
import { registerBackendPlugin } from "../registry";
import { timeTrackerMigrations } from "./migrations";
import * as svc from "./service";

const routes = new Hono();

const ok = (data: unknown) => ({ success: true as const, data });

function actor(c: { get: (k: string) => unknown }): svc.Actor {
  const user = c.get("user") as { sub: string; is_admin: boolean } | undefined;
  return { userId: user?.sub ?? "", isAdmin: !!user?.is_admin };
}

function isAdmin(c: { get: (k: string) => unknown }): boolean {
  return !!(c.get("user") as { is_admin?: boolean } | undefined)?.is_admin;
}

// --- Projects ---------------------------------------------------------------

const projectSchema = z.object({
  name: z.string().min(1),
  customer_id: z.string().nullable().optional(),
  default_rate: z.number().nonnegative().nullable().optional(),
  billable: z.boolean().optional(),
  color: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
});

routes.get("/projects", (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  return c.json(ok(svc.listProjects(includeArchived)));
});

routes.post("/projects", async (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const parsed = projectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid project" }, 400);
  return c.json(ok(svc.createProject(parsed.data)), 201);
});

routes.put("/projects/:id", async (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const parsed = projectSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid project" }, 400);
  const updated = svc.updateProject(c.req.param("id"), parsed.data as svc.ProjectInput);
  if (!updated) return c.json({ success: false, error: "Project not found" }, 404);
  return c.json(ok(updated));
});

routes.delete("/projects/:id", (c) => {
  if (!isAdmin(c)) return c.json({ success: false, error: "Forbidden" }, 403);
  const removed = svc.deleteProject(c.req.param("id"));
  if (!removed) return c.json({ success: false, error: "Project not found" }, 404);
  return c.json(ok({ id: c.req.param("id") }));
});

// --- Entries ----------------------------------------------------------------

const entrySchema = z.object({
  project_id: z.string().min(1),
  description: z.string().nullable().optional(),
  started_at: z.string().min(1),
  ended_at: z.string().nullable().optional(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  rate: z.number().nonnegative().nullable().optional(),
  billable: z.boolean().optional(),
});

routes.get("/entries", (c) => {
  const billedParam = c.req.query("billed");
  const act = actor(c);
  const userIdFilter = isAdmin(c) ? c.req.query("user_id") || undefined : undefined;
  return c.json(
    ok(
      svc.listEntries(act, {
        user_id: userIdFilter,
        project_id: c.req.query("project_id") || undefined,
        billed: billedParam === undefined ? undefined : billedParam === "true",
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    ),
  );
});

routes.post("/entries", async (c) => {
  const parsed = entrySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid entry" }, 400);
  try {
    return c.json(ok(svc.createEntry(actor(c).userId, parsed.data)), 201);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }
});

routes.put("/entries/:id", async (c) => {
  const parsed = entrySchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid entry" }, 400);
  try {
    const updated = svc.updateEntry(
      actor(c),
      c.req.param("id"),
      parsed.data as svc.EntryUpdateInput,
    );
    if (!updated) return c.json({ success: false, error: "Entry not found" }, 404);
    return c.json(ok(updated));
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

routes.delete("/entries/:id", (c) => {
  try {
    const removed = svc.deleteEntry(actor(c), c.req.param("id"));
    if (!removed) return c.json({ success: false, error: "Entry not found" }, 404);
    return c.json(ok({ id: c.req.param("id") }));
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

// --- Timer ------------------------------------------------------------------

const timerStartSchema = z.object({
  project_id: z.string().min(1),
  description: z.string().nullable().optional(),
  rate: z.number().nonnegative().nullable().optional(),
});

routes.get("/timer/active", (c) => c.json(ok(svc.getActiveTimer(actor(c).userId))));

routes.post("/timer/start", async (c) => {
  const parsed = timerStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid timer" }, 400);
  try {
    return c.json(ok(svc.startTimer(actor(c).userId, parsed.data)), 201);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 409);
  }
});

routes.post("/timer/stop", (c) => {
  const stopped = svc.stopTimer(actor(c).userId);
  if (!stopped) return c.json({ success: false, error: "No running timer" }, 404);
  return c.json(ok(stopped));
});

// --- Summary ----------------------------------------------------------------

routes.get("/summary", (c) =>
  c.json(
    ok(
      svc.getSummary(actor(c), {
        project_id: c.req.query("project_id") || undefined,
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    ),
  ),
);

// --- Invoice from unbilled time ---------------------------------------------

const invoiceSchema = z.object({
  customer_id: z.string().min(1),
  project_id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  issue_date: z.string().optional(),
});

routes.post("/invoice", requirePermission("invoices", "create"), async (c) => {
  const parsed = invoiceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid request" }, 400);
  const result = svc.createInvoiceFromUnbilled(parsed.data);
  if (!result) return c.json({ success: false, error: "No unbilled time for customer" }, 400);
  return c.json(ok(result), 201);
});

registerBackendPlugin({
  id: "time-tracker",
  routes,
  migrations: timeTrackerMigrations,
  defaultEnabled: true,
});
