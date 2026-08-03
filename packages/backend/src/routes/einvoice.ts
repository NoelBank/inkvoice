import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../database/connection";
import { logActivity } from "../services/activity.service";
import {
  deleteInboxItem,
  getInboxItem,
  getInboxRaw,
  type InboxStatus,
  importEinvoiceFile,
  linkInboxToCustomer,
  listInboxItems,
  updateInboxStatus,
} from "../services/einvoice-inbox.service";

// E-invoice inbox: receive, list, inspect and archive incoming
// XRechnung/ZUGFeRD documents (mandatory in Germany since 1 Jan 2025).

const einvoices = new Hono();

einvoices.get("/inbox", (c) => {
  const status = c.req.query("status") as InboxStatus | undefined;
  if (status && !["inbox", "processed", "archived"].includes(status)) {
    return c.json({ success: false, error: "Invalid status filter" }, 400);
  }
  return c.json({ success: true, data: listInboxItems(status) });
});

einvoices.post("/inbox/import", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === "string") {
    return c.json({ success: false, error: "file is required (multipart upload)" }, 400);
  }
  const name = (file as File).name || "einvoice.xml";
  const type = (file as File).type || "application/xml";

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await (file as File).arrayBuffer());
  } catch {
    return c.json({ success: false, error: "Could not read uploaded file" }, 400);
  }
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
    return c.json({ success: false, error: "File must be between 1 byte and 20 MB" }, 400);
  }

  const { id, duplicate } = importEinvoiceFile({ fileName: name, contentType: type, bytes });
  logActivity({
    action: "create",
    resource_type: "einvoice_inbox",
    resource_id: id,
    metadata: { fileName: name, duplicate },
  });
  return c.json({ success: true, data: { id, duplicate } }, duplicate ? 200 : 201);
});

einvoices.get("/inbox/:id", (c) => {
  const item = getInboxItem(c.req.param("id"));
  if (!item) return c.json({ success: false, error: "Inbox item not found" }, 404);
  return c.json({ success: true, data: item });
});

einvoices.get("/inbox/:id/raw", (c) => {
  const raw = getInboxRaw(c.req.param("id"));
  if (!raw) return c.json({ success: false, error: "Inbox item not found" }, 404);
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${raw.fileName}"`);
  return c.body(new Uint8Array(raw.bytes));
});

const linkSchema = z.object({
  customer_id: z.string().min(1).nullable(),
});

einvoices.post("/inbox/:id/link", async (c) => {
  const body = linkSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ success: false, error: "customer_id required" }, 400);
  const item = getInboxItem(c.req.param("id"));
  if (!item) return c.json({ success: false, error: "Inbox item not found" }, 404);
  if (body.data.customer_id) {
    const exists = getDb()
      .query("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL")
      .get(body.data.customer_id);
    if (!exists) return c.json({ success: false, error: "Customer not found" }, 404);
  }
  linkInboxToCustomer(c.req.param("id"), body.data.customer_id);
  logActivity({
    action: "update",
    resource_type: "einvoice_inbox",
    resource_id: item.id,
    metadata: { customer_id: body.data.customer_id },
  });
  return c.json({ success: true });
});

einvoices.post("/inbox/:id/status", async (c) => {
  const body = z
    .object({ status: z.enum(["inbox", "processed", "archived"]) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ success: false, error: "status required" }, 400);
  if (!updateInboxStatus(c.req.param("id"), body.data.status)) {
    return c.json({ success: false, error: "Inbox item not found" }, 404);
  }
  return c.json({ success: true });
});

einvoices.delete("/inbox/:id", (c) => {
  if (!deleteInboxItem(c.req.param("id"))) {
    return c.json({ success: false, error: "Inbox item not found" }, 404);
  }
  return c.json({ success: true });
});

export { einvoices };
