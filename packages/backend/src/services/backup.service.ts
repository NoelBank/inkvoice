import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../database/connection";
import { getEnv } from "../utils/env";
import { logger } from "../utils/logger";

const FILE_PREFIX = "inkvoice-";
const FILE_SUFFIX = ".db";

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  created_at: string;
}

function isBackupFile(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

/** Sorted newest first. The timestamp in the name sorts lexicographically. */
export function listBackups(dir = getEnv().BACKUP_DIR): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isBackupFile)
    .sort()
    .reverse()
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return { name, path, bytes: stat.size, created_at: stat.mtime.toISOString() };
    });
}

export function pruneBackups(dir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const file of listBackups(dir).slice(keep)) {
    try {
      unlinkSync(file.path);
      removed.push(file.name);
    } catch (err) {
      logger.warn({ err, file: file.name }, "Could not prune backup");
    }
  }
  return removed;
}

/**
 * Writes a consistent snapshot of the live database and prunes older ones.
 *
 * `VACUUM INTO` is atomic and doesn't hold a long write lock, so this is safe
 * to run against a serving instance. The snapshot lands next to the database
 * by default — that protects against accidental deletion and bad migrations,
 * not against losing the volume. Point BACKUP_DIR at a mounted remote share
 * for off-box copies.
 */
export function runBackup(): BackupFile | null {
  const env = getEnv();
  const dir = env.BACKUP_DIR;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.error({ err, dir }, "Backup directory could not be created");
    return null;
  }

  // Colons are illegal in filenames on Windows volumes and awkward everywhere.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`);

  try {
    getDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } catch (err) {
    logger.error({ err, path }, "Backup failed");
    return null;
  }

  const bytes = statSync(path).size;
  const pruned = pruneBackups(dir, env.BACKUP_KEEP);
  logger.info({ file: path, bytes, pruned: pruned.length }, "Database backup written");

  return { name: `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`, path, bytes, created_at: stamp };
}

export function shouldRunBackups(): boolean {
  const env = getEnv();
  return env.BACKUP_ENABLED;
}
