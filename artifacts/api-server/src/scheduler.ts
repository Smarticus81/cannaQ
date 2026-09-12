import cron from "node-cron";
import { db } from "@workspace/db";
import { digestSettingsTable } from "@workspace/db";
import { sendComplianceDigest, sendInventoryDigest } from "./services/digestEmail";
import { reconcileAllSupplierRisk } from "./routes/suppliers";
import { logger } from "./lib/logger";
import { releaseDueDocuments } from "./lib/documentRevisions";
import { facilityDateStr } from "./lib/facilityDate";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let riskReconcileTask: ReturnType<typeof cron.schedule> | null = null;
let effectiveDateTask: ReturnType<typeof cron.schedule> | null = null;

async function runDigests() {
  try {
    const [settings] = await db.select().from(digestSettingsTable).limit(1);
    if (!settings || settings.enabled === 0) {
      logger.info("Digest emails disabled — skipping");
      return;
    }
    logger.info("Running scheduled weekly digest emails");
    const [compliance, inventory] = await Promise.allSettled([
      sendComplianceDigest(),
      sendInventoryDigest(),
    ]);
    if (compliance.status === "fulfilled") {
      logger.info({ result: compliance.value }, "Compliance digest complete");
    } else {
      logger.error({ err: compliance.reason }, "Compliance digest failed");
    }
    if (inventory.status === "fulfilled") {
      logger.info({ result: inventory.value }, "Inventory digest complete");
    } else {
      logger.error({ err: inventory.reason }, "Inventory digest failed");
    }
  } catch (err) {
    logger.error({ err }, "Digest scheduler error");
  }
}

export function startDigestScheduler() {
  // Run every hour at :00.
  // The digest fires only when BOTH the UTC day-of-week AND hour match the
  // configured values — giving a weekly cadence at a chosen time.
  scheduledTask = cron.schedule("0 * * * *", async () => {
    let settings;
    try {
      [settings] = await db.select().from(digestSettingsTable).limit(1);
    } catch {
      return;
    }
    if (!settings || settings.enabled === 0) return;

    const now = new Date();
    const nowHour = now.getUTCHours();
    const nowDay  = now.getUTCDay(); // 0 = Sunday … 6 = Saturday

    const targetDay  = settings.sendDayOfWeek ?? 1; // default Monday
    const targetHour = settings.sendHourUtc ?? 12;

    if (nowDay === targetDay && nowHour === targetHour) {
      await runDigests();
    }
  });
  logger.info("Weekly digest scheduler started (checks every hour)");

  // SRS-1 Part 2 — daily supplier risk-tier reconcile at 04:00 UTC. Detects both
  // event-driven and time-driven (re-qualification overdue) tier changes and
  // records them for review; increases apply immediately, decreases are held.
  riskReconcileTask = cron.schedule("0 4 * * *", async () => {
    try {
      const { scanned } = await reconcileAllSupplierRisk();
      logger.info({ scanned }, "Supplier risk reconcile complete");
    } catch (err) {
      logger.error({ err }, "Supplier risk reconcile failed");
    }
  });
  logger.info("Supplier risk reconcile scheduler started (daily 04:00 UTC)");

  // 2026-08-27 — put approved revisions into force on their DECLARED effective date.
  // Hourly rather than daily on purpose: the facility calendar is what decides when
  // "today" becomes the date, and an hourly pass reaches it soon after midnight
  // wherever the facility is, without needing to know its offset here.
  effectiveDateTask = cron.schedule("5 * * * *", async () => {
    try {
      const { released } = await releaseDueDocuments(facilityDateStr());
      if (released > 0) logger.info({ released }, "Documents released on their declared effective date");
    } catch (err) {
      logger.error({ err }, "Declared-effective-date release failed");
    }
  });
  logger.info("Declared effective date scheduler started (hourly)");

  // And once at boot, so a date that arrived while the server was down is not
  // silently skipped — a document that should be in force must not wait an hour.
  releaseDueDocuments(facilityDateStr())
    .then(({ released }) => { if (released > 0) logger.info({ released }, "Documents released at boot on their declared effective date"); })
    .catch((err) => logger.error({ err }, "Declared-effective-date release failed at boot"));
}

export function stopDigestScheduler() {
  scheduledTask?.stop();
  scheduledTask = null;
  riskReconcileTask?.stop();
  riskReconcileTask = null;
  effectiveDateTask?.stop();
  effectiveDateTask = null;
}
