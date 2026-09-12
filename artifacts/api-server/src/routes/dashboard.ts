import { Router } from "express";
import { db } from "@workspace/db";
import {
  batchRecordsTable,
  batchTestingTable,
  nonConformancesTable,
  complaintsTable,
  fieldActionsTable,
  packagingDesignsTable,
  auditLogTable,
  capasTable,
  capaActionItemsTable,
  trainingRecordsTable,
  supplierQualificationsTable,
  documentsTable,
  lotsTable,
  lotEventsTable,
} from "@workspace/db";
import { and, count, desc, eq, ne, inArray, notInArray, isNotNull, lte, gte, sql, or } from "drizzle-orm";
import { facilityDateStr } from "../lib/facilityDate";

const router = Router();

router.get("/dashboard/summary", async (req, res) => {
  try {
    const todayStr = facilityDateStr();
    const in14Days = new Date();
    in14Days.setUTCDate(in14Days.getUTCDate() + 14);
    const in14DaysStr = facilityDateStr(in14Days);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    sevenDaysAgo.setUTCHours(0, 0, 0, 0);

    const [
      batchCounts,
      ncCounts,
      criticalNcCounts,
      complaintCounts,
      criticalComplaintCounts,
      faCounts,
      packagingCounts,
      capaStatusCounts,
      overdueCapaItems,
      newAdverseEventCounts,
      newNcCounts,
      trainingTotalCounts,
      trainingCompletedCounts,
      trainingOverdueCounts,
      approvedQualCounts,
      expiredQualCounts,
      documentsUnderReviewCounts,
      approvedDocumentCounts,
      capaEffectivenessOverdueCounts,
      capaEffectivenessApproachingCounts,
    ] = await Promise.all([
      db
        .select({ status: batchRecordsTable.status, cnt: count() })
        .from(batchRecordsTable)
        .groupBy(batchRecordsTable.status),
      db
        .select({ cnt: count() })
        .from(nonConformancesTable)
        .where(ne(nonConformancesTable.status, "Closed")),
      db
        .select({ cnt: count() })
        .from(nonConformancesTable)
        .where(
          and(
            ne(nonConformancesTable.status, "Closed"),
            eq(nonConformancesTable.severity, "Critical")
          )
        ),
      db
        .select({ cnt: count() })
        .from(complaintsTable)
        .where(ne(complaintsTable.status, "Closed")),
      db
        .select({ cnt: count() })
        .from(complaintsTable)
        .where(
          and(
            ne(complaintsTable.status, "Closed"),
            inArray(complaintsTable.severity, ["Critical", "High"])
          )
        ),
      db
        .select({ cnt: count() })
        .from(fieldActionsTable)
        .where(ne(fieldActionsTable.status, "Closed")),
      db
        .select({ cnt: count() })
        .from(packagingDesignsTable)
        .where(
          and(
            ne(packagingDesignsTable.status, "Approved"),
            ne(packagingDesignsTable.status, "Superseded")
          )
        ),

      // CAPA counts by status (excluding Closed/Cancelled)
      db
        .select({ status: capasTable.status, cnt: count() })
        .from(capasTable)
        .where(notInArray(capasTable.status, ["Closed", "Cancelled"]))
        .groupBy(capasTable.status),

      // Overdue action items: incomplete items on active CAPAs past due date
      db
        .select({ cnt: count() })
        .from(capaActionItemsTable)
        .innerJoin(capasTable, eq(capaActionItemsTable.capaId, capasTable.id))
        .where(
          and(
            notInArray(capaActionItemsTable.status, ["Completed", "Verified"]),
            notInArray(capasTable.status, ["Closed", "Cancelled"]),
            isNotNull(capaActionItemsTable.dueDate),
            lte(capaActionItemsTable.dueDate, todayStr),
          )
        ),

      // Adverse event complaints opened in the past 7 days
      db
        .select({ cnt: count() })
        .from(complaintsTable)
        .where(
          and(
            sql`${complaintsTable.complaintType} = 'Adverse Event'`,
            gte(complaintsTable.createdAt, sevenDaysAgo),
          )
        ),

      // NCs opened in the past 7 days
      db
        .select({ cnt: count() })
        .from(nonConformancesTable)
        .where(gte(nonConformancesTable.createdAt, sevenDaysAgo)),

      // Training: total records
      db.select({ cnt: count() }).from(trainingRecordsTable),

      // Training: completed
      db
        .select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(eq(trainingRecordsTable.status, "Completed")),

      // Training: overdue (explicit overdue status OR past due date and not finished)
      db
        .select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(
          or(
            eq(trainingRecordsTable.status, "Overdue"),
            and(
              lte(trainingRecordsTable.dueDate, todayStr),
              isNotNull(trainingRecordsTable.dueDate),
              notInArray(trainingRecordsTable.status, ["Completed", "Waived", "Overdue"]),
            )
          )
        ),

      // Supplier qualifications: Passed (not expired)
      db
        .select({ cnt: count() })
        .from(supplierQualificationsTable)
        .where(eq(supplierQualificationsTable.status, "Passed")),

      // Supplier qualifications: Expired
      db
        .select({ cnt: count() })
        .from(supplierQualificationsTable)
        .where(eq(supplierQualificationsTable.status, "Expired")),

      // Documents: Under Review
      db
        .select({ cnt: count() })
        .from(documentsTable)
        .where(eq(documentsTable.status, "Under Review")),

      // Documents: Approved
      db
        .select({ cnt: count() })
        .from(documentsTable)
        .where(inArray(documentsTable.status, ["Approved", "Effective"])),

      // CAPA effectiveness checks overdue: due date passed, not yet verified, CAPA still active
      db
        .select({ cnt: count() })
        .from(capasTable)
        .where(
          and(
            notInArray(capasTable.status, ["Closed", "Cancelled"]),
            isNotNull(capasTable.effectivenessCheckDue),
            lte(capasTable.effectivenessCheckDue, todayStr),
            sql`${capasTable.effectivenessVerifiedAt} IS NULL`,
          )
        ),

      // CAPA effectiveness checks approaching: due within the next 14 days, not yet verified
      db
        .select({ cnt: count() })
        .from(capasTable)
        .where(
          and(
            notInArray(capasTable.status, ["Closed", "Cancelled"]),
            isNotNull(capasTable.effectivenessCheckDue),
            gte(capasTable.effectivenessCheckDue, todayStr),
            lte(capasTable.effectivenessCheckDue, in14DaysStr),
            sql`${capasTable.effectivenessVerifiedAt} IS NULL`,
          )
        ),
    ]);

    const batchStatusMap: Record<string, number> = {};
    batchCounts.forEach((r) => {
      batchStatusMap[r.status] = Number(r.cnt);
    });

    // Actual batch state enum values used in the DB
    const batchesInProduction = batchStatusMap["in_production"] ?? 0;
    const batchesPendingRelease =
      (batchStatusMap["passed_awaiting_packaging"] ?? 0) +
      (batchStatusMap["testing_in_progress"] ?? 0);

    const openCAPAs = capaStatusCounts.reduce((s, r) => s + Number(r.cnt), 0);
    const capaByStatus = capaStatusCounts.map((r) => ({
      status: r.status,
      count: Number(r.cnt),
    }));

    const trainingTotal = Number(trainingTotalCounts[0]?.cnt ?? 0);
    const trainingCompleted = Number(trainingCompletedCounts[0]?.cnt ?? 0);
    const trainingCompletionRate =
      trainingTotal > 0 ? Math.round((trainingCompleted / trainingTotal) * 100) : 0;

    res.json({
      batchesInProduction,
      batchesPendingRelease,
      openNonConformances: Number(ncCounts[0]?.cnt ?? 0),
      criticalNCs: Number(criticalNcCounts[0]?.cnt ?? 0),
      openComplaints: Number(complaintCounts[0]?.cnt ?? 0),
      criticalComplaints: Number(criticalComplaintCounts[0]?.cnt ?? 0),
      openFieldActions: Number(faCounts[0]?.cnt ?? 0),
      packagingPendingReview: Number(packagingCounts[0]?.cnt ?? 0),
      openCAPAs,
      overdueCapaActionItems: Number(overdueCapaItems[0]?.cnt ?? 0),
      capaByStatus,
      newAdverseEventsThisWeek: Number(newAdverseEventCounts[0]?.cnt ?? 0),
      newNCsThisWeek: Number(newNcCounts[0]?.cnt ?? 0),
      trainingOverdue: Number(trainingOverdueCounts[0]?.cnt ?? 0),
      trainingCompletionRate,
      approvedSupplierQuals: Number(approvedQualCounts[0]?.cnt ?? 0),
      expiredSupplierQuals: Number(expiredQualCounts[0]?.cnt ?? 0),
      documentsUnderReview: Number(documentsUnderReviewCounts[0]?.cnt ?? 0),
      approvedDocuments: Number(approvedDocumentCounts[0]?.cnt ?? 0),
      capaEffectivenessOverdue: Number(capaEffectivenessOverdueCounts[0]?.cnt ?? 0),
      capaEffectivenessApproaching: Number(capaEffectivenessApproachingCounts[0]?.cnt ?? 0),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get dashboard summary");
    res.status(500).json({ error: "Failed to get dashboard summary" });
  }
});

router.get("/dashboard/batch-status-breakdown", async (req, res) => {
  try {
    const breakdown = await db
      .select({ status: batchRecordsTable.status, cnt: count() })
      .from(batchRecordsTable)
      .groupBy(batchRecordsTable.status);
    res.json(
      breakdown.map((r) => ({ status: r.status, count: Number(r.cnt) }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get batch breakdown");
    res.status(500).json({ error: "Failed to get batch breakdown" });
  }
});

router.get("/dashboard/recent-activity", async (req, res) => {
  try {
    const { limit = "20" } = req.query;
    const activity = await db
      .select()
      .from(auditLogTable)
      .orderBy(desc(auditLogTable.changedAt))
      .limit(parseInt(String(limit)));
    res.json(activity);
  } catch (err) {
    req.log.error({ err }, "Failed to get recent activity");
    res.status(500).json({ error: "Failed to get recent activity" });
  }
});

router.get("/dashboard/open-items", async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    sevenDaysAgo.setUTCHours(0, 0, 0, 0);

    const [ncs, complaints, fas, rawCapas, newAdverseEvents, newNCs] = await Promise.all([
      db
        .select()
        .from(nonConformancesTable)
        .where(ne(nonConformancesTable.status, "Closed"))
        .orderBy(desc(nonConformancesTable.createdAt))
        .limit(8),
      db
        .select()
        .from(complaintsTable)
        .where(ne(complaintsTable.status, "Closed"))
        .orderBy(desc(complaintsTable.createdAt))
        .limit(8),
      db
        .select()
        .from(fieldActionsTable)
        .where(ne(fieldActionsTable.status, "Closed"))
        .orderBy(desc(fieldActionsTable.createdAt))
        .limit(8),
      db
        .select()
        .from(capasTable)
        .where(notInArray(capasTable.status, ["Closed", "Cancelled"]))
        .orderBy(desc(capasTable.createdAt))
        .limit(10),

      // Adverse event complaints opened in the past 7 days
      db
        .select()
        .from(complaintsTable)
        .where(
          and(
            sql`${complaintsTable.complaintType} = 'Adverse Event'`,
            gte(complaintsTable.createdAt, sevenDaysAgo),
          )
        )
        .orderBy(desc(complaintsTable.createdAt))
        .limit(20),

      // NCs opened in the past 7 days
      db
        .select()
        .from(nonConformancesTable)
        .where(gte(nonConformancesTable.createdAt, sevenDaysAgo))
        .orderBy(desc(nonConformancesTable.createdAt))
        .limit(20),
    ]);

    // Enrich each CAPA with action item counts
    const capas = await Promise.all(
      rawCapas.map(async (c) => {
        const items = await db
          .select({ status: capaActionItemsTable.status })
          .from(capaActionItemsTable)
          .where(eq(capaActionItemsTable.capaId, c.id));
        return {
          id: c.id,
          capaNumber: c.capaNumber,
          type: c.type,
          title: c.title,
          status: c.status,
          openedByName: c.openedByName,
          effectivenessCheckDue: c.effectivenessCheckDue,
          openActionItems: items.filter((i) => i.status !== "Completed" && i.status !== "Verified").length,
          totalActionItems: items.length,
          createdAt: c.createdAt.toISOString(),
        };
      })
    );

    res.json({ nonConformances: ncs, complaints, fieldActions: fas, capas, newAdverseEvents, newNCs });
  } catch (err) {
    req.log.error({ err }, "Failed to get open items");
    res.status(500).json({ error: "Failed to get open items" });
  }
});

// Session 37 (Tier 3 #15) — Operations dashboard testing aggregates. Returns
// pass/fail/pending counts over a rolling window plus the average turnaround
// time (samplePulledAt or submittedDate → resultDate) for results received
// within the window. Single aggregate query so the Operations section can
// render testing metrics without iterating every batch's test rows.
router.get("/dashboard/testing-metrics", async (req, res) => {
  try {
    const daysParam = parseInt((req.query.days as string | undefined) ?? "90", 10);
    const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 90;
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - days);
    const windowStartStr = facilityDateStr(windowStart);

    // Pull only the columns we need for the aggregate. Filtering on the
    // result side: rows with resultDate within the window are counted into
    // pass/fail; rows still in "Pending" are counted regardless of date.
    const rows = await db
      .select({
        testResult: batchTestingTable.testResult,
        phase: batchTestingTable.phase,
        resultDate: batchTestingTable.resultDate,
        submittedDate: batchTestingTable.submittedDate,
        samplePulledAt: batchTestingTable.samplePulledAt,
      })
      .from(batchTestingTable);

    let passCount = 0;
    let failCount = 0;
    let pendingCount = 0;
    let turnaroundDaySum = 0;
    let turnaroundDayN = 0;

    for (const r of rows) {
      const inWindow = r.resultDate && r.resultDate >= windowStartStr;
      if (r.testResult === "Pending") {
        // Pending rows: count anything still awaiting result, regardless of
        // when it was pulled. The operator wants to see the actual backlog.
        pendingCount += 1;
      } else if (inWindow && r.testResult === "Pass") {
        passCount += 1;
      } else if (inWindow && r.testResult === "Fail") {
        failCount += 1;
      }
      // Turnaround: prefer samplePulledAt (Session 36 pre-test row); fall
      // back to submittedDate (the legacy "sample sent to lab" date) for
      // rows that pre-date the pre-test lifecycle. Only count rows with both
      // ends populated and a real result.
      if (inWindow && r.resultDate && r.testResult !== "Pending") {
        const start = r.samplePulledAt ?? r.submittedDate;
        if (start) {
          const ms = new Date(r.resultDate + "T00:00:00Z").getTime() - new Date(start + "T00:00:00Z").getTime();
          const dayDelta = ms / 86_400_000;
          if (Number.isFinite(dayDelta) && dayDelta >= 0) {
            turnaroundDaySum += dayDelta;
            turnaroundDayN += 1;
          }
        }
      }
    }

    res.json({
      windowDays: days,
      passCount,
      failCount,
      pendingCount,
      avgTurnaroundDays: turnaroundDayN > 0 ? Math.round((turnaroundDaySum / turnaroundDayN) * 10) / 10 : null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get testing metrics");
    res.status(500).json({ error: "Failed to get testing metrics" });
  }
});

// Session 97 (#3 management analytics) — monthly trend series for a management
// overview: quality events opened/closed, batches made/released, material consumed
// (by unit — units aren't summable across materials), and average yield (schedule
// attainment = output ÷ scheduled). Bucketing is done in JS so it stays DB-dialect
// agnostic; QMS record volumes are small. `?months=` clamps to 1..12 (default 6).
router.get("/dashboard/management-trends", async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(String(req.query.months ?? "6"), 10) || 6, 1), 12);
    const now = new Date();
    const buckets: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      buckets.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    const bucketSet = new Set(buckets);
    const monthKey = (v: Date | string | null | undefined): string | null => {
      if (!v) return null;
      const dt = typeof v === "string" ? new Date(v.length <= 10 ? v + "T00:00:00Z" : v) : v;
      if (Number.isNaN(dt.getTime())) return null;
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    };

    // Per-month accumulators.
    type Row = { month: string; qualityOpened: number; qualityClosed: number; batchesMade: number; batchesReleased: number; yieldSum: number; yieldN: number };
    const rows = new Map<string, Row>();
    for (const m of buckets) rows.set(m, { month: m, qualityOpened: 0, qualityClosed: 0, batchesMade: 0, batchesReleased: 0, yieldSum: 0, yieldN: 0 });
    const consumedByUnit = new Map<string, Map<string, number>>(); // month -> unit -> qty
    for (const m of buckets) consumedByUnit.set(m, new Map());

    const bumpOpened = (v: Date | string | null | undefined) => { const k = monthKey(v); if (k && bucketSet.has(k)) rows.get(k)!.qualityOpened++; };
    const bumpClosed = (v: Date | string | null | undefined) => { const k = monthKey(v); if (k && bucketSet.has(k)) rows.get(k)!.qualityClosed++; };

    const [ncs, capas, complaints, fas, batches, consumeRows] = await Promise.all([
      db.select({ createdAt: nonConformancesTable.createdAt, closedAt: nonConformancesTable.closedAt }).from(nonConformancesTable),
      db.select({ createdAt: capasTable.createdAt, closedAt: capasTable.closedAt }).from(capasTable),
      db.select({ receivedDate: complaintsTable.receivedDate, closedAt: complaintsTable.closedAt }).from(complaintsTable),
      db.select({ createdAt: fieldActionsTable.createdAt, closedAt: fieldActionsTable.closedAt }).from(fieldActionsTable),
      db.select({
        createdAt: batchRecordsTable.createdAt,
        productionDate: batchRecordsTable.productionDate,
        approvalDate: batchRecordsTable.approvalDate,
        outputQuantity: batchRecordsTable.outputQuantity,
        scheduledOutputQuantity: batchRecordsTable.scheduledOutputQuantity,
      }).from(batchRecordsTable),
      db.select({ createdAt: lotEventsTable.createdAt, quantityDelta: lotEventsTable.quantityDelta, unitOfMeasure: lotsTable.unitOfMeasure })
        .from(lotEventsTable)
        .innerJoin(lotsTable, eq(lotEventsTable.lotId, lotsTable.id))
        .where(eq(lotEventsTable.eventType, "consume")),
    ]);

    for (const r of ncs)        { bumpOpened(r.createdAt); bumpClosed(r.closedAt); }
    for (const r of capas)      { bumpOpened(r.createdAt); bumpClosed(r.closedAt); }
    for (const r of complaints) { bumpOpened(r.receivedDate); bumpClosed(r.closedAt); }
    for (const r of fas)        { bumpOpened(r.createdAt); bumpClosed(r.closedAt); }

    let producedReleasedThisPeriod = 0;
    for (const b of batches) {
      const madeK = monthKey(b.createdAt);
      if (madeK && bucketSet.has(madeK)) rows.get(madeK)!.batchesMade++;
      const relK = monthKey(b.approvalDate);
      if (relK && bucketSet.has(relK)) { rows.get(relK)!.batchesReleased++; producedReleasedThisPeriod++; }
      // Yield = actual ÷ scheduled output, bucketed by production month (fallback release/created).
      const sched = b.scheduledOutputQuantity ?? 0;
      const out = b.outputQuantity ?? 0;
      if (sched > 0 && out > 0) {
        const yk = monthKey(b.productionDate) ?? relK ?? madeK;
        if (yk && bucketSet.has(yk)) { const row = rows.get(yk)!; row.yieldSum += out / sched; row.yieldN++; }
      }
    }

    for (const e of consumeRows) {
      const k = monthKey(e.createdAt);
      if (!k || !bucketSet.has(k)) continue;
      const unit = (e.unitOfMeasure ?? "ea").trim() || "ea";
      const qty = Math.abs(e.quantityDelta ?? 0);
      if (qty === 0) continue;
      const um = consumedByUnit.get(k)!;
      um.set(unit, (um.get(unit) ?? 0) + qty);
    }

    const units = Array.from(new Set(Array.from(consumedByUnit.values()).flatMap((m) => Array.from(m.keys())))).sort();
    const trend = buckets.map((m) => {
      const r = rows.get(m)!;
      const cu: Record<string, number> = {};
      for (const u of units) cu[u] = Math.round((consumedByUnit.get(m)!.get(u) ?? 0) * 100) / 100;
      return {
        month: m,
        qualityOpened: r.qualityOpened,
        qualityClosed: r.qualityClosed,
        batchesMade: r.batchesMade,
        batchesReleased: r.batchesReleased,
        yieldPct: r.yieldN > 0 ? Math.round((r.yieldSum / r.yieldN) * 1000) / 10 : null,
        consumedByUnit: cu,
      };
    });

    res.json({ months, units, producedReleasedThisPeriod, trend });
  } catch (err) {
    req.log.error({ err }, "Failed to get management trends");
    res.status(500).json({ error: "Failed to get management trends" });
  }
});

export default router;
