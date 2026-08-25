import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "../database/connection";
import { getEnv } from "../utils/env";
import { logger } from "../utils/logger";

/**
 * Files attached to a record — most importantly the receipt behind an expense.
 *
 * The bytes live on the data volume, not in SQLite: a year of scans runs to
 * hundreds of megabytes, and every one of them would be rewritten by each
 * `VACUUM INTO` backup. Storage is content-addressed by SHA-256, so uploading
 * the same PDF twice costs one copy on disk.
 *
 * Blobs are never overwritten and deletes are soft. A receipt inside its
 * retention period has to stay reconstructable, which is the whole reason to
 * keep it here rather than in a shared folder.
 */

export type AttachmentEntity = "expense" | "invoice" | "customer";

export const ATTACHMENT_ENTITIES: readonly AttachmentEntity[] = ["expense", "invoice", "customer"];

/** Generous enough for a multi-page scan, small enough to bound abuse. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/tiff",
  "text/xml",
  "application/xml",
]);

export interface Attachment {
  id: string;
  entity_type: AttachmentEntity;
  entity_id: string;
  file_name: string;
  content_type: string | null;
  bytes: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

export function attachmentsDir(): string {
  return getEnv().ATTACHMENTS_DIR;
}

/**
 * Two-level fan-out by hash prefix keeps directory sizes sane on filesystems
 * that slow down with tens of thousands of entries in one directory.
 */
export function blobPath(sha256: string): string {
  return join(attachmentsDir(), sha256.slice(0, 2), sha256);
}

export function isAllowedContentType(contentType: string | null | undefined): boolean {
  return !!contentType && ALLOWED_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

/**
 * Strips path components, then collapses anything outside a conservative ASCII
 * set. An allowlist rather than a blocklist: these names end up in ZIP entries
 * and Content-Disposition headers, where control characters, quotes and
 * non-ASCII each cause their own class of trouble.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return cleaned.slice(0, 255) || "file";
}

export interface StoreResult {
  attachment: Attachment;
  /** False when an identical blob was already on disk. */
  written: boolean;
}

export function storeAttachment(params: {
  entityType: AttachmentEntity;
  entityId: string;
  fileName: string;
  contentType: string | null;
  data: Uint8Array;
  uploadedBy: string | null;
}): StoreResult {
  const sha256 = crypto.createHash("sha256").update(params.data).digest("hex");
  const path = blobPath(sha256);

  let written = false;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, params.data);
    written = true;
  }

  const db = getDb();
  const id = crypto.randomBytes(16).toString("hex");
  db.run(
    `INSERT INTO attachments (id, entity_type, entity_id, file_name, content_type, bytes, sha256, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.entityType,
      params.entityId,
      sanitizeFileName(params.fileName),
      params.contentType,
      params.data.byteLength,
      sha256,
      params.uploadedBy,
    ],
  );

  return { attachment: getAttachment(id) as Attachment, written };
}

export function getAttachment(id: string): Attachment | null {
  return getDb()
    .query("SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL")
    .get(id) as Attachment | null;
}

export function listAttachments(entityType: AttachmentEntity, entityId: string): Attachment[] {
  return getDb()
    .query(
      `SELECT * FROM attachments
       WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL
       ORDER BY created_at`,
    )
    .all(entityType, entityId) as Attachment[];
}

export function readAttachment(attachment: Attachment): Uint8Array | null {
  const path = blobPath(attachment.sha256);
  if (!existsSync(path)) {
    // The row outliving its blob means the volume was restored without the
    // attachments directory — worth shouting about rather than 404ing quietly.
    logger.error({ id: attachment.id, sha256: attachment.sha256 }, "Attachment blob missing");
    return null;
  }
  return new Uint8Array(readFileSync(path));
}

/**
 * Marks the row deleted. The blob is only unlinked once no live row references
 * it — deduplication means another record may still need those bytes.
 */
export function deleteAttachment(id: string): boolean {
  const db = getDb();
  const attachment = getAttachment(id);
  if (!attachment) return false;

  db.run("UPDATE attachments SET deleted_at = datetime('now') WHERE id = ?", [id]);

  const stillReferenced = db
    .query("SELECT COUNT(*) as cnt FROM attachments WHERE sha256 = ? AND deleted_at IS NULL")
    .get(attachment.sha256) as { cnt: number };

  if (stillReferenced.cnt === 0) {
    const path = blobPath(attachment.sha256);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      logger.warn({ err, path }, "Could not remove attachment blob");
    }
  }
  return true;
}

export function attachmentCounts(
  entityType: AttachmentEntity,
  entityIds: string[],
): Record<string, number> {
  if (entityIds.length === 0) return {};
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT entity_id, COUNT(*) as cnt FROM attachments
       WHERE entity_type = ? AND deleted_at IS NULL AND entity_id IN (${placeholders})
       GROUP BY entity_id`,
    )
    .all(entityType, ...entityIds) as { entity_id: string; cnt: number }[];

  return Object.fromEntries(rows.map((r) => [r.entity_id, r.cnt]));
}

/** Total bytes actually occupied on disk, counting each blob once. */
export function storageUsage(): { blobs: number; bytes: number } {
  const rows = getDb()
    .query("SELECT DISTINCT sha256 FROM attachments WHERE deleted_at IS NULL")
    .all() as { sha256: string }[];

  let bytes = 0;
  for (const row of rows) {
    const path = blobPath(row.sha256);
    if (existsSync(path)) bytes += statSync(path).size;
  }
  return { blobs: rows.length, bytes };
}
