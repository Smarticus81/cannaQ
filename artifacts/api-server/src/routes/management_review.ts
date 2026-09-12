import { Router } from "express";
import { db } from "@workspace/db";
import {
  managementReviewSnapshotsTable,
  nonConformancesTable,
  capasTable,
  complaintsTable,
  fieldActionsTable,
  batchRecordsTable,
  batchTestingTable,
  suppliersTable,
  supplierQualificationsTable,
  trainingRecordsTable,
  documentsTable,
  lotsTable,
  destructionRecordsTable,
  inventoryChecksTable,
  inventoryCheckLinesTable,
  regulatoryUpdatesTable,
} from "@workspace/db";
import { desc, eq, and } from "drizzle-orm";
import { managementReviewsTable, managementReviewActionItemsTable, auditLogTable } from "@workspace/db";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { facilityDateStr } from "../lib/facilityDate";

const router = Router();

// License-required supplier types — mirrors the suppliers route (incl. Service).
const LICENSE_REQUIRED_TYPES = new Set(["Cannabis Cultivator", "Cannabis Processor", "Testing Laboratory", "Service Supplier"]);
const NON_QUALIFYING_QUAL_STATUSES = new Set(["Failed", "Rejected", "Cancelled"]);

// ── Helpers ─────────────────────────────────────────────────────────────────
function quarterStart(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), q, 1));
}
function isoDate(d: Date): string { return facilityDateStr(d); }
function addDaysISO(days: number): string {
  const n = new Date();
  return isoDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + days)));
}
// Dates come back either as Date objects (timestamptz) or "YYYY-MM-DD" strings
// (date columns); normalize both to an ISO calendar-day string.
function toISO(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v.slice(0, 10) : isoDate(v);
}

// Count {open now, opened in window, closed in window} for a created/closed table.
type OpenCloseRow = { createdAt: Date | string | null; closedAt: Date | string | null };
function tallyOpenClose(rows: OpenCloseRow[], windowStartISO: string) {
  let open = 0, openedInWindow = 0, closedInWindow = 0;
  for (const r of rows) {
    if (!r.closedAt) open += 1;
    const createdISO = toISO(r.createdAt);
    const closedISO = toISO(r.closedAt);
    if (createdISO && createdISO >= windowStartISO) openedInWindow += 1;
    if (closedISO && closedISO >= windowStartISO) closedInWindow += 1;
  }
  return { open, openedInWindow, closedInWindow };
}

// ── Aggregation ──────────────────────────────────────────────────────────────
async function computeManagementReview() {
  const now = new Date();
  const windowStartISO = isoDate(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())));
  const nowISO = isoDate(now);
  const soon60ISO = addDaysISO(60);
  const soon30ISO = addDaysISO(30);

  const [ncs, capas, complaints, fas, batches, tests, suppliers, quals, training, docs, lots, destructions, checks, checkLines, regUpdates] = await Promise.all([
    db.select({ createdAt: nonConformancesTable.createdAt, closedAt: nonConformancesTable.closedAt }).from(nonConformancesTable),
    db.select({ createdAt: capasTable.createdAt, closedAt: capasTable.closedAt }).from(capasTable),
    db.select({ createdAt: complaintsTable.receivedDate, closedAt: complaintsTable.closedAt, craReportable: complaintsTable.craReportable, cancelledAt: complaintsTable.cancelledAt }).from(complaintsTable),
    db.select({ createdAt: fieldActionsTable.createdAt, closedAt: fieldActionsTable.closedAt }).from(fieldActionsTable),
    db.select({ productionDate: batchRecordsTable.productionDate, approvalDate: batchRecordsTable.approvalDate, outputQuantity: batchRecordsTable.outputQuantity, scheduledOutputQuantity: batchRecordsTable.scheduledOutputQuantity }).from(batchRecordsTable),
    db.select({ testResult: batchTestingTable.testResult, resultDate: batchTestingTable.resultDate }).from(batchTestingTable),
    db.select({ id: suppliersTable.id, supplierType: suppliersTable.supplierType, licenseNumber: suppliersTable.licenseNumber, riskTier: suppliersTable.riskTier, reviewedRiskTier: suppliersTable.reviewedRiskTier, cancelledAt: suppliersTable.cancelledAt }).from(suppliersTable),
    db.select({ supplierId: supplierQualificationsTable.supplierId, status: supplierQualificationsTable.status, expiryDate: supplierQualificationsTable.expiryDate }).from(supplierQualificationsTable),
    db.select({ completedDate: trainingRecordsTable.completedDate, dueDate: trainingRecordsTable.dueDate }).from(trainingRecordsTable),
    db.select({ nextReviewDate: documentsTable.nextReviewDate, obsoletedAt: documentsTable.obsoletedAt, cancelledAt: documentsTable.cancelledAt }).from(documentsTable),
    db.select({ currentQuantity: lotsTable.currentQuantity, expirationDate: lotsTable.expirationDate, sourceBatchId: lotsTable.sourceBatchId, itemType: lotsTable.itemType }).from(lotsTable),
    db.select({ destroyedAt: destructionRecordsTable.destroyedAt, weight: destructionRecordsTable.weight, weightUom: destructionRecordsTable.weightUom, cancelledAt: destructionRecordsTable.cancelledAt }).from(destructionRecordsTable),
    db.select({ id: inventoryChecksTable.id, completedAt: inventoryChecksTable.completedAt, cancelledAt: inventoryChecksTable.cancelledAt }).from(inventoryChecksTable),
    db.select({ checkId: inventoryCheckLinesTable.checkId, variance: inventoryCheckLinesTable.variance }).from(inventoryCheckLinesTable),
    db.select({ publishedDate: regulatoryUpdatesTable.publishedDate, createdAt: regulatoryUpdatesTable.createdAt, reviewedAt: regulatoryUpdatesTable.reviewedAt }).from(regulatoryUpdatesTable),
  ]);

  // ── Quality System — open now / opened / closed over the window ──────────────
  const quality = {
    nonConformances: tallyOpenClose(ncs, windowStartISO),
    capas: tallyOpenClose(capas, windowStartISO),
    complaints: tallyOpenClose(complaints, windowStartISO),
    fieldActions: tallyOpenClose(fas, windowStartISO),
  };

  // ── Operations — Production Yield (actual ÷ scheduled/expected) ───────────────
  let yieldSum = 0, yieldN = 0, batchesReleasedInWindow = 0;
  for (const b of batches) {
    const relISO = toISO(b.approvalDate);
    if (relISO && relISO >= windowStartISO) batchesReleasedInWindow += 1;
    const sched = b.scheduledOutputQuantity ?? 0;
    const out = b.outputQuantity ?? 0;
    const prodISO = toISO(b.productionDate) ?? relISO;
    if (sched > 0 && out > 0 && prodISO && prodISO >= windowStartISO) { yieldSum += out / sched; yieldN += 1; }
  }
  const productionYieldPct = yieldN > 0 ? Math.round((yieldSum / yieldN) * 1000) / 10 : null;

  // ── Operations — Lab Test First-Pass Rate (base pass rate; retest flag TODO) ──
  let pass = 0, fail = 0, pending = 0;
  for (const t of tests) {
    if (t.testResult === "Pending") { pending += 1; continue; }
    const rISO = toISO(t.resultDate);
    if (rISO && rISO >= windowStartISO) {
      if (t.testResult === "Pass") pass += 1;
      else if (t.testResult === "Fail") fail += 1;
    }
  }
  const testFirstPassRatePct = (pass + fail) > 0 ? Math.round((pass / (pass + fail)) * 1000) / 10 : null;

  // ── Supplier license status + risk-tier mix ──────────────────────────────────
  const latestExpiryBySupplier = new Map<number, string>();
  for (const q of quals) {
    if (!q.expiryDate) continue;
    if (q.status && NON_QUALIFYING_QUAL_STATUSES.has(q.status)) continue;
    const cur = latestExpiryBySupplier.get(q.supplierId);
    if (!cur || q.expiryDate > cur) latestExpiryBySupplier.set(q.supplierId, q.expiryDate);
  }
  let supTotal = 0, supRequired = 0, supCurrent = 0, supMissing = 0, supExpired = 0;
  const riskTier: Record<string, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 };
  for (const s of suppliers) {
    if (s.cancelledAt) continue;
    supTotal += 1;
    const tier = s.reviewedRiskTier ?? s.riskTier;
    if (tier) riskTier[tier] = (riskTier[tier] ?? 0) + 1;
    const required = (s.supplierType != null && LICENSE_REQUIRED_TYPES.has(s.supplierType)) || !!(s.licenseNumber && s.licenseNumber.trim());
    if (!required) continue;
    supRequired += 1;
    const exp = latestExpiryBySupplier.get(s.id) ?? null;
    if (!exp) supMissing += 1;
    else if (exp < nowISO) supExpired += 1;
    else supCurrent += 1;
  }

  // ── Inventory — materials vs finished (produced), expiring/expired ────────────
  // Current vocabulary (ITEM_TYPES in cannaqms/src/lib/units.ts) plus the older
  // strings, so lots received under the previous names keep counting as
  // Materials instead of silently falling through to Ingredients.
  const INVENTORY_MATERIAL_TYPES = new Set([
    "Packaging", "Label", "Component", "Nutrient", "Medium",
    "Packaging Material", "Hardware/Component",
  ]);
  let matLots = 0, finLots = 0, expiringSoon = 0, expired = 0;
  let invIngredients = 0, invMaterials = 0, invFinished = 0;
  for (const l of lots) {
    const qty = l.currentQuantity ?? 0;
    if (qty <= 0) continue;
    if (l.sourceBatchId != null) finLots += 1; else matLots += 1;
    // Volume by category (count of on-hand lots): produced lots = Finished Goods;
    // packaging/hardware/labels = Materials; everything else consumed = Ingredients.
    if (l.sourceBatchId != null) invFinished += 1;
    else if (l.itemType && INVENTORY_MATERIAL_TYPES.has(l.itemType)) invMaterials += 1;
    else invIngredients += 1;
    const exp = toISO(l.expirationDate);
    if (exp) { if (exp < nowISO) expired += 1; else if (exp <= soon60ISO) expiringSoon += 1; }
  }

  // ── Destruction / waste over the window ──────────────────────────────────────
  let destroyedCount = 0;
  const weightByUom: Record<string, number> = {};
  for (const d of destructions) {
    if (d.cancelledAt) continue;
    const dISO = toISO(d.destroyedAt);
    if (!dISO || dISO < windowStartISO) continue;
    destroyedCount += 1;
    const uom = d.weightUom ?? "—";
    weightByUom[uom] = Math.round(((weightByUom[uom] ?? 0) + (d.weight ?? 0)) * 100) / 100;
  }

  // ── METRC reconciliation (inventory checks) ──────────────────────────────────
  const inWindowCheckIds = new Set<number>();
  let checksCompleted = 0;
  for (const c of checks) {
    if (c.cancelledAt) continue;
    const cISO = toISO(c.completedAt);
    if (cISO && cISO >= windowStartISO) { checksCompleted += 1; inWindowCheckIds.add(c.id); }
  }
  let varianceLines = 0;
  for (const ln of checkLines) {
    if (inWindowCheckIds.has(ln.checkId) && (ln.variance ?? 0) !== 0) varianceLines += 1;
  }

  // ── Training compliance ──────────────────────────────────────────────────────
  let trTotal = 0, trCompleted = 0, trOverdue = 0;
  for (const t of training) {
    trTotal += 1;
    if (t.completedDate) trCompleted += 1;
    else if (t.dueDate && String(t.dueDate).slice(0, 10) < nowISO) trOverdue += 1;
  }
  const trainingCompliancePct = trTotal > 0 ? Math.round((trCompleted / trTotal) * 1000) / 10 : null;

  // ── Document control ─────────────────────────────────────────────────────────
  const soon90ISO = addDaysISO(90);
  const docMonthKeys: string[] = [];
  for (let i = 0; i < 3; i++) { const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)); docMonthKeys.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`); }
  const docMonthSet = new Set(docMonthKeys);
  const docDueByMonth: Record<string, number> = {};
  for (const k of docMonthKeys) docDueByMonth[k] = 0;
  let docActive = 0, docOverdue = 0, docDueSoon = 0, docWithReview = 0, docDueNext90 = 0;
  for (const d of docs) {
    if (d.cancelledAt || d.obsoletedAt) continue;
    docActive += 1;
    const nr = toISO(d.nextReviewDate);
    if (nr) {
      docWithReview += 1;
      if (nr < nowISO) docOverdue += 1;
      else {
        if (nr <= soon30ISO) docDueSoon += 1;
        if (nr <= soon90ISO) docDueNext90 += 1;
        const mk = nr.slice(0, 7);
        if (docMonthSet.has(mk)) docDueByMonth[mk] = (docDueByMonth[mk] ?? 0) + 1;
      }
    }
  }

  // ── Regulatory bulletins ─────────────────────────────────────────────────────
  let regInWindow = 0, regOpen = 0;
  for (const r of regUpdates) {
    const pISO = toISO(r.publishedDate) ?? toISO(r.createdAt);
    if (pISO && pISO >= windowStartISO) regInWindow += 1;
    if (!r.reviewedAt) regOpen += 1;
  }

  // ── CRA reportables (complaints) ─────────────────────────────────────────────
  let craTotal = 0, craOpen = 0;
  for (const c of complaints) {
    if (c.cancelledAt) continue;
    if (c.craReportable) { craTotal += 1; if (!c.closedAt) craOpen += 1; }
  }

  return {
    periodStart: windowStartISO,
    periodEnd: nowISO,
    quality,
    operations: {
      productionYieldPct,
      batchesReleasedInWindow,
      testFirstPassRatePct,
      testPass: pass, testFail: fail, testPending: pending,
    },
    suppliers: {
      total: supTotal,
      licenseRequired: supRequired,
      licenseCurrent: supCurrent,
      licenseMissing: supMissing,
      licenseExpired: supExpired,
      needsAttention: supMissing + supExpired,
      riskTier,
    },
    inventory: { materialLots: matLots, finishedGoodsLots: finLots, expiringSoon, expired, byCategory: { ingredients: invIngredients, materials: invMaterials, finishedGoods: invFinished } },
    destruction: { recordsInWindow: destroyedCount, weightByUom },
    metrcReconciliation: { checksCompletedInWindow: checksCompleted, varianceLinesInWindow: varianceLines },
    training: { total: trTotal, completed: trCompleted, overdue: trOverdue, compliancePct: trainingCompliancePct },
    documents: { active: docActive, overdueReview: docOverdue, dueSoon: docDueSoon, dueNext90: docDueNext90, withReview: docWithReview, dueByMonth: docMonthKeys.map((m) => ({ month: m, count: docDueByMonth[m] ?? 0 })) },
    regulatory: { bulletinsInWindow: regInWindow, openUnreviewed: regOpen },
    compliance: { craReportableTotal: craTotal, craReportableOpen: craOpen },
  };
}

async function persistSnapshot(trigger: "auto" | "manual", generatedByName: string | null) {
  const data = await computeManagementReview();
  const [row] = await db.insert(managementReviewSnapshotsTable).values({
    trigger,
    generatedByName,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    data,
  }).returning();
  return row;
}

// ── Routes ───────────────────────────────────────────────────────────────────
// GET the current Management Review — returns the latest stored snapshot,
// regenerating when there is none or the newest predates the current quarter
// (the "refresh on the first of each quarter" behavior, done lazily = no cron).
router.get("/management-review", async (req, res) => {
  try {
    const [latest] = await db.select().from(managementReviewSnapshotsTable).orderBy(desc(managementReviewSnapshotsTable.generatedAt)).limit(1);
    const qStart = quarterStart(new Date());
    const stale = !latest || new Date(latest.generatedAt).getTime() < qStart.getTime();
    const snap = stale ? await persistSnapshot("auto", null) : latest;
    res.json(snap);
  } catch (err) {
    req.log.error({ err }, "Failed to get management review");
    res.status(500).json({ error: "Failed to load management review" });
  }
});

// 2026-08-10 — LIVE QMS health for the Dashboard strip. The GET above returns a
// frozen snapshot (refreshes only quarterly / on the Update button), which is
// correct for the Management Review page but made the Dashboard's QMS Health
// strip drift from reality (e.g. NCs/CAPAs disagreeing with the live tiles right
// next to it). This computes the same shape on read and never persists, so the
// strip always shows current numbers.
router.get("/management-review/live", async (req, res) => {
  try {
    const data = await computeManagementReview();
    res.json({ data });
  } catch (err) {
    req.log.error({ err }, "Failed to load live QMS health");
    res.status(500).json({ error: "Failed to load live QMS health" });
  }
});

// POST — force a fresh snapshot now (the "Update" button).
router.post("/management-review/refresh", async (req, res) => {
  try {
    const generatedByName = ((req.body ?? {}) as { generatedByName?: string }).generatedByName ?? null;
    const snap = await persistSnapshot("manual", generatedByName);
    res.status(201).json(snap);
  } catch (err) {
    req.log.error({ err }, "Failed to refresh management review");
    res.status(500).json({ error: "Failed to refresh management review" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — recordable, 21 CFR Part 11-signed Management Review meeting.
// A review is created off the latest data snapshot; open action items from the
// most recent SIGNED review carry forward. Draft is editable; signing locks it.
// ─────────────────────────────────────────────────────────────────────────────
const MR_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.get("/management-review/reviews", async (req, res) => {
  try {
    const rows = await db.select().from(managementReviewsTable).orderBy(desc(managementReviewsTable.id));
    res.json(rows);
  } catch (err) { req.log.error({ err }, "list reviews"); res.status(500).json({ error: "Failed to list reviews" }); }
});

router.get("/management-review/reviews/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [review] = await db.select().from(managementReviewsTable).where(eq(managementReviewsTable.id, id));
    if (!review) { res.status(404).json({ error: "Review not found" }); return; }
    const actionItems = await db.select().from(managementReviewActionItemsTable)
      .where(eq(managementReviewActionItemsTable.reviewId, id)).orderBy(managementReviewActionItemsTable.id);
    let snapshot = null;
    if (review.snapshotId != null) {
      const [snap] = await db.select().from(managementReviewSnapshotsTable).where(eq(managementReviewSnapshotsTable.id, review.snapshotId));
      snapshot = snap ?? null;
    }
    res.json({ review, actionItems, snapshot });
  } catch (err) { req.log.error({ err }, "get review"); res.status(500).json({ error: "Failed to load review" }); }
});

router.post("/management-review/reviews", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!MR_ROLES.has(actor.role)) { res.status(403).json({ error: `Conducting a management review requires Manager, Quality, or Admin. Your role is "${actor.role}".` }); return; }
    // Base the review on the latest snapshot (regenerate none here — the page's
    // Update button owns snapshot refresh).
    const [snap] = await db.select().from(managementReviewSnapshotsTable).orderBy(desc(managementReviewSnapshotsTable.generatedAt)).limit(1);
    const reviewDate = facilityDateStr();
    const [review] = await db.insert(managementReviewsTable).values({
      snapshotId: snap?.id ?? null,
      reviewDate,
      periodStart: snap?.periodStart ?? null,
      periodEnd: snap?.periodEnd ?? null,
      status: "draft",
      attendees: [],
      sectionNotes: {},
      createdByUserId: actor.id,
      createdByName: actor.fullName,
    }).returning();
    // Carry forward open action items from the most recent SIGNED review.
    const [lastSigned] = await db.select().from(managementReviewsTable)
      .where(eq(managementReviewsTable.status, "signed")).orderBy(desc(managementReviewsTable.id)).limit(1);
    if (lastSigned) {
      const openItems = await db.select().from(managementReviewActionItemsTable)
        .where(and(eq(managementReviewActionItemsTable.reviewId, lastSigned.id), eq(managementReviewActionItemsTable.status, "Open")));
      for (const it of openItems) {
        await db.insert(managementReviewActionItemsTable).values({
          reviewId: review.id, description: it.description, ownerUserId: it.ownerUserId, ownerName: it.ownerName,
          dueDate: it.dueDate, status: "Open", carriedFromReviewId: lastSigned.id,
        });
      }
    }
    void db.insert(auditLogTable).values({ tableName: "management_reviews", rowId: review.id, operation: "CREATE_REVIEW", changedBy: actor.id, changedByName: actor.fullName, afterState: { snapshotId: snap?.id ?? null } as never }).catch(() => {});
    res.status(201).json(review);
  } catch (err) { req.log.error({ err }, "create review"); res.status(500).json({ error: "Failed to create review" }); }
});

router.patch("/management-review/reviews/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!MR_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const [existing] = await db.select().from(managementReviewsTable).where(eq(managementReviewsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Review not found" }); return; }
    if (existing.status === "signed") { res.status(409).json({ error: "This review is signed and can no longer be edited." }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["attendees", "sectionNotes", "outputs", "generalNotes", "reviewDate"]) {
      if (k in b) set[k] = b[k];
    }
    const [review] = await db.update(managementReviewsTable).set(set as never).where(eq(managementReviewsTable.id, id)).returning();
    res.json(review);
  } catch (err) { req.log.error({ err }, "patch review"); res.status(500).json({ error: "Failed to save review" }); }
});

router.post("/management-review/reviews/:id/action-items", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!MR_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const [review] = await db.select().from(managementReviewsTable).where(eq(managementReviewsTable.id, id));
    if (!review) { res.status(404).json({ error: "Review not found" }); return; }
    const b = (req.body ?? {}) as { description?: string; ownerUserId?: number; ownerName?: string; dueDate?: string };
    if (!b.description || !b.description.trim()) { res.status(400).json({ error: "A description is required." }); return; }
    const [item] = await db.insert(managementReviewActionItemsTable).values({
      reviewId: id, description: b.description.trim(), ownerUserId: b.ownerUserId ?? null, ownerName: b.ownerName ?? null, dueDate: b.dueDate ?? null, status: "Open",
    }).returning();
    res.status(201).json(item);
  } catch (err) { req.log.error({ err }, "add action item"); res.status(500).json({ error: "Failed to add action item" }); }
});

router.patch("/management-review/reviews/:id/action-items/:aid", async (req, res) => {
  try {
    const aid = parseInt(req.params.aid);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!MR_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["description", "ownerUserId", "ownerName", "dueDate"]) { if (k in b) set[k] = b[k]; }
    if ("status" in b) {
      set.status = b.status;
      if (b.status === "Done") { set.completedAt = new Date(); set.completedByName = actor.fullName; }
      else { set.completedAt = null; set.completedByName = null; }
    }
    const [item] = await db.update(managementReviewActionItemsTable).set(set as never).where(eq(managementReviewActionItemsTable.id, aid)).returning();
    if (!item) { res.status(404).json({ error: "Action item not found" }); return; }
    res.json(item);
  } catch (err) { req.log.error({ err }, "patch action item"); res.status(500).json({ error: "Failed to update action item" }); }
});

router.post("/management-review/reviews/:id/sign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!MR_ROLES.has(actor.role)) { res.status(403).json({ error: `Signing a management review requires Manager, Quality, or Admin. Your role is "${actor.role}".` }); return; }
    const [review] = await db.select().from(managementReviewsTable).where(eq(managementReviewsTable.id, id));
    if (!review) { res.status(404).json({ error: "Review not found" }); return; }
    if (review.status === "signed") { res.status(409).json({ error: "This review is already signed." }); return; }
    const b = (req.body ?? {}) as { initials?: string; signingMeaning?: string };
    const initials = (b.initials ?? "").trim();
    const meaning = (b.signingMeaning ?? "").trim();
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and a signing statement are required (21 CFR Part 11)." }); return; }
    const now = new Date();
    const [signed] = await db.update(managementReviewsTable).set({
      status: "signed", signedByUserId: actor.id, signedByName: actor.fullName,
      signedInitials: initials, signedMeaning: meaning, signedAt: now, updatedAt: now,
    }).where(eq(managementReviewsTable.id, id)).returning();
    void db.insert(auditLogTable).values({ tableName: "management_reviews", rowId: id, operation: "SIGN_REVIEW", changedBy: actor.id, changedByName: actor.fullName, afterState: { signedByName: actor.fullName } as never }).catch(() => {});
    res.json(signed);
  } catch (err) { req.log.error({ err }, "sign review"); res.status(500).json({ error: "Failed to sign review" }); }
});

export default router;
