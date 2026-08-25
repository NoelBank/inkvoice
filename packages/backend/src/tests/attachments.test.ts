import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import {
  blobPath,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  sanitizeFileName,
  storageUsage,
} from "../services/attachment.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-attachments.db";
const ATTACHMENTS_DIR = "./data/test-attachments-blobs";
const EXPENSE_ID = "attachment-expense";
const PASSWORD = "attachmenttestpass";

let app: Hono;
let token: string;

async function upload(
  content: string,
  fileName = "receipt.pdf",
  type = "application/pdf",
  entity: { type: string; id: string } = { type: "expense", id: EXPENSE_ID },
) {
  const form = new FormData();
  form.append("entity_type", entity.type);
  form.append("entity_id", entity.id);
  form.append("file", new File([content], fileName, { type }));

  const res = await app.request("/api/v1/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { res, body: (await res.json()) as any };
}

async function listViaApi(entityId = EXPENSE_ID) {
  const res = await app.request(`/api/v1/attachments?entity_type=expense&entity_id=${entityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as any).data as any[];
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ATTACHMENTS_DIR = ATTACHMENTS_DIR;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = PASSWORD;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  token = ((await res.json()) as any).data.token;
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM expenses");
  db.run(
    "INSERT INTO expenses (id, vendor, expense_date, amount, total, currency) VALUES (?, ?, ?, ?, ?, ?)",
    [EXPENSE_ID, "Hetzner", "2026-03-14", 100, 119, "EUR"],
  );
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
});

afterAll(() => {
  closeDatabase();
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("sanitizeFileName", () => {
  test("strips directory components a browser may send", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\scan.pdf")).toBe("scan.pdf");
  });

  test("collapses characters that are illegal in filenames", () => {
    expect(sanitizeFileName('in"voice<>:|?*.pdf')).toBe("in_voice_.pdf");
    expect(sanitizeFileName("Rechnung März 2026.pdf")).toBe("Rechnung_M_rz_2026.pdf");
  });

  test("does not let a name start with a dot", () => {
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
  });

  test("never returns an empty name", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("///")).toBe("file");
  });
});

describe("upload", () => {
  test("stores the file and returns its metadata", async () => {
    const { res, body } = await upload("%PDF-1.4 receipt");
    expect(res.status).toBe(201);
    expect(body.data.file_name).toBe("receipt.pdf");
    expect(body.data.bytes).toBeGreaterThan(0);
    expect(body.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(blobPath(body.data.sha256))).toBe(true);
  });

  test("the file comes back byte-for-byte on download", async () => {
    const content = "%PDF-1.4 exact bytes";
    const { body } = await upload(content);

    const res = await app.request(`/api/v1/attachments/${body.data.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  test("downloads are forced as attachments and not sniffed", async () => {
    const { body } = await upload("<svg onload=alert(1)>", "evil.xml", "text/xml");
    const res = await app.request(`/api/v1/attachments/${body.data.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.headers.get("content-disposition")).toStartWith("attachment;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("identical content is stored once but tracked twice", async () => {
    const first = await upload("same bytes", "a.pdf");
    const second = await upload("same bytes", "b.pdf");

    expect(first.body.data.sha256).toBe(second.body.data.sha256);
    expect(first.body.data.id).not.toBe(second.body.data.id);
    expect(await listViaApi()).toHaveLength(2);
    expect(storageUsage().blobs).toBe(1);
  });

  test("rejects an unsupported file type", async () => {
    const { res } = await upload("MZ", "trojan.exe", "application/x-msdownload");
    expect(res.status).toBe(415);
  });

  test("rejects an empty file", async () => {
    const { res } = await upload("", "empty.pdf");
    expect(res.status).toBe(400);
  });

  test("rejects a file over the size limit", async () => {
    const form = new FormData();
    form.append("entity_type", "expense");
    form.append("entity_id", EXPENSE_ID);
    form.append(
      "file",
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.pdf", { type: "application/pdf" }),
    );
    const res = await app.request("/api/v1/attachments", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.status).toBe(413);
  });

  test("refuses to attach to a record that does not exist", async () => {
    const { res } = await upload("x", "a.pdf", "application/pdf", {
      type: "expense",
      id: "no-such-expense",
    });
    expect(res.status).toBe(404);
  });

  test("rejects an unknown entity type", async () => {
    const { res } = await upload("x", "a.pdf", "application/pdf", {
      type: "invoice_line",
      id: EXPENSE_ID,
    });
    expect(res.status).toBe(400);
  });

  test("requires authentication", async () => {
    const form = new FormData();
    form.append("entity_type", "expense");
    form.append("entity_id", EXPENSE_ID);
    form.append("file", new File(["x"], "a.pdf", { type: "application/pdf" }));
    const res = await app.request("/api/v1/attachments", { method: "POST", body: form });
    expect(res.status).toBe(401);
  });

  test("records who uploaded the file", async () => {
    const { body } = await upload("audited");
    expect(body.data.uploaded_by).toBeString();

    const logged = getDb()
      .query("SELECT COUNT(*) as cnt FROM activity_log WHERE action = 'attached'")
      .get() as { cnt: number };
    expect(logged.cnt).toBeGreaterThan(0);
  });
});

describe("delete", () => {
  test("removes the row and the blob when nothing else references it", async () => {
    const { body } = await upload("only copy");
    const sha = body.data.sha256;

    const res = await app.request(`/api/v1/attachments/${body.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await listViaApi()).toHaveLength(0);
    expect(existsSync(blobPath(sha))).toBe(false);
  });

  test("keeps the blob while another attachment still points at it", async () => {
    const first = await upload("shared bytes", "a.pdf");
    const second = await upload("shared bytes", "b.pdf");
    const sha = first.body.data.sha256;

    await app.request(`/api/v1/attachments/${first.body.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(existsSync(blobPath(sha))).toBe(true);
    const res = await app.request(`/api/v1/attachments/${second.body.data.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await res.text()).toBe("shared bytes");
  });

  test("the deletion is soft — the row survives for the audit trail", async () => {
    const { body } = await upload("soft delete");
    await app.request(`/api/v1/attachments/${body.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    const row = getDb()
      .query("SELECT deleted_at FROM attachments WHERE id = ?")
      .get(body.data.id) as { deleted_at: string | null };
    expect(row.deleted_at).toBeString();
    expect(listAttachments("expense", EXPENSE_ID)).toHaveLength(0);
  });

  test("deleting twice is a 404, not a crash", async () => {
    const { body } = await upload("gone");
    const del = () =>
      app.request(`/api/v1/attachments/${body.data.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(404);
  });
});

describe("download failures", () => {
  test("an unknown id is a 404", async () => {
    const res = await app.request("/api/v1/attachments/nope/download", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test("a row whose blob vanished reports 410 rather than serving nothing", async () => {
    const { body } = await upload("will vanish");
    rmSync(blobPath(body.data.sha256));

    const res = await app.request(`/api/v1/attachments/${body.data.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(410);
  });
});
