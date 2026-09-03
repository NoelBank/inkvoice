import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { getEnv } from "../utils/env";
import { logger } from "../utils/logger";
import { runBackup, shouldRunBackups } from "./backup.service";
import { startTransportWorker, stopTransportWorker } from "./einvoice-transport.service";
import { processAllDue } from "./recurring.service";
import { processAllReminders } from "./reminder.service";

let intervalId: ReturnType<typeof setInterval> | null = null;
let backupIntervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 60 * 60 * 1000): void {
  if (intervalId) return;

  // Run immediately on startup
  runScheduledTasks();

  // Then run periodically
  intervalId = setInterval(runScheduledTasks, intervalMs);
  logger.info({ intervalSec: intervalMs / 1000 }, "Scheduler started");

  // The e-invoice transport queue needs a much faster tick than the hourly
  // scheduler; it keeps its own 60s worker under the same lifecycle owner.
  startTransportWorker();

  // Backups run on their own (much slower) cadence than the hourly task tick.
  // No immediate run at startup: a crash-loop would otherwise churn out a
  // snapshot per restart and prune the useful history away.
  const backupEnv = getEnv();
  if (shouldRunBackups() && !backupIntervalId) {
    backupIntervalId = setInterval(runBackup, backupEnv.BACKUP_INTERVAL * 1000);
    logger.info(
      {
        intervalSec: backupEnv.BACKUP_INTERVAL,
        dir: backupEnv.BACKUP_DIR,
        keep: backupEnv.BACKUP_KEEP,
      },
      "Automatic database backups enabled",
    );
  }
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (backupIntervalId) {
    clearInterval(backupIntervalId);
    backupIntervalId = null;
  }
  stopTransportWorker();
}

async function runScheduledTasks(): Promise<void> {
  try {
    const recurring = processAllDue();
    if (recurring.generated > 0 || recurring.errors > 0) {
      logger.info(
        { generated: recurring.generated, errors: recurring.errors },
        "Scheduler: recurring invoices generated",
      );
    }
  } catch (err) {
    logger.error({ err }, "Scheduler recurring error");
  }

  try {
    const reminders = await processAllReminders();
    if (reminders.sent > 0 || reminders.errors > 0) {
      logger.info({ sent: reminders.sent, errors: reminders.errors }, "Scheduler: reminders sent");
    }
  } catch (err) {
    logger.error({ err }, "Scheduler reminder error");
  }
}
