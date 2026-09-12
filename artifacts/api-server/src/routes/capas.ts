import { Router } from "express";
import { db } from "@workspace/db";
import { capasTable, capaActionItemsTable, nonConformancesTable, complaintsTable, auditLogTable, type CapaStage } from "@workspace/db";
import { eq, sql, ne, and, isNull, like } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { suggestEffectivenessChecks } from "../lib/aiClient";
import { facilityDateStr } from "../lib/facilityDate";

async function writeAuditLog(opts: {
  rowId: number;
  operation: string;
  changedByName?: string | null;
  changedById?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "capas",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

const router = Router();

const CAPA_STATUS_ORDER = [
  "Open",
  "Root Cause Analysis",
  "Action Planning",
  "Implementation",
  "Effectiveness Check",
  "Closed",
];

// Generates the next CAPA number for the current year. Uses MAX of the parsed
// sequence portion of existing capa_number values within this year, NOT
// count(*). This guarantees:
//   • No reuse — deleting a CAPA never returns its number to the pool (Part 11).
//   • Year-scoped — each calendar year restarts at 0001.
//   • Monotonic — numbers only ever increase within a year.
// Race-condition note: small TOCTOU window between SELECT and INSERT. The
// unique constraint on capa_number is the hard backstop; a Postgres sequence
// per year is the long-term fix.
async function generateCapaNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `CAPA-${year}-`;
  const rows = await db
    .select({ capaNumber: capasTable.capaNumber })
    .from(capasTable)
    .where(like(capasTable.capaNumber, `${prefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = r.capaNumber.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

// ── List / Create ─────────────────────────────────────────────────────────────

router.get("/capas", async (req, res) => {
  try {
    let capas = await db.select().from(capasTable).orderBy(capasTable.createdAt);
    // Session 52.1 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled CAPAs (the Cancelled view). Cancel is the no-hard-delete pattern.
    const cancelled = req.query.cancelled === "true";
    capas = cancelled ? capas.filter((c) => c.cancelledAt) : capas.filter((c) => !c.cancelledAt);
    // Enrich with action item counts
    const enriched = await Promise.all(
      capas.map(async (c) => {
        const items = await db
          .select({ status: capaActionItemsTable.status })
          .from(capaActionItemsTable)
          .where(eq(capaActionItemsTable.capaId, c.id));
        return {
          ...c,
          actionItemCount: items.length,
          openActionItems: items.filter((i) => i.status !== "Completed" && i.status !== "Verified").length,
        };
      })
    );
    res.json(enriched.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list CAPAs");
    res.status(500).json({ error: "Failed to list CAPAs" });
  }
});

// POST /capas — create. Server stamps openedBy from session (no client spoofing)
// and rejects any client attempt to set lifecycle/signature fields.
const CAPA_CREATE_ALLOWED = new Set([
  "type",
  "title",
  "description",
  "sourceNcId",
  "sourceComplaintId",
  "rootCauseAnalysis",
  "rcaMethod",
  "effectivenessCriteria",
  "effectivenessCheckDue",
  // Session 12 additions.
  "productType",
  "productName",
  "lotNumber",
  "department",
  "rootCauses",
  "investigationDueDate",
  "actionPlanningDueDate",
  "ecPlanningDueDate",
  "correctionPaClosureDueDate",
  "ecCheckClosureDueDate",
  // Session 34 (Tier 2 #10) — initial Risk classification at open.
  "riskLevel",
  "riskRationale",
  "riskReleased",
  "riskCustomerAffected",
  "riskLabelingImpact",
  "riskInHouseOnly",
  "riskPreBulk",
]);

// Session 34 (Tier 2 #10) — risk taxonomy mirrors NC severity for consistency
// across the system. Operator picks; the structured booleans are guidance, not
// auto-compute inputs.
const CAPA_RISK_LEVELS = new Set(["Critical", "High", "Medium", "Low"]);

// Session 34 (Tier 2 #11) — per-phase due-date defaults. Investigation is
// stamped at CAPA open (operator can override). Action Planning + EC Planning
// stamp on phase entry through /advance-stage. All values in calendar days.
const PHASE_DUE_DEFAULTS = {
  investigation: 30,
  actionPlanning: 15,
  ecPlanning: 15,
  // 2026-08-27, his call: closure of the corrective/preventive actions defaults to
  // 90 days from the day the CAPA is raised — not from when planning finishes,
  // because the clock a CAPA is judged on runs from the problem being found.
  // Effectiveness Check Closure is deliberately left unset: how long an effectiveness
  // check needs depends on what is being checked, and a wrong default is worse than
  // an empty field somebody has to think about.
  correctionPaClosure: 90,
} as const;

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return facilityDateStr(d);
}

router.post("/capas", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (CAPA_CREATE_ALLOWED.has(k)) safe[k] = v;
    }
    if (!safe.title || !safe.description) {
      res.status(400).json({ error: "title and description are required." }); return;
    }

    // Session 34 (Tier 2 #10) — Risk classification is required at open. The
    // rationale must be non-empty so the Track C Risk Memory agent has a
    // documented reason to learn from later.
    const riskLevel = (safe.riskLevel as string | undefined)?.trim();
    if (!riskLevel || !CAPA_RISK_LEVELS.has(riskLevel)) {
      res.status(400).json({
        error: `Risk level is required at CAPA open (Critical | High | Medium | Low). Got: "${safe.riskLevel ?? ""}".`,
      });
      return;
    }
    const riskRationale = (safe.riskRationale as string | undefined)?.trim();
    if (!riskRationale) {
      res.status(400).json({
        error: "Risk rationale is required at CAPA open — document why you chose this risk level.",
      });
      return;
    }
    safe.riskLevel = riskLevel;
    safe.riskRationale = riskRationale;

    // Session 34 (Tier 2 #11) — Investigation due date defaults to +30 days
    // from today if the operator didn't supply one. The other two phase due
    // dates stamp on /advance-stage when their phase begins. Keeping the
    // default at the SQL boundary so a regen of the orval client doesn't have
    // to know about it.
    if (!safe.investigationDueDate) {
      safe.investigationDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.investigation);
    }
    if (!safe.correctionPaClosureDueDate) {
      safe.correctionPaClosureDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.correctionPaClosure);
    }

    const capaNumber = await generateCapaNumber();
    const [capa] = await db
      .insert(capasTable)
      .values({
        ...safe,
        capaNumber,
        // Set both legacy status (linear flow) and new stage (gated flow).
        // openedBy* records the system-recorded creator; originator* is the
        // editable Part 11 "who is responsible for this CAPA" field that
        // segregation-of-duties checks read from.
        status: "Open",
        stage: "Initiation",
        openedById: actor.id,
        openedByName: actor.fullName,
        originatorId: actor.id,
        originatorName: actor.fullName,
      } as typeof capasTable.$inferInsert)
      .returning();
    void writeAuditLog({
      rowId: capa.id,
      operation: "INSERT",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: capa as unknown as Record<string, unknown>,
    });
    res.status(201).json(capa);
  } catch (err) {
    req.log.error({ err }, "Failed to create CAPA");
    res.status(500).json({ error: "Failed to create CAPA" });
  }
});

// ── Single CAPA ───────────────────────────────────────────────────────────────

router.get("/capas/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }

    const actionItems = await db
      .select()
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id))
      .orderBy(capaActionItemsTable.sequenceNumber);

    // Optionally attach linked NC/complaint summaries
    let sourceNc = null;
    let sourceComplaint = null;
    if (capa.sourceNcId) {
      const [nc] = await db
        .select({ id: nonConformancesTable.id, ncNumber: nonConformancesTable.ncNumber, title: nonConformancesTable.title, severity: nonConformancesTable.severity, status: nonConformancesTable.status })
        .from(nonConformancesTable)
        .where(eq(nonConformancesTable.id, capa.sourceNcId));
      sourceNc = nc ?? null;
    }
    if (capa.sourceComplaintId) {
      const [cmp] = await db
        .select({ id: complaintsTable.id, complaintNumber: complaintsTable.complaintNumber, complaintType: complaintsTable.complaintType, severity: complaintsTable.severity, status: complaintsTable.status })
        .from(complaintsTable)
        .where(eq(complaintsTable.id, capa.sourceComplaintId));
      sourceComplaint = cmp ?? null;
    }

    res.json({ ...capa, actionItems, sourceNc, sourceComplaint });
  } catch (err) {
    req.log.error({ err }, "Failed to get CAPA");
    res.status(500).json({ error: "Failed to get CAPA" });
  }
});

// PATCH is restricted to safe metadata only. Lifecycle/signature fields
// (status, closedAt, closedBy*, effectivenessVerified*, openedBy*) MUST flow
// through the dedicated workflow endpoints (/advance, /verify-effectiveness,
// /close, /action-items/:id/verify) so Part 11 controls cannot be bypassed.
const CAPA_PATCH_ALLOWED = new Set([
  "type",
  "title",
  "description",
  "rootCauseAnalysis",
  "rcaMethod", // legacy single-value, still accepted
  "rcaMethods", // new multi-select array
  "rcaInvestigatorName", // who ran the investigation — often not the CAPA owner
  "effectivenessCriteria",
  "effectivenessCheckDue",
  // Originator can be reassigned (e.g. departing employee). Audit-logged.
  "originatorId",
  "originatorName",
  // EC Owner assignment — additional server-side segregation validation runs
  // after the patch goes through (see /capas/:id/effectiveness-owner below).
  "effectivenessOwnerId",
  "effectivenessOwnerName",
  // Session 12 additions.
  "productType",
  "productName",
  "lotNumber",
  "department",
  "rootCauses",
  "investigationDueDate",
  "actionPlanningDueDate",
  "ecPlanningDueDate",
  "correctionPaClosureDueDate",
  "ecCheckClosureDueDate",
  // Session 34 (Tier 2 #10) — Risk can be revised during Investigation. Any
  // change to riskLevel must come with a riskRevisedReason in the same body
  // (server validation below). The five boolean prompts and the rationale
  // are also editable while the CAPA is open.
  "riskLevel",
  "riskRationale",
  "riskReleased",
  "riskCustomerAffected",
  "riskLabelingImpact",
  "riskInHouseOnly",
  "riskPreBulk",
  "riskRevisedReason",
]);

// Session 34 (Tier 2 #11) — EC > MAX(corrective-action due date) helper.
// Used by both the CAPA PATCH (when setting effectivenessCheckDue) and by the
// action-item POST/PATCH endpoints (when changing dueDate). Returns an error
// message if the proposed state violates the order, or null when it's clean.
async function ecVsCorrectiveActionError(
  capaId: number,
  proposedEcDue: string | null,
  ignoreActionItemId: number | null = null,
): Promise<string | null> {
  if (!proposedEcDue) return null;
  const rows = await db
    .select({ id: capaActionItemsTable.id, dueDate: capaActionItemsTable.dueDate })
    .from(capaActionItemsTable)
    .where(eq(capaActionItemsTable.capaId, capaId));
  let maxDue: string | null = null;
  for (const r of rows) {
    if (ignoreActionItemId != null && r.id === ignoreActionItemId) continue;
    if (!r.dueDate) continue;
    if (maxDue == null || r.dueDate > maxDue) maxDue = r.dueDate;
  }
  if (maxDue && proposedEcDue <= maxDue) {
    return `Effectiveness Check due date (${proposedEcDue}) must be after every corrective action's due date. The latest action item due date is ${maxDue}. Move EC out, or move the action item in.`;
  }
  return null;
}

router.patch("/capas/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    const rejected: string[] = [];
    // Session 52.1 — the cancelled_* fields are managed only by /cancel +
    // /uncancel; silently strip them from any field-edit PATCH (never reject).
    const CANCEL_FIELDS = new Set([
      "cancelledAt", "cancelledReason", "cancelledByName",
      "cancelledByInitials", "cancelledMeaning",
    ]);
    for (const [k, v] of Object.entries(incoming)) {
      if (k === "changedByName" || k === "userId" || k === "updatedAt") continue;
      if (CANCEL_FIELDS.has(k)) continue;
      if (CAPA_PATCH_ALLOWED.has(k)) filtered[k] = v;
      else rejected.push(k);
    }
    if (rejected.length > 0) {
      res.status(400).json({
        error: `These fields cannot be updated via PATCH (use the workflow endpoints): ${rejected.join(", ")}`,
      });
      return;
    }

    const [before] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!before) { res.status(404).json({ error: "CAPA not found" }); return; }
    // Session 52.1.1 — a cancelled CAPA is read-only (Re-open via /uncancel first).
    if (before.cancelledAt) {
      res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return;
    }
    if (before.status === "Closed" || before.stage === "Closed") {
      res.status(400).json({ error: "Closed CAPAs are read-only." }); return;
    }

    // After Gate 1 approval, the problem-statement / RCA / action-plan /
    // EC-plan bundle is immutable (Part 11). Approved sections can only be
    // re-opened by going through a Gate 1 rejection or restart.
    const stagesAfterGate1: CapaStage[] = ["Action Execution", "EC Execution", "Closed"];
    if (stagesAfterGate1.includes(before.stage as CapaStage)) {
      const lockedAfterGate1 = ["title", "description", "rootCauseAnalysis", "rcaMethod", "rcaMethods", "rcaInvestigatorName", "effectivenessCriteria", "effectivenessCheckDue", "effectivenessOwnerId", "effectivenessOwnerName"];
      const attempted = lockedAfterGate1.filter((f) => Object.prototype.hasOwnProperty.call(filtered, f));
      if (attempted.length > 0) {
        res.status(409).json({
          error: `Cannot modify ${attempted.join(", ")} after Gate 1 approval. Reject the CAPA and reopen the relevant stage to make changes (21 CFR Part 11).`,
        });
        return;
      }
    }

    // Session 34 (Tier 2 #10) — Risk revision flow. Any change to riskLevel
    // on an existing CAPA must come with a riskRevisedReason in the same
    // PATCH body. The server stamps lineage (revisedAt / revisedByName /
    // revisedFrom) and writes a RISK_REVISED audit_log entry. The change
    // itself is only allowed while the CAPA is open (the pre-Closed guard
    // above already gates the entire PATCH).
    const newRiskLevel = filtered.riskLevel as string | undefined;
    const oldRiskLevel = before.riskLevel;
    const riskChanging =
      Object.prototype.hasOwnProperty.call(filtered, "riskLevel") &&
      newRiskLevel !== oldRiskLevel;
    const riskRevisedReason = (filtered.riskRevisedReason as string | undefined)?.trim() ?? "";
    if (riskChanging) {
      if (newRiskLevel && !CAPA_RISK_LEVELS.has(newRiskLevel)) {
        res.status(400).json({
          error: `Invalid risk level "${newRiskLevel}". Must be Critical | High | Medium | Low.`,
        });
        return;
      }
      if (!riskRevisedReason) {
        res.status(400).json({
          error: `Risk revision requires a reason. Document why you're moving Risk from "${oldRiskLevel ?? "(unset)"}" to "${newRiskLevel}".`,
        });
        return;
      }
      // Stamp lineage server-side; never let the client spoof these.
      filtered.riskRevisedReason = riskRevisedReason;
      filtered.riskRevisedAt = new Date();
      filtered.riskRevisedByName = actor.fullName;
      filtered.riskRevisedFrom = oldRiskLevel ?? null;
    } else if (Object.prototype.hasOwnProperty.call(filtered, "riskRevisedReason")) {
      // Reason is only meaningful in tandem with a real change — drop a
      // stray reason if the level didn't move so the audit log stays clean.
      delete filtered.riskRevisedReason;
    }

    // Session 34 (Tier 2 #11) — EC due date must be after every corrective
    // action's due date. Enforced here whenever effectivenessCheckDue is
    // being set or cleared via PATCH. The action-item endpoints enforce
    // the same constraint from their side.
    if (Object.prototype.hasOwnProperty.call(filtered, "effectivenessCheckDue")) {
      const proposed = (filtered.effectivenessCheckDue as string | null) ?? null;
      const ecErr = await ecVsCorrectiveActionError(id, proposed);
      if (ecErr) { res.status(409).json({ error: ecErr }); return; }
    }

    // Effectiveness Check Owner segregation: cannot equal originator and
    // cannot equal any action item owner.
    // Part 11 segregation of duties: the person who checks whether a CAPA worked
    // should not be the person who raised it or the person who did the work.
    //
    // 2026-08-28 — OVERRIDABLE with a written reason. Jonathan: "Some locations may
    // not have enough people to complete a CAPA if we do that." At a three-person
    // site the rule can leave nobody eligible, and a control that makes the work
    // impossible gets worked around outside the system, which is worse than one that
    // records why it was set aside. The rule stays the default; the exception has to
    // be explained and is stamped with who explained it.
    const overrideReason = typeof (req.body ?? {}).ecOwnerSegregationOverrideReason === "string"
      ? String(req.body.ecOwnerSegregationOverrideReason).trim()
      : "";
    if (Object.prototype.hasOwnProperty.call(filtered, "effectivenessOwnerId")) {
      const newOwnerId = filtered.effectivenessOwnerId == null ? null : Number(filtered.effectivenessOwnerId);
      if (newOwnerId != null) {
        const originatorId = (filtered.originatorId as number | undefined) ?? before.originatorId;
        const actionOwners = await db
          .select({ assignedToId: capaActionItemsTable.assignedToId })
          .from(capaActionItemsTable)
          .where(eq(capaActionItemsTable.capaId, id));

        const conflicts: string[] = [];
        if (originatorId != null && newOwnerId === originatorId) conflicts.push("the CAPA originator");
        if (actionOwners.some((a) => a.assignedToId === newOwnerId)) conflicts.push("an action item owner on this CAPA");

        if (conflicts.length > 0 && !overrideReason) {
          res.status(409).json({
            error: `Effectiveness Check Owner is ${conflicts.join(" and ")} (21 CFR Part 11 segregation of duties). If nobody else is available, assign them with a written reason.`,
            requiresSegregationOverride: true,
            conflicts,
          });
          return;
        }
        if (conflicts.length > 0) {
          filtered.ecOwnerSegregationOverrideReason = overrideReason;
          filtered.ecOwnerSegregationOverrideBy = actor.fullName;
          filtered.ecOwnerSegregationOverrideAt = new Date();
        } else {
          // A compliant assignment clears any earlier exception — the record should
          // not keep claiming an override that no longer applies.
          filtered.ecOwnerSegregationOverrideReason = null;
          filtered.ecOwnerSegregationOverrideBy = null;
          filtered.ecOwnerSegregationOverrideAt = null;
        }
      } else {
        filtered.ecOwnerSegregationOverrideReason = null;
        filtered.ecOwnerSegregationOverrideBy = null;
        filtered.ecOwnerSegregationOverrideAt = null;
      }
    }

    const [capa] = await db
      .update(capasTable)
      .set({ ...filtered, updatedAt: new Date() })
      .where(eq(capasTable.id, id))
      .returning();
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }

    // Session 12 — auto-advance Investigation -> Planning the moment
    // rootCauseAnalysis becomes non-empty. Removes the manual Advance click.
    // Session 34 (Tier 2 #11) — also stamps the planning due-date defaults.
    // Session 35 (Tier 3 #13) — target is the consolidated "Planning" stage
    // (the prior two-step Action Planning → EC Planning ramp is gone).
    // Stamps BOTH actionPlanningDueDate and ecPlanningDueDate on the way in
    // so the operator gets the same two milestone defaults the old flow
    // produced incrementally — these columns survive the consolidation
    // because they're independent commitment dates, not stage names.
    let finalCapa = capa;
    if (capa.stage === "Investigation" && (capa.rootCauseAnalysis ?? "").trim().length > 0) {
      const autoPatch: Record<string, unknown> = {
        stage: "Planning",
        status: STAGE_TO_LEGACY_STATUS["Planning"],
        updatedAt: new Date(),
      };
      if (!capa.actionPlanningDueDate) {
        autoPatch.actionPlanningDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.actionPlanning);
      }
      if (!capa.ecPlanningDueDate) {
        autoPatch.ecPlanningDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.ecPlanning);
      }
      const [advanced] = await db
        .update(capasTable)
        .set(autoPatch as never)
        .where(and(eq(capasTable.id, id), eq(capasTable.stage, "Investigation")))
        .returning();
      if (advanced) {
        finalCapa = advanced;
        void writeAuditLog({
          rowId: id,
          operation: "STAGE_ADVANCE_AUTO",
          changedById: actor.id,
          changedByName: actor.fullName,
          beforeState: { stage: "Investigation" },
          afterState: { stage: "Planning", trigger: "rootCauseAnalysis filled" },
        });
      }
    }

    const changedFields = Object.keys(filtered);
    const beforeSnap = Object.fromEntries(changedFields.map(k => [k, (before as Record<string, unknown>)[k]]));
    const afterSnap = Object.fromEntries(changedFields.map(k => [k, (capa as unknown as Record<string, unknown>)[k]]));
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: beforeSnap,
      afterState: afterSnap,
    });

    // Session 34 (Tier 2 #10) — emit a dedicated RISK_REVISED entry alongside
    // the generic UPDATE so audit reviewers can filter directly for risk
    // changes. Mirrors the Supplier RISK_TIER_CHANGE pattern from Session 33.
    if (riskChanging && capa) {
      void writeAuditLog({
        rowId: id,
        operation: "RISK_REVISED",
        changedById: actor.id,
        changedByName: actor.fullName,
        beforeState: { riskLevel: oldRiskLevel },
        afterState: {
          riskLevel: newRiskLevel ?? null,
          reason: riskRevisedReason,
          fromStage: before.stage,
        },
      });
    }
    res.json(finalCapa);
  } catch (err) {
    req.log.error({ err }, "Failed to update CAPA");
    res.status(500).json({ error: "Failed to update CAPA" });
  }
});

// ── Status Advance ────────────────────────────────────────────────────────────

router.post("/capas/:id/advance", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (capa.status === "Closed") {
      res.status(400).json({ error: "Closed CAPAs cannot be advanced." }); return;
    }

    const idx = CAPA_STATUS_ORDER.indexOf(capa.status);
    if (idx < 0 || idx >= CAPA_STATUS_ORDER.length - 2) {
      res.status(400).json({ error: "Cannot advance from current status" }); return;
    }
    const nextStatus = CAPA_STATUS_ORDER[idx + 1];
    const [updated] = await db
      .update(capasTable)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(and(eq(capasTable.id, id), eq(capasTable.status, capa.status)))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "CAPA status changed; refresh and try again." }); return;
    }
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: { status: capa.status },
      afterState: { status: nextStatus },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to advance CAPA");
    res.status(500).json({ error: "Failed to advance CAPA" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// New gated workflow endpoints (Session 4 — May 2026).
//
// These coexist with the legacy /advance, /verify-effectiveness, /close
// endpoints. New UI calls these; old UI still works against the legacy ones.
// Both surfaces write the same audit_log so a compliance audit sees one
// coherent history regardless of which client touched the record.
//
// Part 11 NOTE: full password-binding signatures (per Clerk reverification
// token) are not yet wired — that requires Clerk SDK step-up auth and is
// scheduled for a follow-up. Current signature pattern enforces:
//   • Authenticated session
//   • Approver-eligible role
//   • Initials match the user's own initials on record
//   • Signature meaning captured + audit-logged
//   • Segregation of duties (originator ≠ approver, EC Owner constraints)
// This satisfies the structural Part 11 controls; the cryptographic binding
// (re-typed password at moment of signing) is the final hardening step.
// ─────────────────────────────────────────────────────────────────────────────

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// Session 35 — Linear progression between stages that DON'T need a Part 11
// gate signature. Three gated transitions exist now:
//   Initiation     → Investigation    requires Gate 0 (Mgr/Quality)
//   Planning       → Action Execution requires Gate 1 (×2 approvers)
//   EC Execution   → Closed           requires Gate 2 (Mgr/Quality)
// Everything else flows through this map. Investigation → Planning is the
// big consolidation: where there used to be two transitions (Investigation →
// Action Planning → EC Planning) there is now one.
const STAGE_AUTO_PROGRESSION: Partial<Record<CapaStage, CapaStage>> = {
  "Investigation": "Planning",
  "Action Execution": "EC Execution",
};
// Mirror to legacy status so old UI keeps working. The legacy linear flow
// never had a "Planning" value — its closest analogue was "Action Planning",
// so the new Planning stage maps to that for back-compat. This keeps the
// pre-Session-4 status stepper rendering correctly while new code reads from
// `stage` directly.
const STAGE_TO_LEGACY_STATUS: Record<CapaStage, string> = {
  "Initiation": "Open",
  "Investigation": "Root Cause Analysis",
  "Planning": "Action Planning",
  "Action Execution": "Implementation",
  "EC Execution": "Effectiveness Check",
  "Closed": "Closed",
};

// POST /capas/:id/advance-stage — move forward one stage in the planning or
// execution ramp. Gate stages must use the gate endpoints. This endpoint is
// the "section complete, move me forward" trigger from the frontend; section
// completeness is the caller's responsibility to verify (the UI hides the
// button until the section is filled).
router.post("/capas/:id/advance-stage", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }

    const next = STAGE_AUTO_PROGRESSION[capa.stage as CapaStage];
    // Session 63.6 — Jonathan's rule: "Verifying the action should close each
    // action out. Once all actions are closed, then the record can advance to
    // EC Execution." Verification IS the close-out of an action item, so the
    // stage moves when there is nothing left to verify — not on a whim, and not
    // as a side effect of the effectiveness check, which is a different act
    // entirely. Enforced here as well as in the UI: the button being hidden is
    // not a control.
    if (capa.stage === "Action Execution") {
      const items = await db
        .select({
          id: capaActionItemsTable.id,
          sequenceNumber: capaActionItemsTable.sequenceNumber,
          actionDescription: capaActionItemsTable.actionDescription,
          status: capaActionItemsTable.status,
        })
        .from(capaActionItemsTable)
        .where(eq(capaActionItemsTable.capaId, id));
      if (items.length === 0) {
        res.status(409).json({
          error: "Cannot advance to Effectiveness Check — this CAPA has no action items. Add the corrective actions and have them verified first.",
        });
        return;
      }
      const unverified = items.filter((i) => i.status !== "Verified");
      if (unverified.length > 0) {
        const names = unverified
          .map((i) => `#${i.sequenceNumber} ${i.actionDescription} (${i.status})`)
          .join("; ");
        res.status(409).json({
          error: `Cannot advance to Effectiveness Check — ${unverified.length} action item${unverified.length === 1 ? " is" : "s are"} not verified yet: ${names}. Verifying an action is what closes it out.`,
        });
        return;
      }
    }
    if (!next) {
      res.status(409).json({
        error: `Cannot auto-advance from "${capa.stage}" — this stage requires a Part 11 gate signature (see /gate1-approve or /gate2-approve).`,
      });
      return;
    }
    // Session 34 (Tier 2 #11) — stamp the per-phase due date when its phase
    // begins. Operator can override later via PATCH. Only fills empty slots
    // so a user-set date earlier doesn't get overwritten.
    // Session 35 (Tier 3 #13) — Planning replaces the prior Action Planning
    // + EC Planning stages. Entering Planning stamps BOTH milestone dates so
    // the operator gets the same defaults the two-stage ramp used to produce.
    const stagePatch: Record<string, unknown> = {
      stage: next,
      status: STAGE_TO_LEGACY_STATUS[next],
      updatedAt: new Date(),
    };
    if (next === "Planning") {
      if (!capa.actionPlanningDueDate) {
        stagePatch.actionPlanningDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.actionPlanning);
      }
      if (!capa.ecPlanningDueDate) {
        stagePatch.ecPlanningDueDate = addDays(new Date(), PHASE_DUE_DEFAULTS.ecPlanning);
      }
    }
    const [updated] = await db
      .update(capasTable)
      .set(stagePatch as never)
      .where(and(eq(capasTable.id, id), eq(capasTable.stage, capa.stage)))
      .returning();
    if (!updated) { res.status(409).json({ error: "Stage changed; refresh and try again." }); return; }
    void writeAuditLog({
      rowId: id,
      operation: "STAGE_ADVANCE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { stage: capa.stage },
      afterState: { stage: next },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to advance CAPA stage");
    res.status(500).json({ error: "Failed to advance CAPA stage" });
  }
});

/**
 * Validate a Part 11 signature attempt. Returns null on success or an
 * { status, error } object on failure that the caller should res.status().json().
 */
function checkSignature(
  actor: { id: number; role: string; initials: string | null; fullName: string },
  initials: string | undefined,
  meaning: string | undefined,
): { status: number; error: string } | null {
  if (!initials?.trim() || !meaning?.trim()) {
    return { status: 400, error: "Initials and signing meaning required (21 CFR Part 11)." };
  }
  if (!APPROVER_ROLES.has(actor.role)) {
    return { status: 403, error: "Only Supervisor, Manager, Quality, or Admin can sign this gate." };
  }
  if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
    return { status: 400, error: "Initials do not match your account. Sign with your own initials." };
  }
  return null;
}

// Session 35 (Tier 3 #13) — Manager / Quality / Admin only for Gate 0 and
// Gate 2. Supervisors are deliberately excluded from acceptance and closure
// per the QMS review: Supervisors can validate plan content (Gate 1) but
// cannot accept a CAPA into the system nor close it.
const ACCEPTANCE_AND_CLOSURE_ROLES = new Set(["Manager", "Quality", "Admin"]);

// ── Gate 0 — Manager/Quality acceptance (Session 35) ─────────────────────────
//
// Body: { initials, signatureMeaning }
// Single signer. Stage must be Initiation. Manager / Quality / Admin only
// (no Supervisors). Originator cannot sign their own. On approval, stamps
// gate0_approver_* fields and advances stage Initiation → Investigation.
//
// There is no gate0-reject endpoint by design: if the reviewer doesn't want
// to accept the CAPA, they simply don't sign. The originator can keep
// editing in Initiation freely and re-request review when ready.

router.post("/capas/:id/gate0-approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, needsInvestigation } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; needsInvestigation?: boolean;
    };
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    // Session 61 — the gate reviewer decides where an accepted CAPA lands.
    //
    // A CAPA promoted from an NC often inherits an investigation that is already
    // finished — the root cause was found on the NC and copies across into
    // rootCauseAnalysis at promotion. Sending it to Investigation anyway asks
    // someone to redo work that is already recorded. So acceptance now carries a
    // second question, answered by the same Manager/Quality reviewer who is
    // already judging whether the CAPA is worth opening: does more investigation
    // need to happen to reach root cause?
    //
    // Deliberately asked HERE and not at promotion: the gate reviewer is the
    // person qualified to judge whether an investigation is actually complete,
    // and Gate 0 itself is never skipped — only its destination changes.
    //
    // Defaults to TRUE (Investigation) when the field is absent, so an older
    // client, or any caller that says nothing, gets exactly the previous
    // behaviour rather than silently skipping a phase.
    const toStage = needsInvestigation === false ? "Planning" : "Investigation";

    // Part 11 surface checks (initials format, initials-match-user). The
    // role check inside checkSignature is the broader Sup+Mgr+QA+Admin set,
    // which is wider than Gate 0 wants — so we layer a tighter check on top.
    const sigCheck = checkSignature(actor, initials, signatureMeaning);
    if (sigCheck) { res.status(sigCheck.status).json({ error: sigCheck.error }); return; }
    if (!ACCEPTANCE_AND_CLOSURE_ROLES.has(actor.role)) {
      res.status(403).json({
        error: `Gate 0 acceptance requires Manager, Quality, or Admin role. Your role is "${actor.role}".`,
      });
      return;
    }

    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (capa.stage !== "Initiation") {
      res.status(409).json({
        error: `Gate 0 acceptance is only available when the CAPA stage is "Initiation" (currently "${capa.stage}").`,
      });
      return;
    }
    if (capa.originatorId && actor.id === capa.originatorId) {
      res.status(409).json({
        error: "You opened this CAPA. Per 21 CFR Part 11, the originator cannot accept their own CAPA — a second pair of eyes is required.",
      });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(capasTable)
      .set({
        gate0ApproverId: actor.id,
        gate0ApproverName: actor.fullName,
        gate0ApproverInitials: actor.initials ?? initials!.trim().toUpperCase(),
        gate0ApproverAt: now,
        gate0ApproverMeaning: signatureMeaning!.trim(),
        gate0ApprovedAt: now,
        stage: toStage,
        status: STAGE_TO_LEGACY_STATUS[toStage],
        updatedAt: now,
      } as never)
      .where(and(eq(capasTable.id, id), eq(capasTable.stage, "Initiation"), isNull(capasTable.gate0ApprovedAt)))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Gate 0 state changed; refresh and try again." });
      return;
    }
    void writeAuditLog({
      rowId: id,
      operation: "GATE0_APPROVED",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { stage: "Initiation" },
      afterState: {
        stage: toStage,
        signer: actor.fullName,
        signatureMeaning: signatureMeaning!.trim(),
        // Recorded explicitly: the audit trail should show that skipping
        // Investigation was a decision someone made, not an absent step.
        investigationRequired: toStage === "Investigation",
      } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to approve Gate 0");
    res.status(500).json({ error: "Failed to approve Gate 0" });
  }
});

// ── Gate 1 — Pre-Implementation Approval (two distinct approvers) ────────────
//
// Body: { initials, signatureMeaning }
// The endpoint determines which slot (1 or 2) to write by inspecting current
// state. The same user cannot sign both slots. Originator cannot sign.
// Once slot 2 is signed the CAPA advances to "Action Execution" and the
// problem-statement / RCA / action-plan / EC-plan bundle becomes immutable.

router.post("/capas/:id/gate1-approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning } = (req.body ?? {}) as { initials?: string; signatureMeaning?: string };
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const sigCheck = checkSignature(actor, initials, signatureMeaning);
    if (sigCheck) { res.status(sigCheck.status).json({ error: sigCheck.error }); return; }

    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }

    // Gate 1 is only reachable from the Planning stage — all plan bundle
    // sections (RCA, action items, EC criteria, EC Owner) must be filled in
    // before the gate opens. Session 35 (Tier 3 #13) consolidated the prior
    // EC Planning stage into Planning, so the gate-entry check moves with it.
    if (capa.stage !== "Planning") {
      res.status(409).json({
        error: `Gate 1 approval is only available when the CAPA stage is "Planning" (currently "${capa.stage}").`,
      });
      return;
    }
    // Session 52.2.2 — Gate 1 readiness, in the order Jonathan specified: the
    // EC Owner is required only AFTER the investigation, action plan, and EC
    // steps are done (so an owner is never demanded before the EC steps that
    // owner would run even exist). Each check has its own clear message.
    if (!capa.rootCauseAnalysis || !capa.rootCauseAnalysis.trim()) {
      res.status(409).json({ error: "Complete the Root Cause Analysis before Gate 1 approval." });
      return;
    }
    const gate1PlanItems = await db
      .select({ assignedToId: capaActionItemsTable.assignedToId })
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id));
    if (gate1PlanItems.length === 0) {
      res.status(409).json({ error: "Add at least one corrective / preventive action (the action plan) before Gate 1 approval." });
      return;
    }
    if (!capa.effectivenessCriteria || !capa.effectivenessCriteria.trim()) {
      res.status(409).json({ error: "Identify the effectiveness-check steps (acceptance criteria) before Gate 1 approval." });
      return;
    }
    if (!capa.effectivenessOwnerId) {
      res.status(409).json({ error: "The effectiveness-check steps are defined — assign an Effectiveness Check Owner to complete the plan before Gate 1 approval." });
      return;
    }
    if (capa.originatorId && actor.id === capa.originatorId) {
      res.status(409).json({
        error: "You created this CAPA. Per 21 CFR Part 11, the originator cannot approve their own Gate 1 (segregation of duties).",
      });
      return;
    }

    // Session 24 — bring Gate 1 segregation in line with Gate 2. An action
    // item owner has a vested interest in seeing the plan that contains their
    // own action move forward; an Effectiveness Check Owner is part of the
    // plan being approved. Neither may sign Gate 1.
    if (capa.effectivenessOwnerId && actor.id === capa.effectivenessOwnerId) {
      res.status(409).json({
        error: "The Effectiveness Check Owner cannot sign Gate 1 — must be a separate approver (Part 11).",
      });
      return;
    }
    // Reuses gate1PlanItems fetched in the readiness check above.
    if (gate1PlanItems.some((a) => a.assignedToId === actor.id)) {
      res.status(409).json({
        error: "An action item owner cannot sign Gate 1 — must be a separate approver (Part 11).",
      });
      return;
    }

    // Determine slot, refuse duplicates.
    const now = new Date();
    let slot: 1 | 2;
    if (!capa.gate1Approver1Id) {
      slot = 1;
    } else if (!capa.gate1Approver2Id) {
      if (actor.id === capa.gate1Approver1Id) {
        res.status(409).json({ error: "You have already signed Gate 1. A second, distinct approver is required." });
        return;
      }
      slot = 2;
    } else {
      res.status(409).json({ error: "Gate 1 is already fully signed." });
      return;
    }

    const patch: Record<string, unknown> = { updatedAt: now };
    if (slot === 1) {
      patch.gate1Approver1Id = actor.id;
      patch.gate1Approver1Name = actor.fullName;
      patch.gate1Approver1Initials = actor.initials ?? initials!.trim().toUpperCase();
      patch.gate1Approver1At = now;
      patch.gate1Approver1Meaning = signatureMeaning!.trim();
    } else {
      patch.gate1Approver2Id = actor.id;
      patch.gate1Approver2Name = actor.fullName;
      patch.gate1Approver2Initials = actor.initials ?? initials!.trim().toUpperCase();
      patch.gate1Approver2At = now;
      patch.gate1Approver2Meaning = signatureMeaning!.trim();
      // Two signatures now on file — advance.
      patch.gate1ApprovedAt = now;
      patch.stage = "Action Execution";
      patch.status = "Implementation"; // legacy status mirror
    }

    const [updated] = await db
      .update(capasTable)
      .set(patch as never)
      .where(and(
        eq(capasTable.id, id),
        slot === 1 ? isNull(capasTable.gate1Approver1At) : isNull(capasTable.gate1Approver2At),
      ))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Gate 1 state changed; refresh and try again." });
      return;
    }
    void writeAuditLog({
      rowId: id,
      operation: slot === 2 ? "GATE1_APPROVED" : "GATE1_SIGN_SLOT_1",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: {
        slot,
        signer: actor.fullName,
        signatureMeaning: signatureMeaning!.trim(),
        ...(slot === 2 ? { stageAdvancedTo: "Action Execution" } : {}),
      } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to approve Gate 1");
    res.status(500).json({ error: "Failed to approve Gate 1" });
  }
});

// ── Gate 1 — Rejection (mandatory comment, returns to prior stage) ───────────
router.post("/capas/:id/gate1-reject", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { comment, rollbackTarget } = (req.body ?? {}) as {
      comment?: string;
      rollbackTarget?: "Investigation" | "Planning";
    };
    if (!comment?.trim()) {
      res.status(400).json({ error: "A rejection comment is required (audit trail)." });
      return;
    }
    // Session 35 — rollback targets are now Investigation | Planning (the
    // consolidated stage). "Planning" replaces the old "Action Planning".
    const target: "Investigation" | "Planning" = rollbackTarget === "Planning" ? "Planning" : "Investigation";
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only an approver-eligible user can reject Gate 1." });
      return;
    }

    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (capa.originatorId && actor.id === capa.originatorId) {
      res.status(409).json({ error: "Originator cannot reject their own CAPA." });
      return;
    }
    if (capa.stage !== "Planning") {
      res.status(409).json({ error: `Gate 1 rejection only valid at "Planning" stage.` });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(capasTable)
      .set({
        // Wipe any partial Gate 1 signature so the cycle restarts cleanly.
        gate1Approver1Id: null, gate1Approver1Name: null, gate1Approver1Initials: null, gate1Approver1At: null, gate1Approver1Meaning: null,
        gate1Approver2Id: null, gate1Approver2Name: null, gate1Approver2Initials: null, gate1Approver2At: null, gate1Approver2Meaning: null,
        gate1ApprovedAt: null,
        stage: target,
        status: STAGE_TO_LEGACY_STATUS[target as CapaStage],
        lastRejectionAt: now,
        lastRejectionStage: "Gate 1",
        lastRejectionById: actor.id,
        lastRejectionByName: actor.fullName,
        lastRejectionComment: comment.trim(),
        lastRejectionTarget: target,
        updatedAt: now,
      } as never)
      .where(eq(capasTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: id,
      operation: "GATE1_REJECTED",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: { stage: target, rejectionComment: comment.trim(), rejectedBy: actor.fullName } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to reject Gate 1");
    res.status(500).json({ error: "Failed to reject Gate 1" });
  }
});

// ── Gate 2 — Closure (Pass or Fail with rollback) ────────────────────────────
//
// Body: { initials, signatureMeaning, outcome: "Pass" | "Fail",
//         comment?, rollbackTarget? }
// Pass → CAPA Closed. Fail → comment + rollbackTarget required, CAPA returns
// to Investigation or Planning (Session 35 consolidated stages). Approver
// cannot be the originator, the EC Owner, or any action item owner.

router.post("/capas/:id/gate2-approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, outcome, comment, rollbackTarget } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; outcome?: "Pass" | "Fail";
      comment?: string; rollbackTarget?: "Investigation" | "Planning";
    };
    if (outcome !== "Pass" && outcome !== "Fail") {
      res.status(400).json({ error: "Outcome must be 'Pass' or 'Fail'." });
      return;
    }
    if (outcome === "Fail") {
      if (!comment?.trim()) {
        res.status(400).json({ error: "A Fail outcome requires a comment explaining why." });
        return;
      }
      if (rollbackTarget !== "Investigation" && rollbackTarget !== "Planning") {
        res.status(400).json({ error: "A Fail outcome requires a rollback target (Investigation or Planning)." });
        return;
      }
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const sigCheck = checkSignature(actor, initials, signatureMeaning);
    if (sigCheck) { res.status(sigCheck.status).json({ error: sigCheck.error }); return; }
    // Session 35 — tighten Gate 2 to Manager / Quality / Admin only. The
    // broader APPROVER_ROLES set checkSignature uses lets Supervisors sign,
    // which is appropriate for Gate 1 (a Supervisor can be one of the two
    // pre-implementation eyes) but not for closure. Mirrors Gate 0 + the
    // legacy /close endpoint's existing role rule.
    if (!ACCEPTANCE_AND_CLOSURE_ROLES.has(actor.role)) {
      res.status(403).json({
        error: `Gate 2 closure requires Manager, Quality, or Admin role. Your role is "${actor.role}".`,
      });
      return;
    }

    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (capa.stage !== "EC Execution") {
      res.status(409).json({ error: `Gate 2 is only available at "EC Execution" stage (currently "${capa.stage}").` });
      return;
    }

    // Segregation of duties: approver ≠ originator, ≠ EC Owner, ≠ any action owner.
    if (capa.originatorId && actor.id === capa.originatorId) {
      res.status(409).json({ error: "Originator cannot sign Gate 2." });
      return;
    }
    if (capa.effectivenessOwnerId && actor.id === capa.effectivenessOwnerId) {
      res.status(409).json({ error: "The Effectiveness Check Owner cannot sign Gate 2 — must be a separate approver (Part 11)." });
      return;
    }
    const actionOwners = await db
      .select({ assignedToId: capaActionItemsTable.assignedToId })
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id));
    if (actionOwners.some((a) => a.assignedToId === actor.id)) {
      res.status(409).json({ error: "An action item owner cannot sign Gate 2 — must be a separate approver (Part 11)." });
      return;
    }

    const now = new Date();
    if (outcome === "Pass") {
      const [updated] = await db
        .update(capasTable)
        .set({
          gate2ApproverId: actor.id,
          gate2ApproverName: actor.fullName,
          gate2ApproverInitials: actor.initials ?? initials!.trim().toUpperCase(),
          gate2ApproverAt: now,
          gate2ApproverMeaning: signatureMeaning!.trim(),
          gate2Outcome: "Pass",
          stage: "Closed",
          status: "Closed",
          closedAt: now,
          closedById: actor.id,
          closedByName: actor.fullName,
          closedByInitials: actor.initials ?? initials!.trim().toUpperCase(),
          updatedAt: now,
        } as never)
        .where(eq(capasTable.id, id))
        .returning();
      void writeAuditLog({
        rowId: id,
        operation: "GATE2_CLOSED",
        changedById: actor.id,
        changedByName: actor.fullName,
        afterState: { outcome: "Pass", closedBy: actor.fullName, signatureMeaning: signatureMeaning!.trim() } as never,
      });
      res.json(updated);
      return;
    }

    // Fail → rollback (Session 35 — target is Investigation or Planning)
    const target = rollbackTarget!;
    const [updated] = await db
      .update(capasTable)
      .set({
        gate2ApproverId: actor.id,
        gate2ApproverName: actor.fullName,
        gate2ApproverInitials: actor.initials ?? initials!.trim().toUpperCase(),
        gate2ApproverAt: now,
        gate2ApproverMeaning: signatureMeaning!.trim(),
        gate2Outcome: "Fail",
        stage: target,
        status: STAGE_TO_LEGACY_STATUS[target as CapaStage],
        lastRejectionAt: now,
        lastRejectionStage: "Gate 2",
        lastRejectionById: actor.id,
        lastRejectionByName: actor.fullName,
        lastRejectionComment: comment!.trim(),
        lastRejectionTarget: target,
        // Wipe Gate 1 signatures so the new cycle re-approves cleanly.
        gate1Approver1Id: null, gate1Approver1Name: null, gate1Approver1Initials: null, gate1Approver1At: null, gate1Approver1Meaning: null,
        gate1Approver2Id: null, gate1Approver2Name: null, gate1Approver2Initials: null, gate1Approver2At: null, gate1Approver2Meaning: null,
        gate1ApprovedAt: null,
        updatedAt: now,
      } as never)
      .where(eq(capasTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: id,
      operation: "GATE2_FAIL_ROLLBACK",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: { outcome: "Fail", rollbackTarget: target, comment: comment!.trim(), signer: actor.fullName } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to record Gate 2 outcome");
    res.status(500).json({ error: "Failed to record Gate 2 outcome" });
  }
});

// ── Effectiveness Verification (Part 11) ─────────────────────────────────────

router.post("/capas/:id/verify-effectiveness", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, effectivenessOutcome, notes } = req.body as {
      initials?: string;
      signatureMeaning?: string;
      effectivenessOutcome?: string;
      notes?: string;
    };
    if (!initials?.trim() || !signatureMeaning?.trim() || !effectivenessOutcome) {
      res.status(400).json({ error: "Initials, signing meaning, and outcome required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const APPROVERS = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
    if (!APPROVERS.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can verify effectiveness." }); return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }
    // Conditional update: effectiveness signature is one-time. If already
    // signed, reject so the original signer/outcome is never overwritten.
    const [existing] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!existing) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (existing.effectivenessVerifiedAt) {
      res.status(409).json({ error: "Effectiveness has already been verified. Open a new CAPA to re-verify." }); return;
    }
    if (existing.status === "Closed") {
      res.status(400).json({ error: "Cannot verify effectiveness on a Closed CAPA." }); return;
    }
    const [updated] = await db
      .update(capasTable)
      .set({
        effectivenessVerifiedAt: new Date(),
        effectivenessVerifiedById: actor.id,
        effectivenessVerifiedByName: actor.fullName,
        effectivenessVerifiedByInitials: actor.initials ?? initials.trim().toUpperCase(),
        effectivenessOutcome,
        effectivenessNotes: notes ?? null,
        // Session 63.6 — do NOT write a legacy status the stage has not reached.
        // This line used to set "Effectiveness Check" while the stage was still
        // "Action Execution", and the Advance button was computed from the legacy
        // status index — so verifying effectiveness early STRANDED the CAPA with
        // no way forward and Gate 2 unreachable (CAPA-26-0016). The mirror now
        // follows the stage, which is the only source of truth for the workflow.
        status: STAGE_TO_LEGACY_STATUS[(existing.stage ?? "Action Execution") as CapaStage] ?? existing.status,
        updatedAt: new Date(),
      })
      .where(and(eq(capasTable.id, id), isNull(capasTable.effectivenessVerifiedAt)))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Effectiveness state changed; refresh and try again." }); return;
    }
    void writeAuditLog({
      rowId: id,
      operation: "VERIFY_EFFECTIVENESS",
      changedByName: actor.fullName,
      changedById: actor.id,
      afterState: {
        // Report what the record actually holds, not what this endpoint used to
        // claim it had moved to.
        stage: updated.stage,
        status: updated.status,
        effectivenessOutcome,
        effectivenessVerifiedByName: actor.fullName,
        effectivenessVerifiedByInitials: actor.initials ?? initials.trim().toUpperCase(),
        signatureMeaning: signatureMeaning.trim(),
        ...(notes ? { effectivenessNotes: notes } : {}),
      },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to verify effectiveness");
    res.status(500).json({ error: "Failed to verify effectiveness" });
  }
});

// ── Closure (Part 11) ─────────────────────────────────────────────────────────

router.post("/capas/:id/close", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, closureNotes } = req.body as {
      initials?: string;
      signatureMeaning?: string;
      closureNotes?: string;
    };
    if (!initials?.trim() || !signatureMeaning?.trim()) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    // Session 12: closure requires Manager, Quality, or Admin specifically
    // (Supervisor can sign gates but not closure).
    const CAPA_CLOSURE_ROLES = new Set(["Manager", "Quality", "Admin"]);
    if (!CAPA_CLOSURE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `CAPA closure requires Manager, Quality, or Admin role. Your role is "${actor.role}".` }); return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }

    // Closure gate: every action item must be Verified, AND effectiveness must be signed.
    const [capa] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!capa) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (capa.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (capa.status === "Closed") {
      res.status(409).json({ error: "CAPA is already Closed; the original closure signature is immutable." }); return;
    }
    if (!capa.effectivenessVerifiedAt) {
      res.status(400).json({ error: "Effectiveness must be verified before closing this CAPA." }); return;
    }
    const items = await db
      .select({ id: capaActionItemsTable.id, status: capaActionItemsTable.status })
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id));
    const unverified = items.filter((i) => i.status !== "Verified");
    if (items.length === 0) {
      res.status(400).json({ error: "Add at least one action item before closing this CAPA." }); return;
    }
    if (unverified.length > 0) {
      res.status(400).json({
        error: `All action items must be Verified by an independent reviewer (${unverified.length} pending).`,
      });
      return;
    }

    const [updated] = await db
      .update(capasTable)
      .set({
        status: "Closed",
        closedById: actor.id,
        closedByName: actor.fullName,
        closedByInitials: actor.initials ?? initials.trim().toUpperCase(),
        closureNotes: closureNotes ?? null,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(capasTable.id, id), ne(capasTable.status, "Closed")))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "CAPA was just closed by another user; refresh." }); return;
    }
    void writeAuditLog({
      rowId: id,
      operation: "CLOSE",
      changedByName: actor.fullName,
      changedById: actor.id,
      afterState: {
        status: "Closed",
        closedByName: actor.fullName,
        closedByInitials: actor.initials ?? initials.trim().toUpperCase(),
        signatureMeaning: signatureMeaning.trim(),
        ...(closureNotes ? { closureNotes } : {}),
      },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to close CAPA");
    res.status(500).json({ error: "Failed to close CAPA" });
  }
});

// ── Action Items ──────────────────────────────────────────────────────────────

// Aggregate endpoint (Session 18) — list action items across all CAPAs,
// optionally filtered by assignee and open-only. Used by the dashboard My
// Queue tile so we don't N+1 fetch action items per CAPA.
//
// Lives at /capa-action-items (NOT /capas/...) to avoid collision with the
// per-CAPA /capas/:id/action-items route below.
router.get("/capa-action-items", async (req, res) => {
  try {
    const assignedToName = (req.query.assignedToName as string | undefined) ?? null;
    const onlyOpen = req.query.open === "true" || req.query.open === "1";
    const filters = [] as ReturnType<typeof eq>[];
    if (assignedToName) filters.push(eq(capaActionItemsTable.assignedToName, assignedToName));
    if (onlyOpen) {
      // Open = not Completed and not Verified. Completed-but-not-verified
      // items belong to a separate verifier, so they're excluded from the
      // assignee's own queue.
      filters.push(sql`${capaActionItemsTable.status} = 'Open'` as unknown as ReturnType<typeof eq>);
    }
    const rows = await db
      .select()
      .from(capaActionItemsTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(capaActionItemsTable.dueDate);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list aggregate action items");
    res.status(500).json({ error: "Failed to list action items" });
  }
});

router.get("/capas/:id/action-items", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const items = await db
      .select()
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id))
      .orderBy(capaActionItemsTable.sequenceNumber);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Failed to list action items");
    res.status(500).json({ error: "Failed to list action items" });
  }
});

// Fields a client may set on an action item via create/patch. Server controls
// status/completed*/verified* via dedicated workflow endpoints.
const ACTION_ITEM_ALLOWED = new Set([
  "actionDescription",
  "assignedToId",
  "assignedToName",
  "dueDate",
  "notes",
  // Session 101 (#16) — completion detail: date the action was performed.
  "performedOn",
]);

router.post("/capas/:id/action-items", async (req, res) => {
  try {
    const capaId = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [parent] = await db.select().from(capasTable).where(eq(capasTable.id, capaId));
    if (!parent) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (parent.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (parent.status === "Closed") {
      res.status(400).json({ error: "Cannot add action items to a Closed CAPA." }); return;
    }
    // Session 52.3.2 — once the plan is approved (Gate 1) the action plan is
    // frozen: no new actions. Execution continues on the existing items
    // (status → Completed, completion stamps, notes), but the set of actions
    // that was approved can't grow afterward.
    if (parent.gate1ApprovedAt) {
      res.status(409).json({
        error: "The plan is approved (Gate 1). New action items can't be added — record completion on the existing actions instead.",
      });
      return;
    }

    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (ACTION_ITEM_ALLOWED.has(k)) safe[k] = v;
    }
    if (!safe.actionDescription || typeof safe.actionDescription !== "string" || !(safe.actionDescription as string).trim()) {
      res.status(400).json({ error: "actionDescription is required." }); return;
    }

    // Session 34 (Tier 2 #11) — EC must remain strictly after every corrective
    // action's due date. Check on the way in: if this action item's dueDate
    // would push the latest-CA past the existing EC date, reject.
    if (safe.dueDate && parent.effectivenessCheckDue) {
      const proposedItemDue = safe.dueDate as string;
      if (proposedItemDue >= parent.effectivenessCheckDue) {
        res.status(409).json({
          error: `Action item due date (${proposedItemDue}) must be before the Effectiveness Check due date (${parent.effectivenessCheckDue}). Move the action in, or move EC out first.`,
        });
        return;
      }
    }

    const [last] = await db
      .select({ max: sql<number>`coalesce(max(sequence_number), 0)` })
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, capaId));
    const sequenceNumber = (last?.max ?? 0) + 1;
    const [item] = await db
      .insert(capaActionItemsTable)
      .values({ ...safe, capaId, sequenceNumber } as typeof capaActionItemsTable.$inferInsert)
      .returning();

    // Session 12 used to auto-advance Action Planning → EC Planning on the
    // first action item add. Session 35 (Tier 3 #13) consolidated those two
    // stages into one "Planning" stage, so the intra-Planning auto-advance
    // is no longer meaningful — the CAPA stays in Planning until the
    // operator clears Gate 1. We keep this comment as a tombstone so future
    // readers can git blame their way back to the original rationale.

    res.status(201).json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to create action item");
    res.status(500).json({ error: "Failed to create action item" });
  }
});

router.patch("/capas/:id/action-items/:itemId", async (req, res) => {
  try {
    const capaId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [parent] = await db.select({ status: capasTable.status, cancelledAt: capasTable.cancelledAt, gate1ApprovedAt: capasTable.gate1ApprovedAt }).from(capasTable).where(eq(capasTable.id, capaId));
    if (!parent) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (parent.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (parent.status === "Closed") {
      res.status(400).json({ error: "Cannot modify action items on a Closed CAPA." }); return;
    }
    const [existingItem] = await db.select().from(capaActionItemsTable).where(eq(capaActionItemsTable.id, itemId));
    if (!existingItem || existingItem.capaId !== capaId) {
      res.status(404).json({ error: "Action item not found" }); return;
    }
    // Cannot mutate a Verified item via PATCH — that would erase the
    // independent-verifier signature.
    if (existingItem.status === "Verified") {
      res.status(400).json({ error: "Verified action items are immutable. Open a new action item if you need a change." }); return;
    }

    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {};

    // Allowed user-editable fields
    for (const k of ACTION_ITEM_ALLOWED) {
      if (k in incoming) body[k] = (incoming as Record<string, unknown>)[k];
    }
    // Plan content is locked once Gate 1 (planning approval) is signed. The plan
    // itself — what each action is, who owns it, when it's due — can't change
    // after approval; only execution (status progression, notes) may continue.
    // The Edit button is hidden client-side pre-Gate-1; this is the server guard.
    if (parent.gate1ApprovedAt) {
      const PLAN_CONTENT_FIELDS = ["actionDescription", "assignedToId", "assignedToName", "dueDate"];
      const blocked = PLAN_CONTENT_FIELDS.filter((k) => k in body);
      if (blocked.length) {
        res.status(409).json({
          error: "The plan is approved (Gate 1). Action item description, owner, and due date are locked. You can still update status and notes.",
        });
        return;
      }
    }
    // Status transitions allowed via PATCH: Open/In Progress/Completed.
    // Verified must go through the dedicated /verify endpoint (Part 11).
    if (typeof incoming.status === "string") {
      if (incoming.status === "Verified") {
        res.status(400).json({
          error: "Use POST /capas/:id/action-items/:itemId/verify to verify (independent signer required).",
        });
        return;
      }
      const ALLOWED_STATUSES = new Set(["Open", "In Progress", "Completed"]);
      if (!ALLOWED_STATUSES.has(incoming.status)) {
        res.status(400).json({ error: `Invalid status '${incoming.status}'.` }); return;
      }
      body.status = incoming.status;
    }
    // verifiedAt/verifiedByName/verifiedById are server-set by /verify only.
    if (incoming.verifiedAt || incoming.verifiedByName || incoming.verifiedById) {
      res.status(400).json({ error: "Verifier fields are server-managed." }); return;
    }

    // When marking Completed, server stamps the actor as completer (cannot spoof).
    if (body.status === "Completed") {
      // Session 101 (#16) — a completed corrective/preventive action must record
      // what was done (notes) and the date it was performed (performedOn).
      const doneNotes = String((body as { notes?: unknown }).notes ?? "").trim();
      const donePerformedOn = String((body as { performedOn?: unknown }).performedOn ?? "").trim();
      if (!doneNotes || !donePerformedOn) {
        res.status(400).json({ error: "Completing a corrective action requires a description of what was done and the date it was performed." });
        return;
      }
      body.completedByName = actor.fullName;
      body.completedById = actor.id;
      body.completedAt = new Date();
    }

    // Session 34 (Tier 2 #11) — guard the EC > CA order when the dueDate is
    // being changed via PATCH. Pull the parent's current EC due date and the
    // sibling action items (excluding this one, since its dueDate is being
    // replaced) and verify the proposed state stays clean.
    if (Object.prototype.hasOwnProperty.call(body, "dueDate") && body.dueDate) {
      const [parentRow] = await db
        .select({ effectivenessCheckDue: capasTable.effectivenessCheckDue })
        .from(capasTable)
        .where(eq(capasTable.id, capaId));
      const ecDue = parentRow?.effectivenessCheckDue ?? null;
      if (ecDue && (body.dueDate as string) >= ecDue) {
        res.status(409).json({
          error: `Action item due date (${body.dueDate}) must be before the Effectiveness Check due date (${ecDue}).`,
        });
        return;
      }
    }

    const [item] = await db
      .update(capaActionItemsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(capaActionItemsTable.id, itemId))
      .returning();
    if (!item) { res.status(404).json({ error: "Action item not found" }); return; }
    res.json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to update action item");
    res.status(500).json({ error: "Failed to update action item" });
  }
});

// ── Independent verifier (four-eyes, Part 11) ────────────────────────────────
// Verifier must NOT be the same person who marked the action Completed.
router.post("/capas/:id/action-items/:itemId/verify", async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const capaId = parseInt(req.params.id);
    const body = (req.body ?? {}) as {
      initials?: string; meaning?: string; signatureMeaning?: string; notes?: string;
    };
    const initials = body.initials;
    const meaning = body.meaning ?? body.signatureMeaning;
    const notes = body.notes;
    if (!initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const APPROVERS = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
    if (!APPROVERS.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can verify CAPA action items." });
      return;
    }

    const [item] = await db.select().from(capaActionItemsTable).where(eq(capaActionItemsTable.id, itemId));
    if (!item || item.capaId !== capaId) { res.status(404).json({ error: "Action item not found." }); return; }
    const [parentCapa] = await db.select({ cancelledAt: capasTable.cancelledAt }).from(capasTable).where(eq(capasTable.id, capaId));
    if (parentCapa?.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (item.status !== "Completed") {
      res.status(400).json({ error: "Action item must be Completed before it can be Verified." }); return;
    }
    // Four-eyes: verifier must differ from the user who marked Completed.
    // Prefer immutable ID match; fall back to fullName for legacy rows.
    const sameById = item.completedById != null && item.completedById === actor.id;
    const sameByName = !item.completedById && item.completedByName
      && item.completedByName.trim().toLowerCase() === actor.fullName.trim().toLowerCase();
    if (sameById || sameByName) {
      res.status(403).json({
        error: "Independent verifier required: the person who completed this action cannot also verify it.",
      });
      return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }

    const now = new Date();
    const [updated] = await db
      .update(capaActionItemsTable)
      .set({
        status: "Verified",
        verifiedAt: now,
        verifiedById: actor.id,
        verifiedByName: actor.fullName,
        notes: notes?.trim() ? `${item.notes ? item.notes + "\n" : ""}Verified: ${notes.trim()}` : item.notes,
        updatedAt: now,
      })
      .where(and(eq(capaActionItemsTable.id, itemId), eq(capaActionItemsTable.status, "Completed")))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Action item state changed; refresh and try again." }); return;
    }

    void writeAuditLog({
      rowId: capaId,
      operation: "VERIFY_ACTION_ITEM",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: { actionItemId: itemId, status: "Completed", completedById: item.completedById, completedByName: item.completedByName },
      afterState: { actionItemId: itemId, status: "Verified", verifiedById: actor.id, verifiedByName: actor.fullName, verifierInitials: actor.initials ?? initials.trim().toUpperCase(), signatureMeaning: meaning.trim() },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to verify action item");
    res.status(500).json({ error: "Failed to verify action item" });
  }
});

// ── AI-suggested effectiveness checks (advisory, human-edits-and-signs) ──────
router.post("/capas/:id/effectiveness-suggestions", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const id = parseInt(req.params.id);
    const items = await db
      .select({ desc: capaActionItemsTable.actionDescription })
      .from(capaActionItemsTable)
      .where(eq(capaActionItemsTable.capaId, id));
    const descriptions = items.map((i) => i.desc).filter(Boolean);
    if (descriptions.length === 0) {
      res.json({ suggestions: [] }); return;
    }
    const suggestions = await suggestEffectivenessChecks(descriptions);
    res.json({ suggestions });
  } catch (err) {
    req.log.error({ err }, "Failed to generate effectiveness suggestions");
    // Soft-fail so UI degrades gracefully.
    res.json({ suggestions: [] });
  }
});

router.delete("/capas/:id/action-items/:itemId", async (req, res) => {
  try {
    const capaId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [parent] = await db.select({ status: capasTable.status, cancelledAt: capasTable.cancelledAt, gate1ApprovedAt: capasTable.gate1ApprovedAt }).from(capasTable).where(eq(capasTable.id, capaId));
    if (!parent) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (parent.cancelledAt) { res.status(409).json({ error: "This CAPA is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (parent.status === "Closed") {
      res.status(400).json({ error: "Cannot delete action items from a Closed CAPA." }); return;
    }
    // Session 53 — once the plan is approved (Gate 1) the action set is frozen.
    // Mirrors the create lock (no new actions) and the edit lock (content
    // frozen): an approved corrective/preventive action is part of the signed
    // record and cannot be hard-deleted. Pre-Gate-1 deletes (draft authoring)
    // stay allowed.
    if (parent.gate1ApprovedAt) {
      res.status(409).json({
        error: "The plan is approved (Gate 1). Approved action items can't be deleted — record completion on them, or cancel the CAPA instead.",
      });
      return;
    }
    const [existing] = await db.select().from(capaActionItemsTable).where(eq(capaActionItemsTable.id, itemId));
    if (!existing || existing.capaId !== capaId) {
      res.status(404).json({ error: "Action item not found" }); return;
    }
    if (existing.status === "Verified") {
      res.status(400).json({ error: "Verified action items are immutable and cannot be deleted." }); return;
    }
    await db.delete(capaActionItemsTable).where(eq(capaActionItemsTable.id, itemId));
    void writeAuditLog({
      rowId: capaId,
      operation: "DELETE_ACTION_ITEM",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { actionItemId: itemId, status: existing.status, description: existing.actionDescription },
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to delete action item");
    res.status(500).json({ error: "Failed to delete action item" });
  }
});

// ── Session 52.1 — soft Cancel / Re-open (Part 11) ───────────────────────────
//
// QMS records are never hard-deleted. Cancel retains the row, is recoverable
// (/uncancel, Admin-only), and requires a Manager/Quality/Admin actor + a
// rationale + a Part 11 e-signature (initials matching the signed-in user +
// meaning). Cancel is permitted ONLY while the CAPA is open; a Closed CAPA
// cannot be cancelled (409 — Re-open it first, or open a new CAPA). The
// canonical terminal state is `stage === "Closed"`; the legacy `status`
// field is also checked. Mirrors the Non-Conformance reference (Session 52).
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.post("/capas/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!CANCEL_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Cancelling a record requires Manager, Quality, or Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!before) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }
    if (before.stage === "Closed" || before.status === "Closed") {
      res.status(409).json({ error: "A Closed CAPA cannot be cancelled. Re-open it first (Admin), or open a new CAPA." }); return;
    }

    const [capa] = await db.update(capasTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(capasTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "CANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: capa as unknown as Record<string, unknown>,
    });
    res.json(capa);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel CAPA");
    res.status(500).json({ error: "Failed to cancel CAPA" });
  }
});

// POST /capas/:id/uncancel — reverse a Cancel. Admin-ONLY (Session 52 decision
// — narrower than Cancel). Part 11 signature required. Clears the cancel fields
// and returns the CAPA to active use.
router.post("/capas/:id/uncancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (actor.role !== "Admin") {
      res.status(403).json({ error: `Re-opening a record is restricted to Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(capasTable).where(eq(capasTable.id, id));
    if (!before) { res.status(404).json({ error: "CAPA not found" }); return; }
    if (!before.cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [capa] = await db.update(capasTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(capasTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UNCANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: capa as unknown as Record<string, unknown>,
    });
    res.json(capa);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel CAPA");
    res.status(500).json({ error: "Failed to uncancel CAPA" });
  }
});

export default router;
