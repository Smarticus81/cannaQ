import { Router } from "express";
import { db } from "@workspace/db";
import {
  inventoryChecksTable,
  inventoryCheckLinesTable,
  inventoryCheckSettingsTable,
  auditLogTable,
} from "@workspace/db";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { facilityPrefix, nextForPrefix, numbersInUseEverywhere } from "../lib/recordNumber";
import { getTrackingProviderForFacility } from "../lib/trackingProvider";

// Inventory Checks — periodic physical-count reconciliation against METRC.
// See lib/db/src/schema/inventory_checks.ts for the model. Off-spec (not in the
// OpenAPI surface); the frontend uses raw fetch, same convention as destruction
// records and label templates.

async function writeAuditLog(opts: {
  rowId: number;
  operation: string;
  changedById?: number | null;
  changedByName?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "inventory_checks",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

// Cadence -> interval in months. "None" disables due-date tracking.
const CADENCE_MONTHS: Record<string, number | null> = {
  Monthly: 1, Quarterly: 3, Semiannual: 6, Annual: 12, None: null,
};

async function getSettingsRow() {
  const [row] = await db.select().from(inventoryCheckSettingsTable).where(eq(inventoryCheckSettingsTable.id, 1));
  if (row) return row;
  const [created] = await db.insert(inventoryCheckSettingsTable).values({ id: 1 } as never).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(inventoryCheckSettingsTable).where(eq(inventoryCheckSettingsTable.id, 1));
  return again;
}

// IC-YYYY-#### — per-year sequence, mirroring generateNcNumber.
// An inventory check belongs to the plant whose stock was counted, so its number
// carries the site code — which is also what keeps two plants from both reaching for
// the same number while each can only see its own checks.
async function generateCheckNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = facilityPrefix("IC", String(year));
  // Across every site, for the same reason as everywhere else.
  const used = await numbersInUseEverywhere("inventory_checks", "check_number", prefix);
  let maxSeq = parseInt(nextForPrefix(prefix, used).slice(-4), 10) - 1;
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

const router = Router();

// ---------- Settings (singleton cadence) ----------
router.get("/inventory-check-settings", async (req, res) => {
  try {
    const row = await getSettingsRow();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get inventory-check settings");
    res.status(500).json({ error: "Failed to get inventory-check settings" });
  }
});

router.put("/inventory-check-settings", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const body = (req.body ?? {}) as { cadence?: string; graceDays?: number };
    const cadence = typeof body.cadence === "string" && body.cadence in CADENCE_MONTHS ? body.cadence : "Quarterly";
    const graceDays = Number.isFinite(body.graceDays) ? Math.max(0, Math.floor(body.graceDays as number)) : 0;
    await getSettingsRow(); // ensure the row exists
    const [row] = await db
      .update(inventoryCheckSettingsTable)
      .set({ cadence, graceDays, updatedByName: actor?.fullName ?? null, updatedAt: new Date() } as never)
      .where(eq(inventoryCheckSettingsTable.id, 1))
      .returning();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update inventory-check settings");
    res.status(500).json({ error: "Failed to update inventory-check settings" });
  }
});

// ---------- List (+ schedule status) ----------
router.get("/inventory-checks", async (req, res) => {
  try {
    const checks = await db.select().from(inventoryChecksTable).orderBy(desc(inventoryChecksTable.createdAt));

    const agg = await db
      .select({
        checkId: inventoryCheckLinesTable.checkId,
        total: sql<number>`count(*)::int`,
        counted: sql<number>`sum(case when ${inventoryCheckLinesTable.counted} then 1 else 0 end)::int`,
        variances: sql<number>`sum(case when ${inventoryCheckLinesTable.variance} is not null and ${inventoryCheckLinesTable.variance} <> 0 then 1 else 0 end)::int`,
      })
      .from(inventoryCheckLinesTable)
      .groupBy(inventoryCheckLinesTable.checkId);
    const byCheck = new Map(agg.map((a) => [a.checkId, a]));

    const withCounts = checks.map((c) => {
      const a = byCheck.get(c.id);
      return { ...c, lineCount: a?.total ?? 0, countedCount: a?.counted ?? 0, varianceCount: a?.variances ?? 0 };
    });

    // Schedule status: next due = last completed + cadence interval (+grace).
    const settings = await getSettingsRow();
    const months = CADENCE_MONTHS[settings?.cadence ?? "Quarterly"] ?? null;
    const completed = checks.filter((c) => c.status === "Completed" && c.completedAt);
    const lastCompletedAt = completed.length
      ? completed.reduce((m, c) => (new Date(c.completedAt as unknown as string) > new Date(m) ? (c.completedAt as unknown as string) : m), completed[0].completedAt as unknown as string)
      : null;
    let nextDueAt: string | null = null;
    let overdue = false;
    if (months && lastCompletedAt) {
      const d = new Date(lastCompletedAt);
      d.setMonth(d.getMonth() + months);
      d.setDate(d.getDate() + (settings?.graceDays ?? 0));
      nextDueAt = d.toISOString();
      overdue = Date.now() > d.getTime();
    }

    res.json({
      schedule: {
        cadence: settings?.cadence ?? "Quarterly",
        graceDays: settings?.graceDays ?? 0,
        lastCompletedAt,
        nextDueAt,
        overdue,
        neverRun: completed.length === 0,
      },
      checks: withCounts,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory checks");
    res.status(500).json({ error: "Failed to list inventory checks" });
  }
});

// ---------- Create ----------
router.post("/inventory-checks", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const body = (req.body ?? {}) as { periodLabel?: string; countType?: string; scheduledDate?: string; notes?: string };
    const checkNumber = await generateCheckNumber();
    const scheduledDate = body.scheduledDate ? new Date(body.scheduledDate) : null;
    const [record] = await db
      .insert(inventoryChecksTable)
      .values({
        checkNumber,
        periodLabel: body.periodLabel?.trim() || null,
        countType: body.countType === "Partial" ? "Partial" : "Full",
        scheduledDate: scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? scheduledDate : null,
        notes: body.notes?.trim() || null,
        createdByName: actor?.fullName ?? null,
        countedByName: actor?.fullName ?? null,
      } as never)
      .returning();
    void writeAuditLog({ rowId: record.id, operation: "INSERT", changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null, afterState: record as unknown as Record<string, unknown> });
    res.status(201).json(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to create inventory check");
    res.status(500).json({ error: `Failed to create inventory check: ${msg}` });
  }
});

// ---------- Get one (+lines) ----------
router.get("/inventory-checks/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(inventoryChecksTable).where(eq(inventoryChecksTable.id, id));
    if (!record) { res.status(404).json({ error: "Inventory check not found" }); return; }
    const lines = await db.select().from(inventoryCheckLinesTable).where(eq(inventoryCheckLinesTable.checkId, id)).orderBy(inventoryCheckLinesTable.id);
    res.json({ ...record, lines });
  } catch (err) {
    req.log.error({ err }, "Failed to get inventory check");
    res.status(500).json({ error: "Failed to get inventory check" });
  }
});

// ---------- METRC snapshot: pull active packages into lines ----------
router.post("/inventory-checks/:id/snapshot", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(inventoryChecksTable).where(eq(inventoryChecksTable.id, id));
    if (!record) { res.status(404).json({ error: "Inventory check not found" }); return; }
    if (record.status !== "In Progress") { res.status(409).json({ error: "Only an in-progress check can be snapshotted." }); return; }

    const provider = await getTrackingProviderForFacility();
    const result = await provider.getActivePackages(typeof req.query["licenseNumber"] === "string" ? req.query["licenseNumber"] : undefined);
    if (!result.ok) {
      res.status(400).json({ error: `Could not read active packages from METRC: ${result.error}. Connect METRC (or check the license) and try again.` });
      return;
    }
    const packages = result.data?.Data ?? [];

    const existing = await db.select().from(inventoryCheckLinesTable).where(eq(inventoryCheckLinesTable.checkId, id));
    const byTag = new Map(existing.map((l) => [l.metrcTag, l]));

    let inserted = 0;
    let updated = 0;
    for (const pkg of packages) {
      const tag = String(pkg.Label ?? "").trim();
      if (!tag) continue;
      const item = (pkg["Item"] as { Name?: string; ProductCategoryName?: string } | undefined) ?? undefined;
      const itemName = item?.Name ?? (typeof pkg["ProductName"] === "string" ? (pkg["ProductName"] as string) : null);
      const category = item?.ProductCategoryName ?? (typeof pkg["ProductCategoryName"] === "string" ? (pkg["ProductCategoryName"] as string) : null);
      const systemQty = typeof pkg.Quantity === "number" ? pkg.Quantity : null;
      const uom = typeof pkg.UnitOfMeasureName === "string" ? pkg.UnitOfMeasureName : null;
      const prior = byTag.get(tag);
      if (prior) {
        // Refresh the expected quantity; recompute variance if already counted.
        const variance = prior.counted && prior.countedQty != null && systemQty != null ? prior.countedQty - systemQty : prior.variance;
        await db.update(inventoryCheckLinesTable)
          .set({ systemQty, itemName, category, uom, variance, updatedAt: new Date() } as never)
          .where(eq(inventoryCheckLinesTable.id, prior.id));
        updated++;
      } else {
        await db.insert(inventoryCheckLinesTable).values({ checkId: id, metrcTag: tag, itemName, category, uom, systemQty } as never);
        inserted++;
      }
    }

    const [after] = await db.update(inventoryChecksTable)
      .set({ metrcSnapshotAt: new Date(), updatedAt: new Date() } as never)
      .where(eq(inventoryChecksTable.id, id)).returning();
    const lines = await db.select().from(inventoryCheckLinesTable).where(eq(inventoryCheckLinesTable.checkId, id)).orderBy(inventoryCheckLinesTable.id);
    res.json({ ...after, lines, snapshot: { packages: packages.length, inserted, updated } });
  } catch (err) {
    req.log.error({ err }, "Failed to snapshot inventory check");
    res.status(500).json({ error: "Failed to snapshot from METRC" });
  }
});

// ---------- Update a line (count + reason) ----------
router.patch("/inventory-checks/:id/lines/:lineId", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const lineId = parseInt(req.params.lineId);
    const [check] = await db.select().from(inventoryChecksTable).where(eq(inventoryChecksTable.id, id));
    if (!check) { res.status(404).json({ error: "Inventory check not found" }); return; }
    if (check.status !== "In Progress") { res.status(409).json({ error: "This check is no longer editable." }); return; }
    const [line] = await db.select().from(inventoryCheckLinesTable).where(and(eq(inventoryCheckLinesTable.id, lineId), eq(inventoryCheckLinesTable.checkId, id)));
    if (!line) { res.status(404).json({ error: "Line not found" }); return; }

    const body = (req.body ?? {}) as { countedQty?: number | null; reason?: string | null; notes?: string | null };
    const hasCount = body.countedQty !== undefined;
    const countedQty = hasCount ? (body.countedQty === null || body.countedQty === undefined ? null : Number(body.countedQty)) : line.countedQty;
    if (countedQty != null && Number.isNaN(countedQty)) { res.status(400).json({ error: "Counted quantity must be a number." }); return; }
    const counted = countedQty != null;
    const variance = counted ? countedQty - (line.systemQty ?? 0) : null;

    const [updated] = await db.update(inventoryCheckLinesTable)
      .set({
        countedQty,
        counted,
        variance,
        reason: body.reason !== undefined ? (body.reason?.trim() || null) : line.reason,
        notes: body.notes !== undefined ? (body.notes?.trim() || null) : line.notes,
        updatedAt: new Date(),
      } as never)
      .where(eq(inventoryCheckLinesTable.id, lineId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update inventory-check line");
    res.status(500).json({ error: "Failed to update line" });
  }
});

// ---------- Complete (Part 11) ----------
router.post("/inventory-checks/:id/complete", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [check] = await db.select().from(inventoryChecksTable).where(eq(inventoryChecksTable.id, id));
    if (!check) { res.status(404).json({ error: "Inventory check not found" }); return; }
    if (check.status !== "In Progress") { res.status(409).json({ error: "This check is already completed or cancelled." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as { initials?: string; signatureMeaning?: string; signingMeaning?: string };
    const meaning = (signatureMeaning ?? signingMeaning ?? "").trim();
    const ini = (initials ?? "").trim();
    if (!ini || !meaning) { res.status(400).json({ error: "Initials and signing meaning are required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== ini.toUpperCase()) { res.status(400).json({ error: "Initials do not match the signed-in user." }); return; }

    const lines = await db.select().from(inventoryCheckLinesTable).where(eq(inventoryCheckLinesTable.checkId, id));
    if (lines.length === 0) { res.status(400).json({ error: "Snapshot from METRC first — there are no lines to reconcile." }); return; }
    const uncounted = lines.filter((l) => !l.counted).length;
    if (uncounted > 0) { res.status(400).json({ error: `Count every line first — ${uncounted} still uncounted.` }); return; }
    const unexplained = lines.filter((l) => l.variance != null && l.variance !== 0 && !(l.reason && l.reason.trim())).length;
    if (unexplained > 0) { res.status(400).json({ error: `Every variance needs a written reason — ${unexplained} still unexplained.` }); return; }

    const [record] = await db.update(inventoryChecksTable).set({
      status: "Completed",
      completedAt: new Date(),
      countedByName: actor.fullName,
      signedByName: actor.fullName,
      signedByInitials: ini.toUpperCase(),
      signedMeaning: meaning,
      signedAt: new Date(),
      updatedAt: new Date(),
    } as never).where(eq(inventoryChecksTable.id, id)).returning();
    void writeAuditLog({ rowId: id, operation: "COMPLETE", changedById: actor.id, changedByName: actor.fullName, beforeState: check as unknown as Record<string, unknown>, afterState: record as unknown as Record<string, unknown> });
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to complete inventory check");
    res.status(500).json({ error: "Failed to complete inventory check" });
  }
});

// ---------- Cancel (Part 11, recoverable) ----------
router.post("/inventory-checks/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as { reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string };
    const meaning = (signatureMeaning ?? signingMeaning ?? "").trim();
    const ini = (initials ?? "").trim();
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!ini || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== ini.toUpperCase()) { res.status(400).json({ error: "Initials do not match the signed-in user." }); return; }
    const [before] = await db.select().from(inventoryChecksTable).where(eq(inventoryChecksTable.id, id));
    if (!before) { res.status(404).json({ error: "Inventory check not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This check is already cancelled." }); return; }
    const [record] = await db.update(inventoryChecksTable).set({
      status: "Cancelled",
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: ini.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(inventoryChecksTable.id, id)).returning();
    void writeAuditLog({ rowId: id, operation: "CANCEL", changedById: actor.id, changedByName: actor.fullName, beforeState: before as unknown as Record<string, unknown>, afterState: record as unknown as Record<string, unknown> });
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel inventory check");
    res.status(500).json({ error: "Failed to cancel inventory check" });
  }
});

export default router;
