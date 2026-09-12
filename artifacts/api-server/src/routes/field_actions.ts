import { Router } from "express";
import { db } from "@workspace/db";
import {
  fieldActionsTable,
  auditLogTable,
  fieldActionLotsTable,
  fieldActionBatchesTable,
  lotsTable,
  lotEventsTable,
  faResponseActionsTable,
  nonConformancesTable,
  complaintsTable,
  capasTable,
  shipmentsTable,
  batchRecordsTable,
  batchManifestsTable,
  batchManifestPackagesTable,
} from "@workspace/db";
import { eq, and, like, inArray, isNull } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { nextCapaNumber, deriveCapaRisk } from "../lib/qualityEvents";

// Session 56 — closing a Field Action is a Part 11 e-signature event and must
// be restricted to an approver role (mirrors the NC close gate).
const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// Session 63.4 — gate reviews. Signing a gate is a narrower act than closing:
// it is the quality judgement that the record may move on, so it is held to the
// same Manager/Quality/Admin set CAPA uses for its gates, not the wider
// approver set.
const GATE_ROLES = new Set(["Manager", "Quality", "Admin"]);

type Actor = { id: number; fullName: string | null; role: string; initials: string | null };

// Part 11 surface checks, shared by every gate. Returns an error to send, or
// null when the signature is acceptable.
function checkGateSignature(
  actor: Actor,
  initials: string | undefined,
  signatureMeaning: string | undefined,
): { status: number; error: string } | null {
  if (!initials || !initials.trim() || !signatureMeaning || !signatureMeaning.trim()) {
    return { status: 400, error: "Initials and signing meaning are required (21 CFR Part 11)." };
  }
  if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
    return { status: 400, error: "Initials do not match the signed-in user." };
  }
  if (!GATE_ROLES.has(actor.role)) {
    return { status: 403, error: `Signing a gate review requires Manager, Quality, or Admin role. Your role is "${actor.role}".` };
  }
  return null;
}

// Response Active → Due Diligence is NOT a gate. It flips on its own the moment
// every response action carries a notification date, because that is precisely
// what "the response is finished" means — there is no judgement left for a
// signer to make. Called after any response-action write; a no-op unless the FA
// is sitting in Response Active with at least one row and none unnotified.
async function maybeAdvanceToDueDiligence(faId: number): Promise<void> {
  try {
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (!fa || fa.status !== "Response Active") return;
    const rows = await db
      .select()
      .from(faResponseActionsTable)
      .where(eq(faResponseActionsTable.fieldActionId, faId));
    if (rows.length === 0) return;
    if (rows.some((r) => !r.notificationDate)) return;
    const [updated] = await db
      .update(fieldActionsTable)
      .set({ status: "Due Diligence", updatedAt: new Date() })
      .where(and(eq(fieldActionsTable.id, faId), eq(fieldActionsTable.status, "Response Active")))
      .returning();
    if (!updated) return;
    void writeAuditLog({
      rowId: faId,
      operation: "ADVANCE_TO_DUE_DILIGENCE",
      beforeState: { status: "Response Active" },
      afterState: {
        status: "Due Diligence",
        reason: "every response action has a recorded notification date",
        responseActions: rows.length,
      } as never,
    });
  } catch {
    // Never let the convenience advance break the write that triggered it.
  }
}

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
      tableName: "field_actions",
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

// Session 55.1 — generate the next FA number from MAX of the parsed sequence
// of existing fa_number values for the current year, NOT count(*). The old
// count(*) approach had two defects: (1) node-postgres returns count(*) as a
// string, so `count + 1` concatenated ("1" + 1 = "11") and numbers jumped by
// 10; (2) even coerced, count(*) collides once the data holds an out-of-order
// high number (the concat bug already produced FA-26-0011 with only 2 rows) or
// after any delete. MAX+1 is year-scoped, monotonic, and never reuses a number
// (Part 11). Matches generateNcNumber in non_conformances.ts. The unique
// constraint on fa_number is the hard backstop for the TOCTOU window.
async function generateFaNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `FA-${year}-`;
  const rows = await db
    .select({ faNumber: fieldActionsTable.faNumber })
    .from(fieldActionsTable)
    .where(like(fieldActionsTable.faNumber, `${prefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = r.faNumber.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

router.get("/field-actions", async (req, res) => {
  try {
    const rows = await db.select().from(fieldActionsTable).orderBy(fieldActionsTable.createdAt);
    // Per-FA response + reach rollups so the list-page charts (recovery %, reach,
    // notification status) do not need N detail fetches.
    const resp = await db.select().from(faResponseActionsTable);
    const batchLinks = await db.select({ faId: fieldActionBatchesTable.fieldActionId }).from(fieldActionBatchesTable);
    const lotLinks = await db.select({ faId: fieldActionLotsTable.fieldActionId }).from(fieldActionLotsTable);
    type Agg = { stores: number; notified: number; formReceived: number; destroyed: number; returned: number; unitsAffected: number; unitsAccounted: number };
    const byFa = new Map<number, Agg>();
    for (const r of resp) {
      const a = byFa.get(r.fieldActionId) ?? { stores: 0, notified: 0, formReceived: 0, destroyed: 0, returned: 0, unitsAffected: 0, unitsAccounted: 0 };
      a.stores += 1;
      if (r.notificationDate) a.notified += 1;
      if (r.responseFormReceived) a.formReceived += 1;
      if (r.productDestroyed) a.destroyed += 1;
      if (r.productReturned) a.returned += 1;
      const ua = r.unitsAffected ?? 0;
      a.unitsAffected += ua;
      a.unitsAccounted += r.productDestroyed ? ua : (r.unitsReturned ?? 0);
      byFa.set(r.fieldActionId, a);
    }
    const batchCount = new Map<number, number>();
    for (const b of batchLinks) batchCount.set(b.faId, (batchCount.get(b.faId) ?? 0) + 1);
    const lotCount = new Map<number, number>();
    for (const l of lotLinks) lotCount.set(l.faId, (lotCount.get(l.faId) ?? 0) + 1);
    const enriched = rows.map((fa) => {
      const a = byFa.get(fa.id) ?? { stores: 0, notified: 0, formReceived: 0, destroyed: 0, returned: 0, unitsAffected: 0, unitsAccounted: 0 };
      return {
        ...fa,
        responseSummary: {
          ...a,
          batches: batchCount.get(fa.id) ?? 0,
          lots: lotCount.get(fa.id) ?? 0,
          recoveryPct: a.unitsAffected > 0 ? Math.round((a.unitsAccounted / a.unitsAffected) * 100) : null,
        },
      };
    });
    res.json(enriched.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list field actions");
    res.status(500).json({ error: "Failed to list field actions" });
  }
});

router.post("/field-actions", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    // Session 76 — opening a Field Action directly is restricted to approver
    // roles. Operators must submit a request (POST /field-actions/request) that
    // an approver reviews. This is the server-side backstop behind the role-
    // aware UI; it never affects the NC→FA escalation path (that lives in
    // non_conformances.ts and is separately gated).
    if (!actor) { res.status(401).json({ error: "Authentication required to open a field action." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Opening a Field Action requires Supervisor / Manager / Quality / Admin role. Operators submit a request for approval instead. Your role is "${actor.role}".` });
      return;
    }
    const faNumber = await generateFaNumber();
    const body = { ...(req.body as Record<string, unknown>) };

    // Session 13 — source NC/Complaint linking. Session 75 — validate that any
    // provided source reference points at a real record (soft-link integrity).
    const sourceNcId = body.sourceNcId as number | null | undefined;
    const sourceComplaintId = body.sourceComplaintId as number | null | undefined;
    let ncRow: typeof nonConformancesTable.$inferSelect | undefined;
    let complaintRow: typeof complaintsTable.$inferSelect | undefined;
    if (sourceNcId) {
      [ncRow] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, Number(sourceNcId)));
      if (!ncRow) { res.status(400).json({ error: `No nonconformance #${sourceNcId} exists to link.` }); return; }
    }
    if (sourceComplaintId) {
      [complaintRow] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, Number(sourceComplaintId)));
      if (!complaintRow) { res.status(400).json({ error: `No complaint #${sourceComplaintId} exists to link.` }); return; }
    }

    // Seed the narrative from the source record when none was provided.
    const reasonProvided = typeof body.initiationReason === "string" && body.initiationReason.trim().length > 0;
    if (!reasonProvided && ncRow) {
      body.initiationReason = `[From ${ncRow.ncNumber}] ${ncRow.description}`;
    } else if (!reasonProvided && complaintRow) {
      body.initiationReason = `[From ${complaintRow.complaintNumber}] ${complaintRow.description}`;
    }

    // ── Session 75 BUSINESS RULE: every Field Action must have a CAPA. ────────
    // If the caller linked one, validate it exists; otherwise auto-open a CAPA
    // (pre-filled from the FA + any source record) and link it. No FA without a
    // CAPA behind it.
    let linkedCapaId = body.linkedCapaId == null ? null : Number(body.linkedCapaId);
    if (linkedCapaId != null) {
      const [capa] = await db.select({ id: capasTable.id }).from(capasTable).where(eq(capasTable.id, linkedCapaId));
      if (!capa) { res.status(400).json({ error: `No CAPA #${body.linkedCapaId} exists to link.` }); return; }
    } else {
      const capaNumber = await nextCapaNumber();
      const severity = ncRow?.severity ?? complaintRow?.severity ?? null;
      const origin = ncRow ? ncRow.ncNumber : complaintRow ? complaintRow.complaintNumber : `Field Action ${faNumber}`;
      const { riskLevel, riskRationale } = deriveCapaRisk(severity, `${origin} (a Field Action requires a CAPA)`);
      const faTitle = typeof body.title === "string" && body.title.trim() ? body.title.trim() : faNumber;
      const [capa] = await db.insert(capasTable).values({
        capaNumber,
        type: "Corrective",
        title: `CAPA for ${faNumber}: ${faTitle}`.slice(0, 250),
        description: (typeof body.initiationReason === "string" && body.initiationReason) || faTitle,
        sourceNcId: ncRow ? ncRow.id : null,
        sourceComplaintId: complaintRow ? complaintRow.id : null,
        status: "Open",
        stage: "Initiation",
        riskLevel,
        riskRationale,
        openedById: actor?.id ?? null,
        openedByName: actor?.fullName ?? null,
        originatorId: actor?.id ?? null,
      } as typeof capasTable.$inferInsert).returning();
      linkedCapaId = capa.id;
      try {
        await db.insert(auditLogTable).values({
          tableName: "capas", rowId: capa.id, operation: "INSERT",
          changedBy: actor?.id ?? null, changedByName: actor?.fullName ?? null,
          afterState: { capaNumber: capa.capaNumber, autoCreatedForFieldAction: faNumber } as never,
        });
      } catch { /* audit must not break the flow */ }
    }
    body.linkedCapaId = linkedCapaId;

    const [fa] = await db.insert(fieldActionsTable).values({ ...body, faNumber } as typeof fieldActionsTable.$inferInsert).returning();
    void writeAuditLog({
      rowId: fa.id,
      operation: "INSERT",
      changedById: actor?.id ?? null,
      changedByName: (req.body as Record<string, unknown>).initiatedByName as string ?? actor?.fullName ?? null,
      afterState: fa as unknown as Record<string, unknown>,
    });
    res.status(201).json(fa);
  } catch (err) {
    req.log.error({ err }, "Failed to create field action");
    res.status(500).json({ error: "Failed to create field action" });
  }
});

// ── Session 76 — Field Action request → approval workflow ────────────────────
//
// Operators cannot open a Field Action directly (the POST above is approver-
// gated). Instead they submit a REQUEST, which lands in status "Requested" with
// NO CAPA. An approver then approves it — at which point the mandatory CAPA is
// opened and linked and the FA moves to "Initiated" — or rejects it with a
// reason. The "FA never without a CAPA" rule is preserved: a Requested FA is not
// yet an open Field Action, and the CAPA is created at the approval moment.

// Open the mandatory CAPA for a Field Action and return its id. Mirrors the
// auto-create block in POST /field-actions so an approved request and a direct
// create produce identical linked-CAPA records. Pre-fills from the FA's linked
// NC / Complaint when present.
async function openMandatoryCapaForFa(
  fa: typeof fieldActionsTable.$inferSelect,
  actor: { id: number; fullName: string } | null,
): Promise<number> {
  let ncRow: typeof nonConformancesTable.$inferSelect | undefined;
  let complaintRow: typeof complaintsTable.$inferSelect | undefined;
  if (fa.sourceNcId) {
    [ncRow] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, fa.sourceNcId));
  }
  if (fa.sourceComplaintId) {
    [complaintRow] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, fa.sourceComplaintId));
  }
  const capaNumber = await nextCapaNumber();
  const severity = ncRow?.severity ?? complaintRow?.severity ?? null;
  const origin = ncRow ? ncRow.ncNumber : complaintRow ? complaintRow.complaintNumber : `Field Action ${fa.faNumber}`;
  const { riskLevel, riskRationale } = deriveCapaRisk(severity, `${origin} (a Field Action requires a CAPA)`);
  const [capa] = await db.insert(capasTable).values({
    capaNumber,
    type: "Corrective",
    title: `CAPA for ${fa.faNumber}: ${fa.title}`.slice(0, 250),
    description: fa.initiationReason || fa.title,
    sourceNcId: ncRow ? ncRow.id : null,
    sourceComplaintId: complaintRow ? complaintRow.id : null,
    status: "Open",
    stage: "Initiation",
    riskLevel,
    riskRationale,
    openedById: actor?.id ?? null,
    openedByName: actor?.fullName ?? null,
    originatorId: actor?.id ?? null,
  } as typeof capasTable.$inferInsert).returning();
  try {
    await db.insert(auditLogTable).values({
      tableName: "capas", rowId: capa.id, operation: "INSERT",
      changedBy: actor?.id ?? null, changedByName: actor?.fullName ?? null,
      afterState: { capaNumber: capa.capaNumber, autoCreatedForFieldAction: fa.faNumber } as never,
    });
  } catch { /* audit must not break the flow */ }
  return capa.id;
}

router.post("/field-actions/request", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to request a field action." }); return; }
    const faNumber = await generateFaNumber();
    const body = { ...(req.body as Record<string, unknown>) };

    // Validate any linked source the same way the direct create does.
    const sourceNcId = body.sourceNcId as number | null | undefined;
    const sourceComplaintId = body.sourceComplaintId as number | null | undefined;
    let ncRow: typeof nonConformancesTable.$inferSelect | undefined;
    let complaintRow: typeof complaintsTable.$inferSelect | undefined;
    if (sourceNcId) {
      [ncRow] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, Number(sourceNcId)));
      if (!ncRow) { res.status(400).json({ error: `No nonconformance #${sourceNcId} exists to link.` }); return; }
    }
    if (sourceComplaintId) {
      [complaintRow] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, Number(sourceComplaintId)));
      if (!complaintRow) { res.status(400).json({ error: `No complaint #${sourceComplaintId} exists to link.` }); return; }
    }
    const reasonProvided = typeof body.initiationReason === "string" && body.initiationReason.trim().length > 0;
    if (!reasonProvided && ncRow) {
      body.initiationReason = `[From ${ncRow.ncNumber}] ${ncRow.description}`;
    } else if (!reasonProvided && complaintRow) {
      body.initiationReason = `[From ${complaintRow.complaintNumber}] ${complaintRow.description}`;
    }

    // A request carries NO CAPA — one is opened at approval. Force Requested
    // status and stamp the requester; never trust a client-supplied status.
    delete body.linkedCapaId;
    delete body.status;
    const [fa] = await db.insert(fieldActionsTable).values({
      ...body,
      faNumber,
      status: "Requested",
      requestedById: actor.id,
      requestedByName: actor.fullName,
      requestedAt: new Date(),
    } as typeof fieldActionsTable.$inferInsert).returning();
    void writeAuditLog({
      rowId: fa.id,
      operation: "REQUEST",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: fa as unknown as Record<string, unknown>,
    });
    res.status(201).json(fa);
  } catch (err) {
    req.log.error({ err }, "Failed to request field action");
    res.status(500).json({ error: "Failed to submit field action request" });
  }
});

router.post("/field-actions/:id/approve-request", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to approve a request." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Approving a field action request requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    if (fa.status !== "Requested") {
      res.status(409).json({ error: `Only a Requested field action can be approved. This one is "${fa.status}".` }); return;
    }
    // Open the mandatory CAPA now (not at request time), then open the FA.
    const capaId = await openMandatoryCapaForFa(fa, actor);
    const [updated] = await db.update(fieldActionsTable).set({
      status: "Initiated",
      linkedCapaId: capaId,
      reviewedById: actor.id,
      reviewedByName: actor.fullName,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(fieldActionsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "APPROVE_REQUEST",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: fa as unknown as Record<string, unknown>,
      afterState: updated as unknown as Record<string, unknown>,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to approve field action request");
    res.status(500).json({ error: "Failed to approve field action request" });
  }
});

router.post("/field-actions/:id/reject-request", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body as { reason?: string };
    if (!reason || !reason.trim()) {
      res.status(400).json({ error: "A rejection reason is required." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to reject a request." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Rejecting a field action request requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    if (fa.status !== "Requested") {
      res.status(409).json({ error: `Only a Requested field action can be rejected. This one is "${fa.status}".` }); return;
    }
    const [updated] = await db.update(fieldActionsTable).set({
      status: "Request Rejected",
      rejectionReason: reason.trim(),
      reviewedById: actor.id,
      reviewedByName: actor.fullName,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(fieldActionsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "REJECT_REQUEST",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: fa as unknown as Record<string, unknown>,
      afterState: updated as unknown as Record<string, unknown>,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to reject field action request");
    res.status(500).json({ error: "Failed to reject field action request" });
  }
});

router.get("/field-actions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    res.json(fa);
  } catch (err) {
    req.log.error({ err }, "Failed to get field action");
    res.status(500).json({ error: "Failed to get field action" });
  }
});

router.patch("/field-actions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    // Session 63.4 — the status is now owned by the gate reviews. Letting this
    // generic PATCH set it would leave the gates decorative: a recall could be
    // walked to Closed without anyone signing that the scope was right or the
    // reconciliation held. Refused loudly rather than dropped silently, so a
    // caller finds out instead of thinking it worked.
    const body = { ...(req.body as Record<string, unknown>) };
    if ("status" in body && body.status !== before?.status) {
      res.status(409).json({
        error: `The status of a field action is set by its gate reviews, not edited directly. Sign the gate below the section you have finished to move it from "${before?.status ?? "?"}".`,
      });
      return;
    }
    delete body.status;
    // Signature columns are written only by the gate and close endpoints.
    for (const k of Object.keys(body)) {
      if (k.startsWith("gate") || k.startsWith("lastRejection") || k.startsWith("closed")) delete body[k];
    }
    const [fa] = await db.update(fieldActionsTable).set({ ...body, updatedAt: new Date() }).where(eq(fieldActionsTable.id, id)).returning();
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    // Session 100 — attribute the edit to the signed-in user (Part 11) instead
    // of leaving changedByName null, which renders as "System".
    const auditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: auditActor?.id ?? null,
      changedByName: auditActor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: fa as unknown as Record<string, unknown>,
    });
    res.json(fa);
  } catch (err) {
    req.log.error({ err }, "Failed to update field action");
    res.status(500).json({ error: "Failed to update field action" });
  }
});

router.post("/field-actions/:id/close", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, closureNotes } = req.body as {
      initials?: string; signatureMeaning?: string; closureNotes?: string;
    };
    if (!initials || !signatureMeaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    // Session 56 — Part 11 role gate. The closer must hold an approver role and
    // sign with initials that match their own profile.
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to close a field action." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Closing a field action requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." });
      return;
    }
    const [before] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!before) { res.status(404).json({ error: "Field action not found" }); return; }
    // Session 63.4 — closure is Gate 3, and it cannot be signed until Gate 2 has
    // accepted the due-diligence reconciliation. Without this the gates would
    // stop at Gate 2 and a field action could still be closed straight past it.
    if (!before.gate2ApprovedAt) {
      res.status(409).json({
        error: "Gate 2 has not been signed. The due-diligence reconciliation must be accepted before this field action can be closed.",
      });
      return;
    }
    // Session 63.5 — every licensee's product must be accounted for. A store
    // answering for 20 of the 40 units it holds has responded, but the other 20
    // are still out there, so a returned form is not the same as a resolved row.
    // The outstanding stores are NAMED: "some rows are open" would send someone
    // hunting through the list.
    const openRows = await db
      .select()
      .from(faResponseActionsTable)
      .where(and(
        eq(faResponseActionsTable.fieldActionId, id),
        eq(faResponseActionsTable.allItemsAccounted, false),
      ));
    if (openRows.length > 0) {
      const names = openRows.map((r) => r.storeName).join(", ");
      res.status(409).json({
        error: `Cannot close — product is still unaccounted for at: ${names}. Tick "All items accounted for" on each response action once every unit that licensee holds is returned, destroyed or otherwise reconciled.`,
      });
      return;
    }
    const [fa] = await db.update(fieldActionsTable).set({
      status: "Closed",
      closureNotes,
      closedBy: actor.id,
      closedByInitials: initials.trim().toUpperCase(),
      // closedByName used to be handed the signing MEANING, which threw away the
      // name of the person who signed — the one thing a Part 11 record must keep.
      closedByName: actor.fullName,
      closedByMeaning: signatureMeaning.trim(),
      closedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(fieldActionsTable.id, id)).returning();
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    void writeAuditLog({
      rowId: id,
      operation: "CLOSE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: fa as unknown as Record<string, unknown>,
    });
    res.json(fa);
  } catch (err) {
    req.log.error({ err }, "Failed to close field action");
    res.status(500).json({ error: "Failed to close field action" });
  }
});

// ── Gate reviews (Session 63.4) ──────────────────────────────────────────────
//
// One config table, three endpoints. Each gate sits below the section it
// approves and is the ONLY thing that moves the record on from that section —
// the status dropdown is gone and PATCH refuses to set status.
//
// A rejection deliberately does NOT walk the status backwards. It records the
// refusal and its reason and leaves the record exactly where it is, so the
// section can be corrected and re-signed. Moving it back would mean re-signing
// gates that were never in question.

const GATES = {
  "0": {
    label: "Gate 0",
    requiresStatus: "Initiated",
    nextStatus: "Scope Defined",
    requiredField: "initiationReason" as const,
    requiredFieldLabel: "Initiation Reason",
    idCol: "gate0ApproverId", nameCol: "gate0ApproverName",
    initialsCol: "gate0ApproverInitials", meaningCol: "gate0ApproverMeaning",
    atCol: "gate0ApprovedAt",
  },
  "1": {
    label: "Gate 1",
    requiresStatus: "Scope Defined",
    nextStatus: "Response Active",
    requiredField: "scopeDescription" as const,
    requiredFieldLabel: "Scope Description",
    idCol: "gate1ApproverId", nameCol: "gate1ApproverName",
    initialsCol: "gate1ApproverInitials", meaningCol: "gate1ApproverMeaning",
    atCol: "gate1ApprovedAt",
  },
  "2": {
    label: "Gate 2",
    requiresStatus: "Due Diligence",
    // Gate 2 does not advance the status: Due Diligence IS the last stage
    // before closure. What it does is unlock the closure signature.
    nextStatus: null as string | null,
    requiredField: "dueDiligenceNotes" as const,
    requiredFieldLabel: "Due Diligence Notes",
    idCol: "gate2ApproverId", nameCol: "gate2ApproverName",
    initialsCol: "gate2ApproverInitials", meaningCol: "gate2ApproverMeaning",
    atCol: "gate2ApprovedAt",
  },
} as const;

for (const gateKey of Object.keys(GATES) as (keyof typeof GATES)[]) {
router.post(`/field-actions/:id/gate${gateKey}-approve`, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const key = gateKey;
    const gate = GATES[key];
    if (!gate) { res.status(404).json({ error: "Unknown gate." }); return; }

    const { initials, signatureMeaning } = (req.body ?? {}) as { initials?: string; signatureMeaning?: string };
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const sigError = checkGateSignature(actor as Actor, initials, signatureMeaning);
    if (sigError) { res.status(sigError.status).json({ error: sigError.error }); return; }

    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    if (fa.status !== gate.requiresStatus) {
      res.status(409).json({
        error: `${gate.label} can only be signed while the field action is at "${gate.requiresStatus}" (it is currently "${fa.status}").`,
      });
      return;
    }
    const sectionValue = (fa as Record<string, unknown>)[gate.requiredField];
    if (typeof sectionValue !== "string" || !sectionValue.trim()) {
      res.status(409).json({
        error: `${gate.label} approves the ${gate.requiredFieldLabel}, which is empty. Record it before signing.`,
      });
      return;
    }
    // The person who asked for this field action cannot be the one who signs it
    // through — a second pair of eyes, same rule as CAPA Gate 0.
    if (fa.requestedById && fa.requestedById === actor.id) {
      res.status(409).json({
        error: "You requested this field action. The requester cannot sign its gate reviews — a second pair of eyes is required (21 CFR Part 11).",
      });
      return;
    }

    const now = new Date();
    const patch: Record<string, unknown> = {
      [gate.idCol]: actor.id,
      [gate.nameCol]: actor.fullName,
      [gate.initialsCol]: (actor.initials ?? initials!).trim().toUpperCase(),
      [gate.meaningCol]: signatureMeaning!.trim(),
      [gate.atCol]: now,
      updatedAt: now,
    };
    if (gate.nextStatus) patch.status = gate.nextStatus;

    const [updated] = await db
      .update(fieldActionsTable)
      .set(patch as never)
      .where(and(
        eq(fieldActionsTable.id, id),
        eq(fieldActionsTable.status, gate.requiresStatus),
        // Idempotency guard: two reviewers hitting the same gate at once must
        // not both sign it.
        isNull(fieldActionsTable[gate.atCol as "gate0ApprovedAt"]),
      ))
      .returning();
    if (!updated) {
      res.status(409).json({ error: `${gate.label} state changed; refresh and try again.` });
      return;
    }

    void writeAuditLog({
      rowId: id,
      operation: `GATE${key}_APPROVED`,
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { status: fa.status },
      afterState: {
        status: updated.status,
        gate: gate.label,
        signer: actor.fullName,
        signatureMeaning: signatureMeaning!.trim(),
      } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to approve field action gate");
    res.status(500).json({ error: "Failed to approve gate" });
  }
});
}

for (const gateKey of Object.keys(GATES) as (keyof typeof GATES)[]) {
router.post(`/field-actions/:id/gate${gateKey}-reject`, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const key = gateKey;
    const gate = GATES[key];
    if (!gate) { res.status(404).json({ error: "Unknown gate." }); return; }

    const { comment } = (req.body ?? {}) as { comment?: string };
    if (!comment || !comment.trim()) {
      res.status(400).json({ error: "A reason is required when a gate review is rejected — it is what tells the owner what to fix." });
      return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!GATE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Rejecting a gate review requires Manager, Quality, or Admin role. Your role is "${actor.role}".` });
      return;
    }

    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, id));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    if (fa.status !== gate.requiresStatus) {
      res.status(409).json({
        error: `${gate.label} can only be rejected while the field action is at "${gate.requiresStatus}" (it is currently "${fa.status}").`,
      });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(fieldActionsTable)
      .set({
        lastRejectionAt: now,
        lastRejectionStage: gate.label,
        lastRejectionById: actor.id,
        lastRejectionByName: actor.fullName,
        lastRejectionComment: comment.trim(),
        updatedAt: now,
      } as never)
      .where(eq(fieldActionsTable.id, id))
      .returning();

    void writeAuditLog({
      rowId: id,
      operation: `GATE${key}_REJECTED`,
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { status: fa.status },
      afterState: { status: updated.status, gate: gate.label, comment: comment.trim() } as never,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to reject field action gate");
    res.status(500).json({ error: "Failed to reject gate" });
  }
});
}

// ── Affected lots (auto-quarantine) ──────────────────────────────────────────

router.get("/field-actions/:id/lots", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const rows = await db
      .select({
        link: fieldActionLotsTable,
        lot: lotsTable,
      })
      .from(fieldActionLotsTable)
      .innerJoin(lotsTable, eq(lotsTable.id, fieldActionLotsTable.lotId))
      .where(eq(fieldActionLotsTable.fieldActionId, faId))
      .orderBy(fieldActionLotsTable.createdAt);
    res.json(rows.map((r) => ({ ...r.link, lot: r.lot })));
  } catch (err) {
    req.log.error({ err }, "Failed to list FA lots");
    res.status(500).json({ error: "Failed to list affected lots" });
  }
});

router.post("/field-actions/:id/lots", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const { lotId, autoQuarantine, performedByName, performedBy, initials, signatureMeaning, notes } = req.body as {
      lotId: number; autoQuarantine?: boolean;
      performedByName?: string; performedBy?: number;
      initials?: string; signatureMeaning?: string; notes?: string;
    };
    if (!lotId) { res.status(400).json({ error: "lotId is required" }); return; }
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, lotId));
    if (!lot) { res.status(404).json({ error: "Lot not found" }); return; }

    if (autoQuarantine && (!initials || !signatureMeaning)) {
      res.status(400).json({ error: "Initials and signing meaning required to quarantine (21 CFR Part 11)" }); return;
    }

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(fieldActionLotsTable)
        .where(and(eq(fieldActionLotsTable.fieldActionId, faId), eq(fieldActionLotsTable.lotId, lotId)));
      let link = existing[0];
      if (!link) {
        [link] = await tx.insert(fieldActionLotsTable).values({
          fieldActionId: faId, lotId, notes: notes ?? null,
        }).returning();
      }

      let updatedLot = lot;
      let didQuarantine = false;
      if (autoQuarantine && lot.status === "Active") {
        didQuarantine = true;
        [updatedLot] = await tx.update(lotsTable).set({
          status: "Quarantined", updatedAt: new Date(),
        }).where(eq(lotsTable.id, lotId)).returning();
        await tx.insert(lotEventsTable).values({
          lotId,
          eventType: "Quarantined",
          quantityDelta: 0,
          resultingQuantity: lot.currentQuantity,
          reason: `Field action ${fa.faNumber}: ${fa.title}`,
          notes: notes ?? null,
          performedBy: performedBy ?? null,
          performedByName: performedByName ?? null,
          signedInitials: initials,
          signedMeaning: signatureMeaning,
          signedAt: new Date(),
        });
        await tx.update(fieldActionLotsTable)
          .set({ quarantinedAt: new Date() })
          .where(eq(fieldActionLotsTable.id, link.id));
        link = { ...link, quarantinedAt: new Date() };
      }
      return { link, lot: updatedLot, didQuarantine };
    });

    void writeAuditLog({
      rowId: faId,
      operation: result.didQuarantine ? "QUARANTINE_LOT" : "ATTACH_LOT",
      changedByName: performedByName ?? null,
      changedById: performedBy ?? null,
      beforeState: { lotId, lotNumber: lot.lotNumber, status: lot.status },
      afterState: {
        lotId,
        lotNumber: result.lot.lotNumber,
        status: result.lot.status,
        quarantined: result.didQuarantine,
        autoQuarantineRequested: !!autoQuarantine,
      },
    });
    res.status(201).json({ ...result.link, lot: result.lot, quarantined: result.didQuarantine });
  } catch (err) {
    req.log.error({ err }, "Failed to attach lot to FA");
    res.status(500).json({ error: "Failed to attach lot" });
  }
});

// ── Affected batches / finished goods (record-only, #4 2026-08-05) ───────────
//
// A field action records the affected finished-goods BATCH(es). Unlike lots this
// carries NO auto-quarantine — quarantine of in-house product is handled
// separately (e.g. via a CAPA). Attaching a batch is what powers the store
// suggestions below (batch → outbound manifests → destination stores).

router.get("/field-actions/:id/batches", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const rows = await db
      .select({ link: fieldActionBatchesTable, batch: batchRecordsTable })
      .from(fieldActionBatchesTable)
      .innerJoin(batchRecordsTable, eq(batchRecordsTable.id, fieldActionBatchesTable.batchId))
      .where(eq(fieldActionBatchesTable.fieldActionId, faId))
      .orderBy(fieldActionBatchesTable.createdAt);
    res.json(rows.map((r) => ({ ...r.link, batch: r.batch })));
  } catch (err) {
    req.log.error({ err }, "Failed to list FA batches");
    res.status(500).json({ error: "Failed to list affected batches" });
  }
});

router.post("/field-actions/:id/batches", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const { batchId, notes, createdByName } = req.body as {
      batchId?: number; notes?: string; createdByName?: string;
    };
    if (!batchId) { res.status(400).json({ error: "batchId is required" }); return; }
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    if (fa.status === "Closed") { res.status(409).json({ error: "Cannot add a batch to a Closed field action (21 CFR Part 11)." }); return; }
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, batchId));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    // Idempotent — a batch is attached at most once (unique index backstop).
    const existing = await db
      .select()
      .from(fieldActionBatchesTable)
      .where(and(eq(fieldActionBatchesTable.fieldActionId, faId), eq(fieldActionBatchesTable.batchId, batchId)));
    let link = existing[0];
    if (!link) {
      [link] = await db
        .insert(fieldActionBatchesTable)
        .values({ fieldActionId: faId, batchId, notes: notes ?? null, createdByName: createdByName ?? null })
        .returning();
      void writeAuditLog({
        rowId: faId,
        operation: "ATTACH_BATCH",
        changedByName: createdByName ?? null,
        afterState: { batchId, batchNumber: batch.batchNumber, productName: batch.productName },
      });
    }
    res.status(201).json({ ...link, batch });
  } catch (err) {
    req.log.error({ err }, "Failed to attach batch to FA");
    res.status(500).json({ error: "Failed to attach batch" });
  }
});

router.delete("/field-actions/:id/batches/:batchId", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const batchId = parseInt(req.params.batchId);
    const performedByName = (req.body as { performedByName?: string } | undefined)?.performedByName ?? null;
    const [parent] = await db.select({ status: fieldActionsTable.status }).from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (parent?.status === "Closed") { res.status(409).json({ error: "Cannot detach a batch from a Closed field action (21 CFR Part 11)." }); return; }
    const [link] = await db
      .select()
      .from(fieldActionBatchesTable)
      .where(and(eq(fieldActionBatchesTable.fieldActionId, faId), eq(fieldActionBatchesTable.batchId, batchId)));
    if (!link) { res.status(404).json({ error: "Link not found" }); return; }
    await db
      .delete(fieldActionBatchesTable)
      .where(and(eq(fieldActionBatchesTable.fieldActionId, faId), eq(fieldActionBatchesTable.batchId, batchId)));
    void writeAuditLog({
      rowId: faId,
      operation: "DETACH_BATCH",
      changedByName: performedByName,
      beforeState: { batchId },
      afterState: null,
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to detach batch from FA");
    res.status(500).json({ error: "Failed to detach batch" });
  }
});

// ── Suggested stores (auto-fill Response Actions from manifests/shipments) ───
//
// #4 (2026-08-05) — Read which stores the affected lots were shipped to, using
// data already in CannaQMS: the outbound manifests built on each affected lot's
// source batch (recipient + packages) and any lot-level shipment records. Returns
// store suggestions the operator can one-click add into Response Actions. This
// endpoint is READ-ONLY — it never writes anything. Honest limit: product
// transferred straight in METRC (with no CannaQMS manifest/shipment) will NOT
// appear, so the response `note` tells the user to verify against METRC.
router.get("/field-actions/:id/suggested-stores", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }

    const note =
      "Built from manifests and shipments recorded in CannaQMS. Any product shipped or transferred outside CannaQMS won't appear here — verify destinations and quantities against METRC.";

    // Affected lots attached to this field action.
    const lotRows = await db
      .select({ lot: lotsTable })
      .from(fieldActionLotsTable)
      .innerJoin(lotsTable, eq(lotsTable.id, fieldActionLotsTable.lotId))
      .where(eq(fieldActionLotsTable.fieldActionId, faId));
    const lots = lotRows.map((r) => r.lot);

    // Affected finished-goods BATCHES attached directly (record-only). When the
    // whole batch is recalled, every package on its outbound manifests counts.
    const faBatchRows = await db
      .select({ batch: batchRecordsTable })
      .from(fieldActionBatchesTable)
      .innerJoin(batchRecordsTable, eq(batchRecordsTable.id, fieldActionBatchesTable.batchId))
      .where(eq(fieldActionBatchesTable.fieldActionId, faId));
    const directBatches = faBatchRows.map((r) => r.batch);
    const directBatchIds = new Set(directBatches.map((b) => b.id));
    const batchNumberById = new Map(directBatches.map((b) => [b.id, b.batchNumber] as const));

    if (lots.length === 0 && directBatches.length === 0) {
      res.json({ suggestions: [], affectedLotCount: 0, affectedBatchCount: 0, note });
      return;
    }

    const lotIds = lots.map((l) => l.id);
    const lotNumberById = new Map(lots.map((l) => [l.id, l.lotNumber] as const));
    // Batches reached indirectly via an affected lot's source batch, plus the
    // batches attached directly — both feed the manifest lookup.
    const lotBatchIds = lots.map((l) => l.sourceBatchId).filter((v): v is number => v != null);
    const batchIds = Array.from(new Set([...lotBatchIds, ...directBatchIds]));
    // METRC package tags of the affected lots — used to match manifest line items
    // precisely (so we don't credit a store that got a *different* lot of the
    // same batch).
    const affectedPkgIds = new Set(
      lots.map((l) => l.metrcPackageId).filter((v): v is string => !!v),
    );
    // Batches whose affected lot has NO metrc package id: we can't match line
    // items, so any manifest recipient for that batch is a fallback candidate
    // (surfaced with an unverified quantity).
    const batchesWithoutPkgMatch = new Set(
      lots
        .filter((l) => l.sourceBatchId != null && !l.metrcPackageId)
        .map((l) => l.sourceBatchId as number),
    );

    type Agg = {
      storeName: string;
      storeLicenseNumber: string | null;
      unitsKnown: number;
      hadUnknownQty: boolean;
      sources: Set<string>;
      lotNumbers: Set<string>;
    };
    const byStore = new Map<string, Agg>();
    const keyFor = (name: string, license: string | null) =>
      license && license.trim() ? `L:${license.trim().toUpperCase()}` : `N:${name.trim().toLowerCase()}`;
    const bump = (name: string, license: string | null): Agg => {
      const k = keyFor(name, license);
      let a = byStore.get(k);
      if (!a) {
        a = {
          storeName: name.trim(),
          storeLicenseNumber: license?.trim() || null,
          unitsKnown: 0,
          hadUnknownQty: false,
          sources: new Set(),
          lotNumbers: new Set(),
        };
        byStore.set(k, a);
      }
      if (!a.storeLicenseNumber && license?.trim()) a.storeLicenseNumber = license.trim();
      return a;
    };

    // ── Source A: lot-level shipment records (lot-precise) ──
    const shipRows = lotIds.length > 0
      ? await db.select().from(shipmentsTable).where(inArray(shipmentsTable.lotId, lotIds))
      : [];
    for (const s of shipRows) {
      if (!s.customerName) continue;
      const a = bump(s.customerName, s.customerLicense ?? null);
      const qty = typeof s.shippedQuantity === "number" ? s.shippedQuantity : Number(s.shippedQuantity);
      if (Number.isFinite(qty)) a.unitsKnown += qty; else a.hadUnknownQty = true;
      const ln = lotNumberById.get(s.lotId);
      if (ln) a.lotNumbers.add(ln);
      a.sources.add(
        `Shipment${s.manifestNumber ? ` ${s.manifestNumber}` : ""}${s.shippedDate ? ` · ${s.shippedDate}` : ""}`,
      );
    }

    // ── Source B: batch manifests (recipient + line items) ──
    if (batchIds.length > 0) {
      const manifests = await db
        .select()
        .from(batchManifestsTable)
        .where(inArray(batchManifestsTable.batchId, batchIds));
      const usable = manifests.filter(
        (m) => m.recipientName && !["voided", "rejected"].includes((m.status ?? "").toLowerCase()),
      );
      const manifestIds = usable.map((m) => m.id);
      const pkgsByManifest = new Map<number, { packageLabel: string; quantity: string | null }[]>();
      if (manifestIds.length > 0) {
        const pkgs = await db
          .select()
          .from(batchManifestPackagesTable)
          .where(inArray(batchManifestPackagesTable.manifestId, manifestIds));
        for (const p of pkgs) {
          const arr = pkgsByManifest.get(p.manifestId) ?? [];
          arr.push({ packageLabel: p.packageLabel, quantity: (p.quantity as string | null) ?? null });
          pkgsByManifest.set(p.manifestId, arr);
        }
      }
      for (const m of usable) {
        const pkgs = pkgsByManifest.get(m.id) ?? [];
        const numLabel = m.metrcManifestNumber ? ` ${m.metrcManifestNumber}` : ` #${m.id}`;
        const statusLabel = m.status ? ` · ${m.status}` : "";

        // A directly-attached batch is recalled in full → every package on its
        // manifest counts toward that store.
        if (m.batchId != null && directBatchIds.has(m.batchId)) {
          const a = bump(m.recipientName as string, m.recipientLicenseNumber ?? null);
          if (pkgs.length > 0) {
            for (const p of pkgs) {
              const q = p.quantity == null ? NaN : Number(p.quantity);
              if (Number.isFinite(q)) a.unitsKnown += q; else a.hadUnknownQty = true;
            }
          } else {
            a.hadUnknownQty = true;
          }
          const bn = batchNumberById.get(m.batchId);
          if (bn) a.lotNumbers.add(bn);
          a.sources.add(`Manifest${numLabel}${statusLabel}`);
          continue;
        }

        // Otherwise the batch was reached via an affected lot's source batch —
        // match line items so we don't credit a store that got a *different* lot.
        const matched = pkgs.filter((p) => affectedPkgIds.has(p.packageLabel));
        const fallback = m.batchId != null && batchesWithoutPkgMatch.has(m.batchId);
        if (matched.length === 0 && !fallback) continue;
        const a = bump(m.recipientName as string, m.recipientLicenseNumber ?? null);
        if (matched.length > 0) {
          for (const p of matched) {
            const q = p.quantity == null ? NaN : Number(p.quantity);
            if (Number.isFinite(q)) a.unitsKnown += q; else a.hadUnknownQty = true;
          }
        } else {
          // Fallback: recipient is known but the per-lot quantity can't be matched.
          a.hadUnknownQty = true;
        }
        a.sources.add(`Manifest${numLabel}${statusLabel}`);
      }
    }

    // ── Mark suggestions already present as Response Actions ──
    const existing = await db
      .select()
      .from(faResponseActionsTable)
      .where(eq(faResponseActionsTable.fieldActionId, faId));
    const existingKeys = new Set(
      existing.map((r) => keyFor(r.storeName ?? "", r.storeLicenseNumber ?? null)),
    );

    const suggestions = Array.from(byStore.entries()).map(([k, a]) => ({
      storeName: a.storeName,
      storeLicenseNumber: a.storeLicenseNumber,
      unitsAffected: a.unitsKnown > 0 ? Math.round(a.unitsKnown) : null,
      hasUnverifiedQty: a.hadUnknownQty,
      sources: Array.from(a.sources),
      lotNumbers: Array.from(a.lotNumbers),
      alreadyAdded: existingKeys.has(k),
    }));
    // Not-yet-added first, then alphabetical by store.
    suggestions.sort(
      (x, y) => Number(x.alreadyAdded) - Number(y.alreadyAdded) || x.storeName.localeCompare(y.storeName),
    );

    res.json({ suggestions, affectedLotCount: lots.length, affectedBatchCount: directBatches.length, note });
  } catch (err) {
    req.log.error({ err }, "Failed to build store suggestions");
    res.status(500).json({ error: "Failed to build store suggestions" });
  }
});

// ── Response Actions (per-store tracking, Session 13) ──────────────────────

async function writeResponseActionAudit(opts: {
  rowId: number;
  operation: string;
  changedByName?: string | null;
  changedById?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "fa_response_actions",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* never break the main flow */ }
}

router.get("/field-actions/:id/response-actions", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const rows = await db
      .select()
      .from(faResponseActionsTable)
      .where(eq(faResponseActionsTable.fieldActionId, faId))
      .orderBy(faResponseActionsTable.createdAt);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list FA response actions");
    res.status(500).json({ error: "Failed to list response actions" });
  }
});

router.post("/field-actions/:id/response-actions", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const [fa] = await db.select().from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
    if (!fa) { res.status(404).json({ error: "Field action not found" }); return; }
    const body = req.body as Record<string, unknown>;
    if (typeof body.storeName !== "string" || body.storeName.trim() === "") {
      res.status(400).json({ error: "storeName is required" }); return;
    }
    const [row] = await db.insert(faResponseActionsTable).values({
      ...body,
      fieldActionId: faId,
    } as typeof faResponseActionsTable.$inferInsert).returning();
    void writeResponseActionAudit({
      rowId: row.id,
      operation: "INSERT",
      changedByName: (body.createdByName as string) ?? null,
      changedById: (body.createdByUserId as number) ?? null,
      afterState: row as unknown as Record<string, unknown>,
    });
    await maybeAdvanceToDueDiligence(faId);
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create FA response action");
    res.status(500).json({ error: "Failed to create response action" });
  }
});

router.patch("/field-actions/:id/response-actions/:raId", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const raId = parseInt(req.params.raId);
    const [before] = await db
      .select()
      .from(faResponseActionsTable)
      .where(and(eq(faResponseActionsTable.id, raId), eq(faResponseActionsTable.fieldActionId, faId)));
    if (!before) { res.status(404).json({ error: "Response action not found" }); return; }
    const body = { ...(req.body as Record<string, unknown>) };
    // Never let the client move a row across FAs.
    delete body.fieldActionId;
    const [row] = await db
      .update(faResponseActionsTable)
      .set({ ...body, updatedAt: new Date() } as Partial<typeof faResponseActionsTable.$inferInsert>)
      .where(eq(faResponseActionsTable.id, raId))
      .returning();
    void writeResponseActionAudit({
      rowId: raId,
      operation: "UPDATE",
      changedByName: (body.updatedByName as string) ?? null,
      changedById: (body.updatedByUserId as number) ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: row as unknown as Record<string, unknown>,
    });
    await maybeAdvanceToDueDiligence(faId);
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update FA response action");
    res.status(500).json({ error: "Failed to update response action" });
  }
});

router.delete("/field-actions/:id/response-actions/:raId", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const raId = parseInt(req.params.raId);
    const performedByName = (req.body as { performedByName?: string } | undefined)?.performedByName ?? null;
    const performedBy = (req.body as { performedBy?: number } | undefined)?.performedBy ?? null;
    // Session 55 — a Closed field action is read-only (21 CFR Part 11). The
    // client already hides this delete button when faClosed; this is the
    // matching server-side guard so the API can't be used to delete a
    // response action out from under a finalized FA record.
    {
      const [parent] = await db.select({ status: fieldActionsTable.status }).from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
      if (parent?.status === "Closed") { res.status(409).json({ error: "Cannot delete a response action on a Closed field action (21 CFR Part 11)." }); return; }
    }
    const [before] = await db
      .select()
      .from(faResponseActionsTable)
      .where(and(eq(faResponseActionsTable.id, raId), eq(faResponseActionsTable.fieldActionId, faId)));
    if (!before) { res.status(404).json({ error: "Response action not found" }); return; }
    await db.delete(faResponseActionsTable).where(eq(faResponseActionsTable.id, raId));
    void writeResponseActionAudit({
      rowId: raId,
      operation: "DELETE",
      changedByName: performedByName,
      changedById: performedBy,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: null,
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to delete FA response action");
    res.status(500).json({ error: "Failed to delete response action" });
  }
});

router.delete("/field-actions/:id/lots/:lotId", async (req, res) => {
  try {
    const faId = parseInt(req.params.id);
    const lotId = parseInt(req.params.lotId);
    const performedByName = (req.body as { performedByName?: string } | undefined)?.performedByName ?? null;
    const performedBy = (req.body as { performedBy?: number } | undefined)?.performedBy ?? null;
    // Session 55 — a Closed field action is read-only (21 CFR Part 11). Mirror
    // the client gate (delete hidden when faClosed) on the server so a lot
    // can't be detached from a finalized FA via the API.
    {
      const [parent] = await db.select({ status: fieldActionsTable.status }).from(fieldActionsTable).where(eq(fieldActionsTable.id, faId));
      if (parent?.status === "Closed") { res.status(409).json({ error: "Cannot detach a lot from a Closed field action (21 CFR Part 11)." }); return; }
    }
    const [link] = await db.select().from(fieldActionLotsTable)
      .where(and(eq(fieldActionLotsTable.fieldActionId, faId), eq(fieldActionLotsTable.lotId, lotId)));
    if (!link) { res.status(404).json({ error: "Link not found" }); return; }
    await db.delete(fieldActionLotsTable)
      .where(and(eq(fieldActionLotsTable.fieldActionId, faId), eq(fieldActionLotsTable.lotId, lotId)));
    void writeAuditLog({
      rowId: faId,
      operation: "DETACH_LOT",
      changedByName: performedByName,
      changedById: performedBy,
      beforeState: { lotId, wasQuarantinedAt: link.quarantinedAt },
      afterState: null,
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to detach lot from FA");
    res.status(500).json({ error: "Failed to detach lot" });
  }
});

export default router;
