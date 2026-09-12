import { Router } from "express";
import { db } from "@workspace/db";
import { complaintsTable, auditLogTable, complaintCandidateBatchesTable, batchRecordsTable, nonConformancesTable, capasTable, complaintCorrectionsTable } from "@workspace/db";
import { eq, sql, like, and, desc, ne, or } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { nextNcNumber, nextCapaNumber, deriveCapaRisk } from "../lib/qualityEvents";

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
      tableName: "complaints",
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

// Session 32 — match NC/CAPA generator semantics: MAX of the parsed sequence
// suffix within the current year, NOT count(*). Year-scoped, monotonic, never
// reuses a number after a delete. The old count(*) approach drifted whenever
// rows from prior years or other test data inflated the count, producing the
// "increment-by-N" jump the operator observed (CMP-26-0011 → CMP-26-0021).
// Race-condition note: small TOCTOU window between SELECT and INSERT; the
// unique constraint on complaint_number is the hard backstop.
async function generateComplaintNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `CMP-${year}-`;
  const rows = await db
    .select({ complaintNumber: complaintsTable.complaintNumber })
    .from(complaintsTable)
    .where(like(complaintsTable.complaintNumber, `${prefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = r.complaintNumber?.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

router.get("/complaints", async (req, res) => {
  try {
    let rows = await db.select().from(complaintsTable).orderBy(complaintsTable.createdAt);
    const { status, type } = req.query;
    // Session 52 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled complaints (the Cancelled view). Cancel is the no-hard-delete pattern.
    const cancelled = req.query.cancelled === "true";
    rows = cancelled
      ? rows.filter((r) => (r as { cancelledAt?: unknown }).cancelledAt)
      : rows.filter((r) => !(r as { cancelledAt?: unknown }).cancelledAt);
    if (status) rows = rows.filter((r) => r.status === status);
    if (type) rows = rows.filter((r) => r.complaintType === type);
    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list complaints");
    res.status(500).json({ error: "Failed to list complaints" });
  }
});

router.post("/complaints", async (req, res) => {
  try {
    const complaintNumber = await generateComplaintNumber();
    const [complaint] = await db.insert(complaintsTable).values({ ...req.body, complaintNumber }).returning();
    void writeAuditLog({
      rowId: complaint.id,
      operation: "INSERT",
      changedByName: (req.body as Record<string, unknown>).reportedByName as string ?? null,
      afterState: complaint as unknown as Record<string, unknown>,
    });
    res.status(201).json(complaint);
  } catch (err) {
    req.log.error({ err }, "Failed to create complaint");
    res.status(500).json({ error: "Failed to create complaint" });
  }
});

router.get("/complaints/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [complaint] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!complaint) { res.status(404).json({ error: "Complaint not found" }); return; }
    // Session 75 — surface the linked internal NC (if any) so the detail page can
    // show the connection without a second round-trip.
    let linkedNc: { id: number; ncNumber: string; title: string | null; status: string | null; severity: string | null } | null = null;
    const ncId = (complaint as { ncId?: number | null }).ncId;
    if (ncId) {
      const [nc] = await db
        .select({ id: nonConformancesTable.id, ncNumber: nonConformancesTable.ncNumber, title: nonConformancesTable.title, status: nonConformancesTable.status, severity: nonConformancesTable.severity })
        .from(nonConformancesTable)
        .where(eq(nonConformancesTable.id, ncId));
      linkedNc = nc ?? null;
    }
    let linkedCapa: { id: number; capaNumber: string; title: string | null; stage: string | null } | null = null;
    const capaId = (complaint as { capaId?: number | null }).capaId;
    if (capaId) {
      const [capa] = await db
        .select({ id: capasTable.id, capaNumber: capasTable.capaNumber, title: capasTable.title, stage: capasTable.stage })
        .from(capasTable)
        .where(eq(capasTable.id, capaId));
      linkedCapa = capa ?? null;
    }
    res.json({ ...complaint, linkedNc, linkedCapa });
  } catch (err) {
    req.log.error({ err }, "Failed to get complaint");
    res.status(500).json({ error: "Failed to get complaint" });
  }
});

router.patch("/complaints/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    // Session 52.1.1 — a cancelled complaint is read-only (Re-open via /uncancel first).
    if (before && (before as { cancelledAt?: unknown }).cancelledAt) {
      res.status(409).json({ error: "This complaint is cancelled and read-only. Re-open it first (Admin)." }); return;
    }
    // Strip the cancelled_* fields — they are managed only by /cancel +
    // /uncancel (Session 52) and must never be set via a field edit (Part 11).
    const {
      cancelledAt: _ca, cancelledReason: _cr, cancelledByName: _cbn,
      cancelledByInitials: _cbi, cancelledMeaning: _cm,
      ...persistBody
    } = (req.body ?? {}) as Record<string, unknown>;
    // closedAt is a timestamptz column — drizzle's .set() expects a Date, not the
    // ISO string the client sends on close. Coerce it (mirrors the NC/destruction
    // routes) so closing a complaint doesn't 500. receivedDate is a `date` column
    // and accepts the YYYY-MM-DD string as-is.
    if (typeof persistBody.closedAt === "string") {
      const d = new Date(persistBody.closedAt as string);
      if (!Number.isNaN(d.getTime())) persistBody.closedAt = d;
    }
    // Session 62.2 — a complaint cannot close while a correction is still open.
    // Mirrors the NC rule (non_conformances.ts, Session 48.3): if someone recorded
    // containment tasks, closing over the top of them buries open work inside a
    // closed record, which is exactly what control of nonconforming product is
    // meant to prevent. Checked before the write so the status never lands.
    //
    // Only fires on the transition INTO Closed — editing a field on an already
    // closed complaint is not blocked by this.
    // Both "Closed" and "Closed - CAPA Created" are closed states, so the gate
    // tests the prefix. Matching only the bare "Closed" would have let a
    // complaint escalated to a CAPA close over its open corrections.
    const isClosingStatus = (v: unknown) => typeof v === "string" && v.startsWith("Closed");
    if (isClosingStatus(persistBody.status) && before && !isClosingStatus(before.status)) {
      const pending = await db
        .select({ id: complaintCorrectionsTable.id })
        .from(complaintCorrectionsTable)
        .where(and(
          eq(complaintCorrectionsTable.complaintId, id),
          eq(complaintCorrectionsTable.completed, false),
        ));
      if (pending.length > 0) {
        const n = pending.length;
        res.status(409).json({
          error: `Cannot close: ${n} correction${n === 1 ? "" : "s"} still open. Mark every assigned correction complete before closing the complaint.`,
        });
        return;
      }
    }

    // Session 75 — if linking/unlinking an NC, validate the target exists (soft
    // link, app-layer integrity). null clears the link.
    if (Object.prototype.hasOwnProperty.call(persistBody, "ncId") && persistBody.ncId != null) {
      const ncId = Number(persistBody.ncId);
      const [nc] = await db.select({ id: nonConformancesTable.id }).from(nonConformancesTable).where(eq(nonConformancesTable.id, ncId));
      if (!nc) { res.status(400).json({ error: `No nonconformance #${persistBody.ncId} exists to link.` }); return; }
      persistBody.ncId = ncId;
    }
    const [complaint] = await db.update(complaintsTable).set({ ...persistBody, updatedAt: new Date() }).where(eq(complaintsTable.id, id)).returning();
    if (!complaint) { res.status(404).json({ error: "Complaint not found" }); return; }
    // Session 100 — attribute the edit to the signed-in user (Part 11) instead
    // of leaving changedByName null, which renders as "System".
    const auditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: auditActor?.id ?? null,
      changedByName: auditActor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: complaint as unknown as Record<string, unknown>,
    });
    res.json(complaint);
  } catch (err) {
    req.log.error({ err }, "Failed to update complaint");
    res.status(500).json({ error: "Failed to update complaint" });
  }
});

// ── Session 52.1 — soft Cancel / Re-open (Part 11) ───────────────────────────
//
// QMS records are never hard-deleted. Cancel retains the row, is recoverable
// (/uncancel, Admin-only), and requires a Manager/Quality/Admin actor + a
// rationale + a Part 11 e-signature (initials matching the signed-in user +
// meaning). Cancel is permitted ONLY while the complaint is not Closed; a
// Closed complaint cannot be cancelled (409 — Re-open it first, or open a new
// complaint). Mirrors the Non-Conformance reference implementation (Session 52).
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.post("/complaints/:id/cancel", async (req, res) => {
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

    const [before] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!before) { res.status(404).json({ error: "Complaint not found" }); return; }
    if ((before as { cancelledAt?: unknown }).cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }
    if (before.status === "Closed") {
      res.status(409).json({ error: "A Closed complaint cannot be cancelled. Re-open it first (Admin), or open a new complaint." }); return;
    }

    const [complaint] = await db.update(complaintsTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(complaintsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "CANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: complaint as unknown as Record<string, unknown>,
    });
    res.json(complaint);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel complaint");
    res.status(500).json({ error: "Failed to cancel complaint" });
  }
});

// POST /complaints/:id/uncancel — reverse a Cancel. Admin-ONLY (Session 52
// decision — narrower than Cancel). Part 11 signature required. Clears the
// cancel fields and returns the complaint to active use.
router.post("/complaints/:id/uncancel", async (req, res) => {
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

    const [before] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!before) { res.status(404).json({ error: "Complaint not found" }); return; }
    if (!(before as { cancelledAt?: unknown }).cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [complaint] = await db.update(complaintsTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(complaintsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UNCANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: complaint as unknown as Record<string, unknown>,
    });
    res.json(complaint);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel complaint");
    res.status(500).json({ error: "Failed to uncancel complaint" });
  }
});

// ── Session 74 — candidate source batches (METRC tag lineage Phase 2) ─────────
//
// A complaint links to zero/one/several candidate batches; the investigation
// resolves them. Off-spec / raw-fetch (no codegen), consistent with the NC and
// METRC-tag routes. Closing a complaint never requires a confirmed batch.
async function writeCandidateAudit(opts: {
  rowId: number; operation: string;
  changedById?: number | null; changedByName?: string | null;
  beforeState?: Record<string, unknown> | null; afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "complaint_candidate_batches",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

// GET — list a complaint's candidate batches, newest first, each enriched with
// the batch number / product / strain / status for display.
router.get("/complaints/:id/candidate-batches", async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id);
    const rows = await db
      .select({
        id: complaintCandidateBatchesTable.id,
        complaintId: complaintCandidateBatchesTable.complaintId,
        batchId: complaintCandidateBatchesTable.batchId,
        status: complaintCandidateBatchesTable.status,
        matchBasis: complaintCandidateBatchesTable.matchBasis,
        enteredValue: complaintCandidateBatchesTable.enteredValue,
        note: complaintCandidateBatchesTable.note,
        recordedByName: complaintCandidateBatchesTable.recordedByName,
        resolvedByName: complaintCandidateBatchesTable.resolvedByName,
        resolvedAt: complaintCandidateBatchesTable.resolvedAt,
        createdAt: complaintCandidateBatchesTable.createdAt,
        batchNumber: batchRecordsTable.batchNumber,
        productName: batchRecordsTable.productName,
        strainName: batchRecordsTable.strainName,
        batchStatus: batchRecordsTable.status,
        productionDate: batchRecordsTable.productionDate,
      })
      .from(complaintCandidateBatchesTable)
      .innerJoin(batchRecordsTable, eq(complaintCandidateBatchesTable.batchId, batchRecordsTable.id))
      .where(eq(complaintCandidateBatchesTable.complaintId, complaintId))
      .orderBy(desc(complaintCandidateBatchesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list candidate batches");
    res.status(500).json({ error: "Failed to list candidate batches" });
  }
});

// POST — attach a candidate batch (default status 'suspected'). Idempotent on
// (complaint, batch): re-attaching an existing candidate just returns it rather
// than duplicating, unless it was previously ruled_out (then it's revived).
router.post("/complaints/:id/candidate-batches", async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const batchId = typeof body.batchId === "number" ? body.batchId : parseInt(String(body.batchId));
    if (!Number.isFinite(batchId)) { res.status(400).json({ error: "A batchId is required." }); return; }

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, batchId));
    if (!batch) { res.status(404).json({ error: "Batch not found." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const matchBasis = typeof body.matchBasis === "string" ? body.matchBasis : "manual";
    const enteredValue = typeof body.enteredValue === "string" ? body.enteredValue : null;
    const note = typeof body.note === "string" ? body.note : null;

    const [existing] = await db.select().from(complaintCandidateBatchesTable)
      .where(and(
        eq(complaintCandidateBatchesTable.complaintId, complaintId),
        eq(complaintCandidateBatchesTable.batchId, batchId),
      ));
    if (existing) {
      if (existing.status === "ruled_out") {
        const [revived] = await db.update(complaintCandidateBatchesTable).set({
          status: "suspected", resolvedAt: null, resolvedByUserId: null, resolvedByName: null,
          updatedAt: new Date(),
        }).where(eq(complaintCandidateBatchesTable.id, existing.id)).returning();
        res.status(200).json(revived); return;
      }
      res.status(200).json(existing); return;
    }

    const [row] = await db.insert(complaintCandidateBatchesTable).values({
      complaintId, batchId, status: "suspected", matchBasis, enteredValue, note,
      recordedByUserId: actor?.id ?? null, recordedByName: actor?.fullName ?? null,
    }).returning();
    void writeCandidateAudit({
      rowId: row.id, operation: "CREATE",
      changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null,
      afterState: row as unknown as Record<string, unknown>,
    });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add candidate batch");
    res.status(500).json({ error: "Failed to add candidate batch" });
  }
});

// PATCH — resolve a candidate during the investigation. status ∈
// suspected | confirmed | ruled_out (+ optional note). Confirming THIS candidate
// sets complaints.batch_id to its batch and demotes any other confirmed sibling
// back to suspected (only one confirmed source at a time). If the row that was
// confirmed is later ruled_out / un-confirmed, complaints.batch_id is cleared.
router.patch("/complaint-candidate-batches/:candId", async (req, res) => {
  try {
    const candId = parseInt(req.params.candId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextStatus = typeof body.status === "string" ? body.status : undefined;
    const note = typeof body.note === "string" ? body.note : undefined;
    if (nextStatus && !["suspected", "confirmed", "ruled_out"].includes(nextStatus)) {
      res.status(400).json({ error: "Invalid status." }); return;
    }

    const [before] = await db.select().from(complaintCandidateBatchesTable).where(eq(complaintCandidateBatchesTable.id, candId));
    if (!before) { res.status(404).json({ error: "Candidate not found." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const resolving = nextStatus && nextStatus !== "suspected";

    const [row] = await db.update(complaintCandidateBatchesTable).set({
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(resolving
        ? { resolvedAt: new Date(), resolvedByUserId: actor?.id ?? null, resolvedByName: actor?.fullName ?? null }
        : nextStatus === "suspected" ? { resolvedAt: null, resolvedByUserId: null, resolvedByName: null } : {}),
      updatedAt: new Date(),
    }).where(eq(complaintCandidateBatchesTable.id, candId)).returning();

    if (nextStatus === "confirmed") {
      // Demote any other confirmed sibling, then point the complaint at this batch.
      await db.update(complaintCandidateBatchesTable).set({ status: "suspected", updatedAt: new Date() })
        .where(and(
          eq(complaintCandidateBatchesTable.complaintId, before.complaintId),
          eq(complaintCandidateBatchesTable.status, "confirmed"),
          sql`${complaintCandidateBatchesTable.id} <> ${candId}`,
        ));
      await db.update(complaintsTable).set({ batchId: before.batchId, updatedAt: new Date() } as never)
        .where(eq(complaintsTable.id, before.complaintId));
    } else if (before.status === "confirmed" && nextStatus && nextStatus !== "confirmed") {
      // This was the confirmed source and is being un-confirmed → clear the link.
      const [c] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, before.complaintId));
      if (c && (c as { batchId?: number | null }).batchId === before.batchId) {
        await db.update(complaintsTable).set({ batchId: null, updatedAt: new Date() } as never)
          .where(eq(complaintsTable.id, before.complaintId));
      }
    }

    void writeCandidateAudit({
      rowId: candId, operation: "UPDATE",
      changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: row as unknown as Record<string, unknown>,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update candidate batch");
    res.status(500).json({ error: "Failed to update candidate batch" });
  }
});

// DELETE — remove a candidate that was attached by mistake. Allowed ONLY while
// it is still 'suspected' (un-resolved); a confirmed/ruled_out candidate carries
// an investigation conclusion and is kept (resolve it instead). This is a
// pre-investigation cleanup affordance, not a QMS-record deletion.
router.delete("/complaint-candidate-batches/:candId", async (req, res) => {
  try {
    const candId = parseInt(req.params.candId);
    const [before] = await db.select().from(complaintCandidateBatchesTable).where(eq(complaintCandidateBatchesTable.id, candId));
    if (!before) { res.status(404).json({ error: "Candidate not found." }); return; }
    if (before.status !== "suspected") {
      res.status(409).json({ error: "Only an unresolved (suspected) candidate can be removed. Rule it out instead to keep the trail." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    await db.delete(complaintCandidateBatchesTable).where(eq(complaintCandidateBatchesTable.id, candId));
    void writeCandidateAudit({
      rowId: candId, operation: "DELETE",
      changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete candidate batch");
    res.status(500).json({ error: "Failed to delete candidate batch" });
  }
});

// ── Session 75 — open an internal NC from a complaint ────────────────────────
//
// "We had linked complaints and NCs" — a customer complaint that warrants
// internal investigation spawns a Nonconformance, pre-filled from the complaint
// (product, lot, confirmed batch, description, severity), and the complaint is
// linked to it (complaints.nc_id). Many complaints can point at one NC. Any
// authenticated user may raise an NC (per the NC SOP, "any employee can raise
// an NC"). Off-spec / raw-fetch.
router.post("/complaints/:id/promote-to-nc", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [complaint] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!complaint) { res.status(404).json({ error: "Complaint not found" }); return; }
    if ((complaint as { cancelledAt?: unknown }).cancelledAt) {
      res.status(409).json({ error: "This complaint is cancelled. Re-open it first." }); return;
    }
    if ((complaint as { ncId?: number | null }).ncId) {
      res.status(409).json({ error: "This complaint is already linked to a nonconformance." }); return;
    }

    // Complaint severity (Critical|High|Medium|Low) → NC severity (Critical|Major|Minor).
    const ncSeverity = complaint.severity === "Critical" ? "Critical" : complaint.severity === "High" ? "Major" : "Minor";
    const ncNumber = await nextNcNumber();
    const body = (req.body ?? {}) as { title?: string; description?: string };

    const [nc] = await db.insert(nonConformancesTable).values({
      ncNumber,
      title: (body.title ?? `From ${complaint.complaintNumber}: ${complaint.complaintType ?? "Complaint"}`).slice(0, 250),
      description: body.description ?? complaint.description,
      severity: ncSeverity,
      source: "Complaint",
      status: "Open",
      identifiedAt: complaint.receivedDate,
      productName: complaint.productName ?? null,
      lotNumber: complaint.lotNumber ?? null,
      batchId: complaint.batchId ?? null,
      reportedByUserId: actor.id,
      reportedByName: actor.fullName,
    } as typeof nonConformancesTable.$inferInsert).returning();

    await db.update(complaintsTable).set({ ncId: nc.id, updatedAt: new Date() } as never).where(eq(complaintsTable.id, id));

    void writeAuditLog({
      rowId: id, operation: "PROMOTE_TO_NC",
      changedById: actor.id, changedByName: actor.fullName,
      afterState: { ncId: nc.id, ncNumber: nc.ncNumber } as Record<string, unknown>,
    });
    try {
      await db.insert(auditLogTable).values({
        tableName: "non_conformances", rowId: nc.id, operation: "INSERT",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { ncNumber: nc.ncNumber, source: "Complaint", sourceComplaintId: id, sourceComplaintNumber: complaint.complaintNumber } as never,
      });
    } catch { /* audit must not break the flow */ }

    res.status(201).json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to open NC from complaint");
    res.status(500).json({ error: "Failed to open a nonconformance from this complaint." });
  }
});

// Session 101 — escalate a complaint DIRECTLY to a CAPA (no NC first). Creates a
// CAPA with source_complaint_id set, links it back (complaints.capa_id), and
// moves the complaint to "Pending Corrections". Mirrors promote-to-nc.
router.post("/complaints/:id/promote-to-capa", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [complaint] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!complaint) { res.status(404).json({ error: "Complaint not found" }); return; }
    if ((complaint as { cancelledAt?: unknown }).cancelledAt) {
      res.status(409).json({ error: "This complaint is cancelled. Re-open it first." }); return;
    }
    if ((complaint as { capaId?: number | null }).capaId) {
      res.status(409).json({ error: "This complaint is already linked to a CAPA." }); return;
    }

    const capaNumber = await nextCapaNumber();
    const { riskLevel, riskRationale } = deriveCapaRisk(complaint.severity, `complaint ${complaint.complaintNumber}`);
    const body = (req.body ?? {}) as { title?: string; description?: string };

    const [capa] = await db.insert(capasTable).values({
      capaNumber,
      type: "Corrective",
      title: (body.title ?? `From ${complaint.complaintNumber}: ${complaint.complaintType ?? "Complaint"}`).slice(0, 250),
      description: body.description ?? complaint.description,
      stage: "Initiation",
      status: "Open",
      sourceComplaintId: id,
      originatorId: actor.id,
      originatorName: actor.fullName,
      openedById: actor.id,
      openedByName: actor.fullName,
      productName: complaint.productName ?? null,
      lotNumber: complaint.lotNumber ?? null,
      riskLevel,
      riskRationale,
    } as typeof capasTable.$inferInsert).returning();

    await db.update(complaintsTable)
      .set({ capaId: capa.id, status: "Pending Corrections", updatedAt: new Date() } as never)
      .where(eq(complaintsTable.id, id));

    void writeAuditLog({
      rowId: id, operation: "PROMOTE_TO_CAPA",
      changedById: actor.id, changedByName: actor.fullName,
      afterState: { capaId: capa.id, capaNumber: capa.capaNumber, status: "Pending Corrections" } as Record<string, unknown>,
    });
    try {
      await db.insert(auditLogTable).values({
        tableName: "capas", rowId: capa.id, operation: "INSERT",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { capaNumber: capa.capaNumber, source: "Complaint", sourceComplaintId: id, sourceComplaintNumber: complaint.complaintNumber } as never,
      });
    } catch { /* audit must not break the flow */ }

    res.status(201).json(capa);
  } catch (err) {
    req.log.error({ err }, "Failed to open CAPA from complaint");
    res.status(500).json({ error: "Failed to open a CAPA from this complaint." });
  }
});

// Session 101 (#3) — complaint corrections (immediate containment actions logged
// on the complaint; distinct from a CAPA's corrective/preventive actions).
router.get("/complaints/:id/corrections", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(complaintCorrectionsTable)
      .where(eq(complaintCorrectionsTable.complaintId, id))
      .orderBy(desc(complaintCorrectionsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list complaint corrections");
    res.status(500).json({ error: "Failed to list corrections" });
  }
});

router.post("/complaints/:id/corrections", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    // Session 62 — a correction is now a TASK: assigned to someone, due by a date,
    // completed later. performedOn is no longer set here — it is recorded at
    // completion, as the date the work actually happened.
    const { description, dueDate, taskOwnerName, taskOwnerUserId, notes } = (req.body ?? {}) as {
      description?: string; dueDate?: string; taskOwnerName?: string; taskOwnerUserId?: number | null; notes?: string;
    };
    if (!description || !description.trim()) { res.status(400).json({ error: "A correction description is required." }); return; }
    const [row] = await db.insert(complaintCorrectionsTable).values({
      complaintId: id,
      description: description.trim(),
      dueDate: dueDate || null,
      taskOwnerName: taskOwnerName?.trim() || null,
      taskOwnerUserId: taskOwnerUserId ?? null,
      notes: notes?.trim() || null,
      // Legacy performedBy* keep recording who RAISED the task, matching how the
      // NC route uses them, so older audit reads still resolve a name.
      performedByUserId: actor?.id ?? null,
      performedByName: actor?.fullName ?? null,
    }).returning();
    void writeAuditLog({
      rowId: id, operation: "CORRECTION_ADDED",
      changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null,
      afterState: row as unknown as Record<string, unknown>,
    });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add complaint correction");
    res.status(500).json({ error: "Failed to add correction" });
  }
});

// Session 62 — complete a complaint correction. Mirrors
// POST /nc-corrections/:id/complete exactly, including the owner-only rule and
// the requirement to say what was done and when: a containment action that
// cannot be described was not really performed.
router.post("/complaint-corrections/:id/complete", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [existing] = await db.select().from(complaintCorrectionsTable).where(eq(complaintCorrectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Correction task not found" }); return; }
    if (existing.completed) { res.json(existing); return; }

    const isOwner =
      (existing.taskOwnerUserId != null && existing.taskOwnerUserId === actor.id) ||
      (!!existing.taskOwnerName && existing.taskOwnerName.trim().toLowerCase() === actor.fullName.trim().toLowerCase());
    if (!isOwner) {
      res.status(403).json({ error: "Only the assigned owner can complete this task. Reassign it to yourself first if you're taking it over." });
      return;
    }

    const doneNotes = String((req.body as { notes?: unknown })?.notes ?? "").trim();
    const performedOn = String((req.body as { performedOn?: unknown })?.performedOn ?? "").trim();
    if (!doneNotes || !performedOn) {
      res.status(400).json({ error: "Completing a correction requires a description of what was done and the date it was performed." });
      return;
    }

    const [row] = await db.update(complaintCorrectionsTable)
      .set({
        completed: true,
        completedAt: new Date(),
        completedByUserId: actor.id,
        completedByName: actor.fullName,
        notes: doneNotes,
        performedOn,
        updatedAt: new Date(),
      } as never)
      .where(eq(complaintCorrectionsTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: existing.complaintId,
      operation: "CORRECTION_COMPLETED",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { correctionId: id, completed: false } as never,
      afterState: { correctionId: id, completed: true, completedByName: actor.fullName } as never,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to complete complaint correction");
    res.status(500).json({ error: "Failed to complete correction task" });
  }
});

// Session 62 — take ownership, so a non-owner can pick up a task rather than be
// stuck: completion is owner-only, and the handoff is explicit and audited.
router.post("/complaint-corrections/:id/reassign-to-me", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [existing] = await db.select().from(complaintCorrectionsTable).where(eq(complaintCorrectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Correction task not found" }); return; }
    if (existing.completed) { res.status(409).json({ error: "This task is already completed." }); return; }
    const [row] = await db.update(complaintCorrectionsTable)
      .set({ taskOwnerUserId: actor.id, taskOwnerName: actor.fullName, updatedAt: new Date() } as never)
      .where(eq(complaintCorrectionsTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: existing.complaintId,
      operation: "CORRECTION_REASSIGNED",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { correctionId: id, taskOwnerName: existing.taskOwnerName } as never,
      afterState: { correctionId: id, taskOwnerName: actor.fullName } as never,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to reassign complaint correction");
    res.status(500).json({ error: "Failed to reassign correction task" });
  }
});

// Session 62.2 — complaint correction tasks assigned to the signed-in user, for
// the My Queue tile. Mirrors GET /my/nc-corrections exactly, including matching
// the owner on id OR name: tasks created before the owner picker landed carry a
// typed name and no id, and they should still reach the person.
router.get("/my/complaint-corrections", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const rows = await db
      .select({
        id: complaintCorrectionsTable.id,
        complaintId: complaintCorrectionsTable.complaintId,
        description: complaintCorrectionsTable.description,
        dueDate: complaintCorrectionsTable.dueDate,
        complaintNumber: complaintsTable.complaintNumber,
        complaintTitle: complaintsTable.description,
      })
      .from(complaintCorrectionsTable)
      .innerJoin(complaintsTable, eq(complaintCorrectionsTable.complaintId, complaintsTable.id))
      .where(and(
        eq(complaintCorrectionsTable.completed, false),
        ne(complaintsTable.status, "Closed"),
        or(
          eq(complaintCorrectionsTable.taskOwnerUserId, actor.id),
          sql`lower(${complaintCorrectionsTable.taskOwnerName}) = ${actor.fullName.trim().toLowerCase()}`,
        ),
      ))
      .orderBy(complaintCorrectionsTable.dueDate);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list my complaint-corrections");
    res.status(500).json({ error: "Failed to list correction tasks" });
  }
});

export default router;
