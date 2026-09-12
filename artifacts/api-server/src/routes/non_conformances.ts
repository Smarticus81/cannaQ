import { Router } from "express";
import { db } from "@workspace/db";
import { nonConformancesTable, correctiveActionsTable, auditLogTable, capasTable, attachmentsTable, ncCorrectionsTable, complaintsTable, fieldActionsTable, incomingInspectionsTable, batchRecordsTable, lotsTable } from "@workspace/db";
import { and, eq, like, ne, or, sql } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { nextCapaNumber, nextFaNumber, deriveCapaRisk } from "../lib/qualityEvents";
import { deriveNcStatus, ncStatusBlockers, loadNcStatusAggregates, EMPTY_NC_AGG } from "../lib/ncStatus";

// Session 60 — resolve which supplier an NC should count against.
//
// The lot is preferred over the source inspection: a lot names ONE receipt of one
// material, whereas an inspection can carry several lines from the same supplier.
// In practice both resolve to the same supplier; the lot is simply the more
// specific statement of it.
//
// Returns null when neither route resolves — a process NC, or an NC with no
// receiving lineage at all, correctly counts against nobody.
async function deriveSupplierId(opts: {
  affectedLotId?: number;
  sourceInspectionId?: number;
}): Promise<number | null> {
  try {
    if (opts.affectedLotId != null) {
      const [lot] = await db.select({ inspectionId: lotsTable.sourceInspectionId })
        .from(lotsTable).where(eq(lotsTable.id, opts.affectedLotId)).limit(1);
      if (lot?.inspectionId != null) {
        const [insp] = await db.select({ supplierId: incomingInspectionsTable.supplierId })
          .from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, lot.inspectionId)).limit(1);
        if (insp?.supplierId != null) return insp.supplierId;
      }
    }
    if (opts.sourceInspectionId != null) {
      const [insp] = await db.select({ supplierId: incomingInspectionsTable.supplierId })
        .from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, opts.sourceInspectionId)).limit(1);
      if (insp?.supplierId != null) return insp.supplierId;
    }
  } catch {
    // Never block creating a quality record because the lineage lookup failed.
    // A missing supplier link is recoverable; a lost NC is not.
  }
  return null;
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
      tableName: "non_conformances",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

// Session 52.1.1 — a cancelled NC is read-only. Sub-resource mutations
// (corrections, mgmt-ack, corrective actions) and field edits are rejected
// server-side, not just hidden in the UI. Returns true if the NC is cancelled.
async function ncIsCancelled(id: number): Promise<boolean> {
  const [row] = await db
    .select({ cancelledAt: nonConformancesTable.cancelledAt })
    .from(nonConformancesTable)
    .where(eq(nonConformancesTable.id, id));
  return !!row?.cancelledAt;
}

// NC status ladder (Session 11 vocabulary; NC-8 made it event-derived):
// Open → In Progress → [Major/Critical: Awaiting Mgt Acknowledgement] →
// Under Review → Closed. Computed in lib/ncStatus on read, not stored.
// Roles permitted to approve a Use As Is disposition / close an NC.
const SUPERVISOR_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
// Session 56 — management acknowledgement is a management-level sign-off; a
// Supervisor is not "management" for this gate. Manager / Quality / Admin only.
const NC_MGMT_ACK_ROLES = new Set(["Manager", "Quality", "Admin"]);

const router = Router();

// Generates the next NC number for the current year. Uses MAX of the parsed
// sequence portion of existing nc_number values within this year, NOT count(*).
// This guarantees:
//   • No reuse — deleting an NC never returns its number to the pool (Part 11).
//   • Year-scoped — each calendar year restarts at 0001.
//   • Monotonic — numbers only ever increase within a year.
// Race-condition note: this still has a small TOCTOU window between SELECT
// and INSERT. The unique constraint on nc_number provides a hard backstop;
// a Postgres sequence per year is the long-term fix.
async function generateNcNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `NC-${year}-`;
  const rows = await db
    .select({ ncNumber: nonConformancesTable.ncNumber })
    .from(nonConformancesTable)
    .where(like(nonConformancesTable.ncNumber, `${prefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = r.ncNumber.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

router.get("/non-conformances", async (req, res) => {
  try {
    let rows = await db.select().from(nonConformancesTable).orderBy(nonConformancesTable.createdAt);
    const { status, severity } = req.query;
    // Session 52 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled NCs (the Cancelled view). Cancel is the no-hard-delete pattern.
    const cancelled = req.query.cancelled === "true";
    rows = cancelled ? rows.filter((r) => r.cancelledAt) : rows.filter((r) => !r.cancelledAt);
    if (severity) rows = rows.filter((r) => r.severity === severity);
    // NC-8 — status is derived on read (event-driven), not the stored column.
    // Roll up correction + CAPA aggregates for the listed NCs in two grouped
    // queries, compute each row's status, and filter on the derived value so
    // ?status=… and the client tiles/queues stay consistent with the ladder.
    const aggMap = await loadNcStatusAggregates(rows.map((r) => r.id));
    let derived = rows.map((r) => ({ ...r, status: deriveNcStatus(r, aggMap.get(r.id) ?? EMPTY_NC_AGG) }));
    if (status) derived = derived.filter((r) => r.status === status);
    res.json(derived.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list non-conformances");
    res.status(500).json({ error: "Failed to list non-conformances" });
  }
});

// Session 32 — explicit allowlist for NC create. Previously the handler
// spread the entire client body into the insert, which made the route fragile
// to (a) accidental client-side fields that don't exist on the table and
// (b) schema drift between sessions. Mirroring the CAPA_CREATE_ALLOWED
// pattern from capas.ts so failures are deterministic and the error returned
// to the client surfaces the actual cause instead of a bare 500.
const NC_CREATE_ALLOWED = new Set([
  "title",
  "description",
  "severity",
  "source",
  "status",
  "batchId",
  "supplierId",
  // Session 97 (Slice 4) — specific source-record FKs (inspection / complaint).
  "sourceInspectionId",
  "sourceComplaintId",
  "disposition",
  "rootCause",
  "rootCauses",
  // Session 60 — what the NC is ABOUT (Product | Process), as found and as
  // confirmed by the investigation. See the schema for why there are two.
  "ncTypeAsFound",
  "ncTypeConfirmed",
  // Session 60 — WHAT is affected, as real references so metrics and supplier
  // scoring can read them.
  "affectedInventoryItemId",
  "affectedLotId",
  "affectedDocumentId",
  "productType",
  "productName",
  "lotNumber",
  "department",
  "reportedByName",
  // Session 54 — id of the reporting app user. "Reported By" on an NC is always
  // an internal user (decision B), auto-stamped with the logger's id on create.
  "reportedByUserId",
  // Session 101 — NC Owner (accountable person), distinct from Reported By.
  "ownerUserId",
  "ownerName",
  // Session 48 — new NC capture fields. identifiedAt is the date the issue
  // was spotted (distinct from createdAt). severityRationale explains the
  // severity classification. skipCapaRationale is captured up-front when the
  // operator already knows the NC won't escalate to CAPA; otherwise it's set
  // later via PATCH and enforced at closure.
  "identifiedAt",
  "severityRationale",
  "skipCapaRationale",
  // Session 49 — destruction record link. Can be set at NC creation (rare) or,
  // more commonly, via PATCH from the destruction panel on the NC detail page.
  "destructionRecordId",
]);

router.post("/non-conformances", async (req, res) => {
  try {
    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (NC_CREATE_ALLOWED.has(k)) safe[k] = v;
    }

    // Required-field guard with a clear message (the dialog enforces these
    // client-side too, but Tier 1 #1 had the route returning a bare 500 with
    // no detail — operators couldn't tell whether a field had been missed or
    // the database had rejected the row).
    const missing: string[] = [];
    for (const k of ["title", "description", "severity", "source"]) {
      if (typeof safe[k] !== "string" || !((safe[k] as string).trim())) missing.push(k);
    }
    if (missing.length > 0) {
      res.status(400).json({ error: `Required field${missing.length > 1 ? "s" : ""} missing: ${missing.join(", ")}.` });
      return;
    }
    // status has a DB default of "Open" but we set it explicitly so a future
    // schema migration that drops the default doesn't silently break this route.
    if (typeof safe.status !== "string" || !((safe.status as string).trim())) {
      safe.status = "Open";
    }

    // Session 97 (Slice 4) — normalize the record FKs to integers (or drop them),
    // so a string id from the client can never hit an integer column.
    for (const k of ["sourceInspectionId", "sourceComplaintId", "batchId", "supplierId",
                     "affectedInventoryItemId", "affectedLotId", "affectedDocumentId"]) {
      if (safe[k] == null) continue;
      const n = typeof safe[k] === "number" ? (safe[k] as number) : Number(safe[k]);
      if (Number.isFinite(n)) safe[k] = n;
      else delete safe[k];
    }

    // Session 60 — attach the supplier so the NC actually counts against them.
    //
    // getBatchRiskInputs() in routes/suppliers.ts has always fed open NCs into the
    // supplier risk score and tier via non_conformances.supplier_id, and the column
    // and this allowlist have always accepted it — but nothing ever SET it, so no
    // NC has ever moved a supplier's score. Derive it rather than asking the
    // operator to restate something the linked records already know:
    //   1. the affected lot's receiving inspection, then
    //   2. the source inspection, when Source = Incoming Inspection.
    // An explicit supplierId from the client always wins; this only fills a blank.
    if (safe.supplierId == null) {
      const derived = await deriveSupplierId({
        affectedLotId: safe.affectedLotId as number | undefined,
        sourceInspectionId: safe.sourceInspectionId as number | undefined,
      });
      if (derived != null) safe.supplierId = derived;
    }

    const ncNumber = await generateNcNumber();
    const [nc] = await db
      .insert(nonConformancesTable)
      .values({ ...safe, ncNumber } as typeof nonConformancesTable.$inferInsert)
      .returning();
    void writeAuditLog({
      rowId: nc.id,
      operation: "INSERT",
      changedByName: (safe.reportedByName as string) ?? null,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.status(201).json(nc);
  } catch (err) {
    // Surface the underlying error message so the operator (and future Claude)
    // can see what actually failed. Tier 1 #1's whole point was "smoke-test
    // the new NC POST/mutation and surface the server error" — that requires
    // the route to actually pass the error along rather than hiding it.
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to create non-conformance");
    res.status(500).json({ error: `Failed to create non-conformance: ${msg}` });
  }
});

router.get("/non-conformances/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [nc] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!nc) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    const linkedCapas = await db
      .select({
        id: capasTable.id,
        capaNumber: capasTable.capaNumber,
        title: capasTable.title,
        status: capasTable.status,
        type: capasTable.type,
        createdAt: capasTable.createdAt,
        closedAt: capasTable.closedAt,
      })
      .from(capasTable)
      .where(eq(capasTable.sourceNcId, id));
    // Session 75 — two-way visibility: the complaints that point at this NC, and
    // any field actions escalated from it.
    const linkedComplaints = await db
      .select({
        id: complaintsTable.id,
        complaintNumber: complaintsTable.complaintNumber,
        complaintType: complaintsTable.complaintType,
        severity: complaintsTable.severity,
        status: complaintsTable.status,
        receivedDate: complaintsTable.receivedDate,
      })
      .from(complaintsTable)
      .where(eq(complaintsTable.ncId, id));
    const escalatedFieldActions = await db
      .select({
        id: fieldActionsTable.id,
        faNumber: fieldActionsTable.faNumber,
        actionType: fieldActionsTable.actionType,
        status: fieldActionsTable.status,
        linkedCapaId: fieldActionsTable.linkedCapaId,
      })
      .from(fieldActionsTable)
      .where(eq(fieldActionsTable.sourceNcId, id));
    // Session 97 (cross-linking follow-up) — resolve the stored source/batch FKs
    // into readable summaries so the detail page can show the actual linked record
    // (mirrors the CAPA GET's sourceNc / sourceComplaint). Each is null when unset.
    let sourceInspection = null;
    let sourceComplaint = null;
    let linkedBatch = null;
    if (nc.sourceInspectionId) {
      const [i] = await db
        .select({ id: incomingInspectionsTable.id, inspectionNumber: incomingInspectionsTable.inspectionNumber, supplierName: incomingInspectionsTable.supplierName, poManifestNumber: incomingInspectionsTable.poManifestNumber, result: incomingInspectionsTable.result })
        .from(incomingInspectionsTable)
        .where(eq(incomingInspectionsTable.id, nc.sourceInspectionId));
      sourceInspection = i ?? null;
    }
    if (nc.sourceComplaintId) {
      const [c] = await db
        .select({ id: complaintsTable.id, complaintNumber: complaintsTable.complaintNumber, complaintType: complaintsTable.complaintType, severity: complaintsTable.severity, status: complaintsTable.status })
        .from(complaintsTable)
        .where(eq(complaintsTable.id, nc.sourceComplaintId));
      sourceComplaint = c ?? null;
    }
    if (nc.batchId) {
      const [b] = await db
        .select({ id: batchRecordsTable.id, batchNumber: batchRecordsTable.batchNumber, productName: batchRecordsTable.productName, status: batchRecordsTable.status })
        .from(batchRecordsTable)
        .where(eq(batchRecordsTable.id, nc.batchId));
      linkedBatch = b ?? null;
    }
    // NC-8 — derive the status (and the "what's still missing" list for the
    // read-only stepper) from the record's real state, same as the list.
    const agg = (await loadNcStatusAggregates([id])).get(id) ?? EMPTY_NC_AGG;
    const derivedStatus = deriveNcStatus(nc, agg);
    const statusBlockers = ncStatusBlockers(nc, agg);
    res.json({ ...nc, status: derivedStatus, statusBlockers, linkedCapas, linkedComplaints, escalatedFieldActions, sourceInspection, sourceComplaint, linkedBatch });
  } catch (err) {
    req.log.error({ err }, "Failed to get non-conformance");
    res.status(500).json({ error: "Failed to get non-conformance" });
  }
});

// POST /non-conformances/:id/promote-to-capa
// Spawns a new CAPA pre-filled from this NC. Copies any Active supplementary
// attachments to the new CAPA (re-references same objectPath; new attachment
// rows tagged with description "Copied from NC-…"). Returns the new CAPA.
router.post("/non-conformances/:id/promote-to-capa", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const APPROVERS = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
    if (!APPROVERS.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can promote an NC to a CAPA." });
      return;
    }

    const { type, title, description, rootCauseAnalysis } = (req.body ?? {}) as {
      type?: string; title?: string; description?: string; rootCauseAnalysis?: string;
    };

    const [nc] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!nc) { res.status(404).json({ error: "Non-conformance not found" }); return; }

    // Session 61 — classify the CAPA's risk from the NC's severity, the way every
    // other escalation already does. deriveCapaRisk was imported into this file
    // and used on the NC -> Field Action path below, and by complaints.ts and
    // field_actions.ts, but this route — the plain NC -> CAPA promotion, and the
    // one operators actually take — never called it. CAPAs raised this way landed
    // with no risk classification at all.
    //
    // Derived at creation, so existing CAPAs are unaffected and need setting by
    // hand; there is no backfill here on purpose, since a risk level invented
    // after the fact is not a classification anyone made.
    const { riskLevel, riskRationale } = deriveCapaRisk(nc.severity, `${nc.ncNumber} (promoted to a CAPA)`);

    const result = await db.transaction(async (tx) => {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)` }).from(capasTable);
      const seq = (Number(count) || 0) + 1;
      const year = new Date().getFullYear().toString().slice(-2);
      const capaNumber = `CAPA-${year}-${String(seq).padStart(4, "0")}`;

      const [capa] = await tx.insert(capasTable).values({
        capaNumber,
        type: type ?? "Corrective",
        title: (title ?? `CAPA for ${nc.ncNumber}: ${nc.title}`).slice(0, 250),
        description: description ?? nc.description,
        sourceNcId: nc.id,
        rootCauseAnalysis: rootCauseAnalysis ?? nc.rootCause ?? null,
        status: "Open",
        riskLevel,
        riskRationale,
        // Session 63 — carry the product context across the promotion.
        //
        // CreateCAPADialog collects exactly these four fields when a CAPA is
        // raised by hand, and the NC -> Field Action path below already copies
        // productName / lotNumber onto the CAPA it spawns. This route — the
        // ordinary NC -> CAPA promotion — copied none of them, so a CAPA born
        // from an NC that named a product and a lot arrived with that context
        // blank and someone had to retype it off the source NC.
        //
        // Nulled rather than omitted when the NC has no value, so a process CAPA
        // stays genuinely empty instead of inheriting a stale string.
        productType: (nc as { productType?: string | null }).productType ?? null,
        productName: nc.productName ?? null,
        lotNumber: nc.lotNumber ?? null,
        department: (nc as { department?: string | null }).department ?? null,
        openedById: actor.id,
        openedByName: actor.fullName,
        // Session 61 — record the ORIGINATOR, not just who opened the row.
        //
        // Gate 0 enforces Part 11 segregation with
        //   if (capa.originatorId && actor.id === capa.originatorId) -> 409
        // so a null originator does not fail that check, it SKIPS it. This route
        // never set the field, which meant a CAPA promoted from an NC could have
        // its acceptance gate signed by the very person who raised it — the one
        // thing Gate 0 exists to prevent. The NC -> Field Action path a hundred
        // lines below always set it; this path was simply missed.
        originatorId: actor.id,
      }).returning();

      // Copy active supplementary attachments from the NC.
      const ncAttachments = await tx
        .select()
        .from(attachmentsTable)
        .where(and(
          eq(attachmentsTable.parentTable, "non_conformances"),
          eq(attachmentsTable.parentId, nc.id),
          eq(attachmentsTable.status, "Active"),
          eq(attachmentsTable.kind, "supplementary"),
        ));
      let copiedAttachments = 0;
      for (const a of ncAttachments) {
        await tx.insert(attachmentsTable).values({
          parentTable: "capas",
          parentId: capa.id,
          kind: "supplementary",
          objectPath: a.objectPath,
          fileName: a.fileName,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          description: `Copied from ${nc.ncNumber}${a.description ? `: ${a.description}` : ""}`,
          status: "Active",
          uploadedByUserId: actor.id,
          uploadedByName: actor.fullName,
        });
        copiedAttachments++;
      }

      // Audit on the CAPA side
      await tx.insert(auditLogTable).values({
        tableName: "capas",
        rowId: capa.id,
        operation: "INSERT",
        changedBy: actor.id,
        changedByName: actor.fullName,
        afterState: {
          capaNumber: capa.capaNumber,
          sourceNcId: nc.id,
          sourceNcNumber: nc.ncNumber,
          title: capa.title,
          copiedAttachments,
        } as never,
      });
      // Audit on the NC side
      await tx.insert(auditLogTable).values({
        tableName: "non_conformances",
        rowId: nc.id,
        operation: "PROMOTE_TO_CAPA",
        changedBy: actor.id,
        changedByName: actor.fullName,
        afterState: { capaId: capa.id, capaNumber: capa.capaNumber, copiedAttachments } as never,
      });

      return { capa, copiedAttachments };
    });

    res.status(201).json(result.capa);
  } catch (err) {
    req.log.error({ err }, "Failed to promote NC to CAPA");
    res.status(500).json({ error: "Failed to open CAPA from this NC." });
  }
});

// POST /non-conformances/:id/promote-to-field-action
// Session 75 — when an NC determines a Field Action is required, escalate it.
// BUSINESS RULE: a Field Action never exists without a CAPA behind it. So this
// one action creates BOTH — a CAPA pre-filled from the NC (its number assigned
// automatically) AND a Field Action linked to that CAPA — and binds the trio:
// NC → CAPA (capas.source_nc_id), NC → FA (field_actions.source_nc_id),
// FA → CAPA (field_actions.linked_capa_id). Returns { fieldAction, capa }.
// Off-spec / raw-fetch.
router.post("/non-conformances/:id/promote-to-field-action", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const APPROVERS = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
    if (!APPROVERS.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can escalate an NC to a Field Action." });
      return;
    }

    const [nc] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!nc) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    if (nc.cancelledAt) { res.status(409).json({ error: "This NC is cancelled. Re-open it first." }); return; }

    const body = (req.body ?? {}) as { actionType?: string; title?: string; initiationReason?: string };
    const actionType = typeof body.actionType === "string" && body.actionType.trim() ? body.actionType.trim() : "Stop Sale";

    const capaNumber = await nextCapaNumber();
    const faNumber = await nextFaNumber();
    const { riskLevel, riskRationale } = deriveCapaRisk(nc.severity, `${nc.ncNumber} (escalated to a Field Action)`);

    const result = await db.transaction(async (tx) => {
      const [capa] = await tx.insert(capasTable).values({
        capaNumber,
        type: "Corrective",
        title: `CAPA for ${nc.ncNumber}: ${nc.title}`.slice(0, 250),
        description: nc.description,
        sourceNcId: nc.id,
        rootCauseAnalysis: nc.rootCause ?? null,
        status: "Open",
        stage: "Initiation",
        riskLevel,
        riskRationale,
        productName: nc.productName ?? null,
        lotNumber: nc.lotNumber ?? null,
        openedById: actor.id,
        openedByName: actor.fullName,
        originatorId: actor.id,
      } as typeof capasTable.$inferInsert).returning();

      const [fa] = await tx.insert(fieldActionsTable).values({
        faNumber,
        actionType,
        status: "Initiated",
        title: (body.title ?? `Field Action for ${nc.ncNumber}: ${nc.title}`).slice(0, 250),
        initiationReason: body.initiationReason ?? `[From ${nc.ncNumber}] ${nc.description}`,
        sourceNcId: nc.id,
        linkedCapaId: capa.id,
        productType: (nc as { productType?: string | null }).productType ?? null,
        productName: nc.productName ?? null,
        lotNumber: nc.lotNumber ?? null,
        department: (nc as { department?: string | null }).department ?? null,
      } as typeof fieldActionsTable.$inferInsert).returning();

      await tx.insert(auditLogTable).values({
        tableName: "capas", rowId: capa.id, operation: "INSERT",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { capaNumber: capa.capaNumber, sourceNcId: nc.id, autoCreatedForFieldAction: fa.faNumber } as never,
      });
      await tx.insert(auditLogTable).values({
        tableName: "field_actions", rowId: fa.id, operation: "INSERT",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { faNumber: fa.faNumber, sourceNcId: nc.id, linkedCapaId: capa.id } as never,
      });
      await tx.insert(auditLogTable).values({
        tableName: "non_conformances", rowId: nc.id, operation: "PROMOTE_TO_FIELD_ACTION",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { faId: fa.id, faNumber: fa.faNumber, capaId: capa.id, capaNumber: capa.capaNumber } as never,
      });

      return { fa, capa };
    });

    res.status(201).json({ fieldAction: result.fa, capa: result.capa });
  } catch (err) {
    req.log.error({ err }, "Failed to escalate NC to Field Action");
    res.status(500).json({ error: "Failed to escalate this NC to a Field Action." });
  }
});

router.patch("/non-conformances/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!before) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    // Session 52.1.1 — a cancelled NC is read-only (Re-open via /uncancel first).
    if (before.cancelledAt) {
      res.status(409).json({ error: "This NC is cancelled and read-only. Re-open it first (Admin)." }); return;
    }
    if (before.status === "Closed") {
      const lockedFields = ["description", "rootCause", "disposition", "title", "severity", "source"] as const;
      const attempted = lockedFields.filter((f) => Object.prototype.hasOwnProperty.call(req.body ?? {}, f));
      if (attempted.length > 0) {
        res.status(409).json({
          error: `Cannot modify ${attempted.join(", ")} on a Closed non-conformance (21 CFR Part 11).`,
        });
        return;
      }
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // NC-8 — status is now event-derived on read (see lib/ncStatus). It is no
    // longer a manually-settable field, so any client-supplied `status` on a
    // field edit is ignored (stripped below). Closed is set only by
    // POST /approve; Cancelled only by POST /cancel.

    // NC-6 (2026-07-13) — changing severity is a Supervisor+ action: it drives the
    // CAPA + management-acknowledgement requirements at closure, so an operator
    // shouldn't silently up/down-grade it. Only the CHANGE is gated (an unchanged
    // value passes through untouched, e.g. when other fields are edited).
    if (typeof body.severity === "string" && body.severity !== before.severity) {
      const sevActor = await getOrProvisionCurrentUser(req);
      if (!sevActor) { res.status(401).json({ error: "Authentication required." }); return; }
      if (!SUPERVISOR_ROLES.has(sevActor.role)) {
        res.status(403).json({ error: `Changing NC severity requires Supervisor / Manager / Quality / Admin role. Your role is "${sevActor.role}".` });
        return;
      }
    }

    // Session 48.2 — the skip-CAPA closure gate originally lived here, but
    // the actual Close Non-Conformance flow uses POST /approve, not PATCH
    // with status=Closed. Gate moved to /approve where it actually fires.
    // This PATCH handler still accepts skipCapaRationale as a regular field
    // edit (operator can fill it in advance of closing).

    // Use As Is disposition requires Supervisor+ Part 11 sign-off whenever it
    // is freshly set (not already in place). approverInitials/Meaning must be
    // supplied in the body and the acting user must hold an approver role.
    const transitioningToUseAsIs =
      typeof body.disposition === "string" &&
      body.disposition === "Use As Is" &&
      before.disposition !== "Use As Is";
    let useAsIsApproval: { name: string; initials: string; meaning: string } | null = null;
    if (transitioningToUseAsIs) {
      const actor = await getOrProvisionCurrentUser(req);
      if (!actor) { res.status(401).json({ error: "Authentication required to approve Use As Is." }); return; }
      if (!SUPERVISOR_ROLES.has(actor.role)) {
        res.status(403).json({ error: `Use As Is disposition requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
        return;
      }
      const initials = String(body.approverInitials ?? "").trim().toUpperCase();
      const meaning = String(body.approverMeaning ?? "").trim();
      if (!initials || !meaning) {
        res.status(400).json({ error: "Use As Is disposition requires approverInitials and approverMeaning (Part 11)." });
        return;
      }
      if ((actor.initials ?? "").toUpperCase() !== initials) {
        res.status(400).json({ error: "Initials do not match the signed-in user." });
        return;
      }
      // Session 101 (#3) — a Use-As-Is release must carry a written rationale
      // justifying why the nonconforming product is acceptable to use/release.
      // Persisted via useAsIsRationale (flows through persistBody).
      const rationale = String(body.useAsIsRationale ?? "").trim();
      if (!rationale) {
        res.status(400).json({ error: "Use As Is disposition requires a rationale explaining why the nonconforming product is acceptable for use/release." });
        return;
      }
      useAsIsApproval = { name: actor.fullName, initials, meaning };
    }

    // Strip non-column body fields before update. The cancelled_* fields are
    // managed only by /cancel + /uncancel (Session 52) — never by a field edit.
    const {
      approverInitials: _ai, approverMeaning: _am,
      cancelledAt: _ca, cancelledReason: _cr, cancelledByName: _cbn,
      cancelledByInitials: _cbi, cancelledMeaning: _cm,
      // NC-8 — status is derived on read; never persist a client-supplied value.
      status: _st,
      ...persistBody
    } = body;
    const updatePayload: Record<string, unknown> = { ...persistBody, updatedAt: new Date() };
    if (useAsIsApproval) {
      updatePayload.useAsIsApproverName = useAsIsApproval.name;
      updatePayload.useAsIsApproverInitials = useAsIsApproval.initials;
      updatePayload.useAsIsApproverMeaning = useAsIsApproval.meaning;
      updatePayload.useAsIsApprovedAt = new Date();
    }

    const [nc] = await db.update(nonConformancesTable).set(updatePayload as never).where(eq(nonConformancesTable.id, id)).returning();
    if (!nc) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    // Session 100 — attribute the edit to the signed-in user so the audit log
    // records the real actor instead of falling back to "System" (Part 11).
    const auditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    void writeAuditLog({
      rowId: id,
      operation: useAsIsApproval ? "APPROVE_USE_AS_IS" : "UPDATE",
      changedById: auditActor?.id ?? null,
      changedByName: useAsIsApproval?.name ?? auditActor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to update non-conformance");
    res.status(500).json({ error: "Failed to update non-conformance" });
  }
});

router.post("/non-conformances/:id/approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signingMeaning, signatureMeaning, disposition } = req.body as {
      initials?: string; signingMeaning?: string; signatureMeaning?: string; disposition?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const [before] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!before) { res.status(404).json({ error: "Non-conformance not found" }); return; }

    // Session 56 — Part 11 role gate + segregation of duties on NC close.
    // Approving (closing) an NC is a controlled e-signature event. Until now the
    // route enforced only that *some* initials + meaning were supplied; any
    // authenticated user (e.g. the Operator who reported it) could close it.
    // The acting user must now (1) hold an approver role, (2) sign with initials
    // matching their own profile, and (3) — unless Admin — not approve an NC
    // they themselves reported.
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to approve a non-conformance." }); return; }
    if (!SUPERVISOR_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Closing a non-conformance requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." });
      return;
    }
    if (actor.role !== "Admin" && before.reportedByUserId && before.reportedByUserId === actor.id) {
      res.status(403).json({ error: "Segregation of duties: you cannot close a non-conformance you reported. A different approver must sign the closure." });
      return;
    }

    // Session 48.3 — all immediate corrections must be Completed before an
    // NC can close. Applies to every severity: if the operator recorded
    // containment tasks (nc_corrections), every one must be marked done.
    // Otherwise the NC closes with open work attached, which fails ISO
    // 13485 §8.3 (control of nonconforming product) and operator-side QA
    // review. Issue surfaced by Jonathan during Session 48 testing.
    const pendingCorrections = await db
      .select({ id: ncCorrectionsTable.id, description: ncCorrectionsTable.description })
      .from(ncCorrectionsTable)
      .where(and(eq(ncCorrectionsTable.ncId, id), eq(ncCorrectionsTable.completed, false)));
    if (pendingCorrections.length > 0) {
      const n = pendingCorrections.length;
      res.status(409).json({
        error: `Cannot close: ${n} correction${n === 1 ? "" : "s"} still pending. Mark every recorded correction as Completed before closing the NC.`,
      });
      return;
    }

    // Severity-gated close: Major / Critical NCs must have management
    // acknowledgement on file AND at least one CAPA opened. This enforces the
    // QMS rule "no high-impact NC may be closed without management buy-in and a
    // documented preventive action plan." Server-side check is the source of
    // truth even if the UI is bypassed.
    const sev = (before.severity ?? "").toLowerCase();
    const requiresMgmtCapa = sev === "major" || sev === "critical";
    if (requiresMgmtCapa) {
      if (!before.mgmtAcknowledgedAt) {
        res.status(409).json({ error: "Major/Critical NCs require management acknowledgement before close." });
        return;
      }
      // Session 48.2 — skip_capa_rationale is the escape hatch for the
      // CAPA requirement. Per Jonathan's design: Major/Critical NCs
      // typically escalate to CAPA, but if the operator can justify why
      // no CAPA is being opened (immediate corrections fully address
      // the issue, no preventive action warranted), that rationale
      // satisfies the gate. Mgmt acknowledgement above is NOT escapable
      // by the rationale — it's a separate compliance requirement.
      const skipRationale = (before.skipCapaRationale ?? "").trim();
      if (!skipRationale) {
        const [{ count: capaCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(capasTable)
          .where(eq(capasTable.sourceNcId, id));
        if (Number(capaCount) === 0) {
          res.status(409).json({
            error: "Major/Critical NCs require either a linked CAPA OR a Skip-CAPA Rationale before close. Promote this NC to CAPA, or record why no CAPA is being opened on the NC detail page.",
          });
          return;
        }
      }
    }
    const [nc] = await db.update(nonConformancesTable).set({
      status: "Closed",
      disposition,
      // Session 56 — record the authenticated signer, not a client-supplied id.
      approvedBy: actor.id,
      approvalInitials: initials,
      approvalName: meaning,
      approvalDate: new Date(),
      closedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(nonConformancesTable.id, id)).returning();
    if (!nc) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    void writeAuditLog({
      rowId: id,
      operation: "APPROVE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to approve non-conformance");
    res.status(500).json({ error: "Failed to approve non-conformance" });
  }
});

router.get("/non-conformances/:id/corrective-actions", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actions = await db.select().from(correctiveActionsTable).where(eq(correctiveActionsTable.ncId, id)).orderBy(correctiveActionsTable.createdAt);
    res.json(actions);
  } catch (err) {
    req.log.error({ err }, "Failed to list corrective actions");
    res.status(500).json({ error: "Failed to list corrective actions" });
  }
});

router.post("/non-conformances/:id/corrective-actions", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (await ncIsCancelled(id)) { res.status(409).json({ error: "This NC is cancelled and read-only. Re-open it first (Admin)." }); return; }
    const [action] = await db.insert(correctiveActionsTable).values({ ...req.body, ncId: id }).returning();
    res.status(201).json(action);
  } catch (err) {
    req.log.error({ err }, "Failed to create corrective action");
    res.status(500).json({ error: "Failed to create corrective action" });
  }
});

// ── NC Corrections (containment actions, distinct from CAPA) ─────────────────

router.get("/non-conformances/:id/corrections", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(ncCorrectionsTable).where(eq(ncCorrectionsTable.ncId, id)).orderBy(ncCorrectionsTable.performedAt);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list corrections");
    res.status(500).json({ error: "Failed to list corrections" });
  }
});

router.post("/non-conformances/:id/corrections", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (await ncIsCancelled(id)) { res.status(409).json({ error: "This NC is cancelled and read-only. Re-open it first (Admin)." }); return; }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const { description, dueDate, taskOwnerName, taskOwnerUserId, notes } = (req.body ?? {}) as {
      description?: string; dueDate?: string; taskOwnerName?: string; taskOwnerUserId?: number | null; notes?: string;
    };
    if (!description || !description.trim()) {
      res.status(400).json({ error: "Task description is required" }); return;
    }
    const [row] = await db.insert(ncCorrectionsTable).values({
      ncId: id,
      description: description.trim(),
      dueDate: dueDate || null,
      taskOwnerName: taskOwnerName?.trim() || null,
      taskOwnerUserId: taskOwnerUserId ?? null,
      notes: notes ?? null,
      // Legacy performedBy* still populated for backward-compatible audit reads.
      performedByUserId: actor?.id ?? null,
      performedByName: actor?.fullName ?? null,
    }).returning();
    void writeAuditLog({
      rowId: id,
      operation: "CORRECTION_ADDED",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? null,
      afterState: row as unknown as Record<string, unknown>,
    });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add correction");
    res.status(500).json({ error: "Failed to add correction" });
  }
});

// ── Management acknowledgement (Part 11 e-signature) ─────────────────────────

router.post("/non-conformances/:id/management-acknowledge", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning, notes } = req.body as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string; notes?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const [before] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!before) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This NC is cancelled and read-only. Re-open it first (Admin)." }); return; }
    // Session 56 — management acknowledgement requires a management role and an
    // initials match to the signed-in user (Part 11). Previously any
    // authenticated user could record the management sign-off.
    if (!actor) { res.status(401).json({ error: "Authentication required to acknowledge a non-conformance." }); return; }
    if (!NC_MGMT_ACK_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Management acknowledgement requires Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." });
      return;
    }
    const [nc] = await db.update(nonConformancesTable).set({
      mgmtAcknowledgedBy: actor.id,
      mgmtAcknowledgedName: meaning,
      mgmtAcknowledgedInitials: initials,
      mgmtAcknowledgedAt: new Date(),
      mgmtAcknowledgedNotes: notes ?? null,
      updatedAt: new Date(),
    }).where(eq(nonConformancesTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "MGMT_ACKNOWLEDGE",
      changedByName: meaning,
      changedById: actor?.id ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to acknowledge non-conformance");
    res.status(500).json({ error: "Failed to acknowledge non-conformance" });
  }
});

// Edit a correction task — only before it is marked completed.
router.patch("/nc-corrections/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(ncCorrectionsTable).where(eq(ncCorrectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Correction task not found" }); return; }
    if (existing.completed) {
      res.status(409).json({ error: "Completed correction tasks are immutable." });
        return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    if (typeof body.description === "string" && body.description.trim()) allowed.description = body.description.trim();
    if ("dueDate" in body) allowed.dueDate = (body.dueDate as string) || null;
    if ("taskOwnerName" in body) allowed.taskOwnerName = ((body.taskOwnerName as string) ?? "").trim() || null;
    if ("notes" in body) allowed.notes = (body.notes as string) ?? null;
    if (Object.keys(allowed).length === 0) {
      res.status(400).json({ error: "No editable fields provided." }); return;
    }
    const [row] = await db.update(ncCorrectionsTable)
      .set({ ...allowed, updatedAt: new Date() } as never)
      .where(eq(ncCorrectionsTable.id, id))
      .returning();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update correction task");
    res.status(500).json({ error: "Failed to update correction task" });
  }
});

// Mark a correction task complete. NC-3 (2026-07-12): completion now requires
// being the assigned owner — the Supervisor+ bypass was removed so a non-owner
// can't silently complete someone else's task. A non-owner must explicitly
// reassign the task to themselves first (POST .../reassign-to-me), which is
// audited, making the handoff visible rather than invisible. Part 11 timestamps
// capture who/when.
router.post("/nc-corrections/:id/complete", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [existing] = await db.select().from(ncCorrectionsTable).where(eq(ncCorrectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Correction task not found" }); return; }
    if (existing.completed) {
      res.json(existing); return;
    }
    const isOwner =
      (existing.taskOwnerUserId != null && existing.taskOwnerUserId === actor.id) ||
      (!!existing.taskOwnerName && existing.taskOwnerName.trim().toLowerCase() === actor.fullName.trim().toLowerCase());
    if (!isOwner) {
      res.status(403).json({ error: "Only the assigned owner can complete this task. Reassign it to yourself first if you're taking it over." });
      return;
    }
    // Session 101 (#9) — completing a correction requires the owner to record
    // what was done (notes) and the date it occurred (performedOn).
    const doneNotes = String((req.body as { notes?: unknown })?.notes ?? "").trim();
    const performedOn = String((req.body as { performedOn?: unknown })?.performedOn ?? "").trim();
    if (!doneNotes || !performedOn) {
      res.status(400).json({ error: "Completing a correction requires a description of what was done and the date it was performed." });
      return;
    }
    const [row] = await db.update(ncCorrectionsTable)
      .set({
        completed: true,
        completedAt: new Date(),
        completedByUserId: actor.id,
        completedByName: actor.fullName,
        notes: doneNotes,
        performedOn,
        updatedAt: new Date(),
      } as never)
      .where(eq(ncCorrectionsTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: existing.ncId,
      operation: "CORRECTION_COMPLETED",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { correctionId: id, completed: false } as never,
      afterState: { correctionId: id, completed: true, completedByName: actor.fullName } as never,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to complete correction task");
    res.status(500).json({ error: "Failed to complete correction task" });
  }
});

// NC-3 (2026-07-12) — take ownership of a correction task. Because completion
// now requires being the owner, a non-owner reassigns the task to themselves
// here first (an explicit, audited handoff) and can then complete it. Allowed on
// any not-yet-completed task; the reassignment is written to the audit log.
router.post("/nc-corrections/:id/reassign-to-me", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [existing] = await db.select().from(ncCorrectionsTable).where(eq(ncCorrectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Correction task not found" }); return; }
    if (existing.completed) { res.status(409).json({ error: "Completed correction tasks are immutable." }); return; }
    const [row] = await db.update(ncCorrectionsTable)
      .set({ taskOwnerUserId: actor.id, taskOwnerName: actor.fullName, updatedAt: new Date() } as never)
      .where(eq(ncCorrectionsTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: existing.ncId,
      operation: "CORRECTION_REASSIGNED",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { correctionId: id, taskOwnerName: existing.taskOwnerName } as never,
      afterState: { correctionId: id, taskOwnerName: actor.fullName } as never,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to reassign correction task");
    res.status(500).json({ error: "Failed to reassign correction task" });
  }
});

// NC-2 (2026-07-12) — the current user's OPEN correction tasks across all NCs,
// for the Dashboard "My Queue". Matches by owner user id (when set) or by owner
// full name; excludes completed tasks and closed NCs. Joins the parent NC so the
// tile can label + link each task.
router.get("/my/nc-corrections", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const rows = await db
      .select({
        id: ncCorrectionsTable.id,
        ncId: ncCorrectionsTable.ncId,
        description: ncCorrectionsTable.description,
        dueDate: ncCorrectionsTable.dueDate,
        ncNumber: nonConformancesTable.ncNumber,
        ncTitle: nonConformancesTable.title,
      })
      .from(ncCorrectionsTable)
      .innerJoin(nonConformancesTable, eq(ncCorrectionsTable.ncId, nonConformancesTable.id))
      .where(and(
        eq(ncCorrectionsTable.completed, false),
        ne(nonConformancesTable.status, "Closed"),
        or(
          eq(ncCorrectionsTable.taskOwnerUserId, actor.id),
          sql`lower(${ncCorrectionsTable.taskOwnerName}) = ${actor.fullName.trim().toLowerCase()}`,
        ),
      ))
      .orderBy(ncCorrectionsTable.dueDate);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list my nc-corrections");
    res.status(500).json({ error: "Failed to list correction tasks" });
  }
});

router.patch("/corrective-actions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // NC-3 — this endpoint was unauthenticated and unguarded (anyone could set
    // status/completedAt on any corrective action). Require a signed-in actor who
    // is the assigned owner or a Supervisor+ approver before mutating.
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [existingCA] = await db.select().from(correctiveActionsTable).where(eq(correctiveActionsTable.id, id));
    if (!existingCA) { res.status(404).json({ error: "Corrective action not found" }); return; }
    const caIsOwner =
      (existingCA.assignedTo != null && existingCA.assignedTo === actor.id) ||
      (!!existingCA.assignedToName && existingCA.assignedToName.trim().toLowerCase() === actor.fullName.trim().toLowerCase());
    if (!caIsOwner && !SUPERVISOR_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only the assigned owner or a Supervisor / Manager / Quality / Admin may update this corrective action." });
      return;
    }
    const incoming = (req.body ?? {}) as Record<string, unknown>;
    // Drizzle's timestamp mapper expects Date instances when using set() with
    // a raw object; coerce ISO strings to Date so the legacy "Mark Complete"
    // flow doesn't 500 on toISOString().
    const coerced: Record<string, unknown> = { ...incoming };
    for (const k of ["completedAt"] as const) {
      if (typeof coerced[k] === "string") {
        const d = new Date(coerced[k] as string);
        if (!Number.isNaN(d.getTime())) coerced[k] = d;
      }
    }
    const [action] = await db
      .update(correctiveActionsTable)
      .set({ ...coerced, updatedAt: new Date() })
      .where(eq(correctiveActionsTable.id, id))
      .returning();
    if (!action) { res.status(404).json({ error: "Corrective action not found" }); return; }
    res.json(action);
  } catch (err) {
    req.log.error({ err }, "Failed to update corrective action");
    res.status(500).json({ error: "Failed to update corrective action" });
  }
});

// ── Session 52 — soft Cancel / Re-open (Part 11) ─────────────────────────────
//
// QMS records are never hard-deleted. Cancel retains the row, is recoverable
// (/uncancel, Admin-only), and requires a Manager/Quality/Admin actor + a
// rationale + a Part 11 e-signature (initials matching the signed-in user +
// meaning). Cancel is permitted ONLY while the NC is In-Process; a Closed NC
// cannot be cancelled (409 — Re-open it first, or open a new NC). Mirrors the
// destruction_records reference implementation (Session 51).
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.post("/non-conformances/:id/cancel", async (req, res) => {
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

    const [before] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!before) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }
    if (before.status === "Closed") {
      res.status(409).json({ error: "A Closed NC cannot be cancelled. Re-open it first (Admin), or open a new NC." }); return;
    }

    const [nc] = await db.update(nonConformancesTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(nonConformancesTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "CANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel non-conformance");
    res.status(500).json({ error: "Failed to cancel non-conformance" });
  }
});

// POST /non-conformances/:id/uncancel — reverse a Cancel. Admin-ONLY (Session
// 52 decision — narrower than Cancel). Part 11 signature required. Clears the
// cancel fields and returns the NC to active use.
router.post("/non-conformances/:id/uncancel", async (req, res) => {
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

    const [before] = await db.select().from(nonConformancesTable).where(eq(nonConformancesTable.id, id));
    if (!before) { res.status(404).json({ error: "Non-conformance not found" }); return; }
    if (!before.cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [nc] = await db.update(nonConformancesTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(nonConformancesTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UNCANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: nc as unknown as Record<string, unknown>,
    });
    res.json(nc);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel non-conformance");
    res.status(500).json({ error: "Failed to uncancel non-conformance" });
  }
});

export default router;
