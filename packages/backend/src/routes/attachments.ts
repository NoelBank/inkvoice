import { Hono } from "hono";
import { getDb } from "../database/connection";
import { logActivity } from "../services/activity.service";
import {
  ATTACHMENT_ENTITIES,
  type AttachmentEntity,
  deleteAttachment,
  getAttachment,
  isAllowedContentType,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
  storageUsage,
  storeAttachment,
} from "../services/attachment.service";

const attachments = new Hono();

function isKnownEntity(value: string): value is AttachmentEntity {
  return (ATTACHMENT_ENTITIES as readonly string[]).includes(value);
}

/** Guards against attaching files to records that don't exist. */
function entityExists(entityType: AttachmentEntity, entityId: string): boolean {
  const table = { expense: "expenses", invoice: "invoices", customer: "customers" }[entityType];
  const row = getDb().query(`SELECT id FROM ${table} WHERE id = ?`).get(entityId) as
    | { id: string }
    | undefined;
  return !!row;
}

attachments.get("/", (c) => {
  const entityType = c.req.query("entity_type") ?? "";
  const entityId = c.req.query("entity_id") ?? "";
  if (!isKnownEntity(entityType) || !entityId) {
    return c.json({ success: false, error: "entity_type and entity_id are required" }, 400);
  }
  return c.json({ success: true, data: listAttachments(entityType, entityId) });
});

attachments.get("/usage", (c) => {
  return c.json({ success: true, data: storageUsage() });
});

attachments.post("/", async (c) => {
  const body = await c.req.parseBody();
  const entityType = String(body.entity_type ?? "");
  const entityId = String(body.entity_id ?? "");
  const file = body.file;

  if (!isKnownEntity(entityType) || !entityId) {
    return c.json({ success: false, error: "entity_type and entity_id are required" }, 400);
  }
  if (!(file instanceof File)) {
    return c.json({ success: false, error: "No file provided" }, 400);
  }
  if (file.size === 0) {
    return c.json({ success: false, error: "File is empty" }, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json(
      { success: false, error: `File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)` },
      413,
    );
  }
  if (!isAllowedContentType(file.type)) {
    return c.json(
      { success: false, error: `Unsupported file type: ${file.type || "unknown"}` },
      415,
    );
  }
  if (!entityExists(entityType, entityId)) {
    return c.json({ success: false, error: "Record not found" }, 404);
  }

  const { attachment } = storeAttachment({
    entityType,
    entityId,
    fileName: file.name,
    contentType: file.type,
    data: new Uint8Array(await file.arrayBuffer()),
    uploadedBy: c.get("userId") ?? null,
  });

  // Who uploaded which receipt and when is part of what makes this an archive
  // rather than a folder.
  logActivity({
    user_id: c.get("userId"),
    user_name: c.get("user")?.username,
    action: "attached",
    resource_type: entityType,
    resource_id: entityId,
    metadata: { file_name: attachment.file_name, sha256: attachment.sha256 },
  });

  return c.json({ success: true, data: attachment }, 201);
});

attachments.get("/:id/download", (c) => {
  const attachment = getAttachment(c.req.param("id"));
  if (!attachment) {
    return c.json({ success: false, error: "Attachment not found" }, 404);
  }

  const data = readAttachment(attachment);
  if (!data) {
    return c.json({ success: false, error: "Attachment file is missing on disk" }, 410);
  }

  c.header("Content-Type", attachment.content_type || "application/octet-stream");
  // Never inline: an uploaded SVG or XML rendered in the app's origin would be
  // a stored-XSS vector.
  c.header("Content-Disposition", `attachment; filename="${attachment.file_name}"`);
  c.header("X-Content-Type-Options", "nosniff");
  // Buffer keeps Hono's body typing happy and matches the other binary routes.
  return c.body(Buffer.from(data));
});

attachments.delete("/:id", (c) => {
  const id = c.req.param("id");
  const attachment = getAttachment(id);
  if (!attachment || !deleteAttachment(id)) {
    return c.json({ success: false, error: "Attachment not found" }, 404);
  }

  logActivity({
    user_id: c.get("userId"),
    user_name: c.get("user")?.username,
    action: "attachment_removed",
    resource_type: attachment.entity_type,
    resource_id: attachment.entity_id,
    metadata: { file_name: attachment.file_name },
  });

  return c.json({ success: true });
});

export { attachments };
