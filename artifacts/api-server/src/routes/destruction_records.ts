import { Router } from "express";
import { db } from "@workspace/db";
import { destructionRecordsTable, destructionRecordLinesTable, nonConformancesTable, auditLogTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { getPackageByLabel, adjustPackages, finishPackages } from "../lib/metrcPackages";
import { facilityDateStr } from "../lib/facilityDate";

// 2026-08-05 — a destruction record can list MANY METRC package tags (each
// package destroyed under the event). Parse + normalize the client's line array.
type ParsedLine = {
  metrcTag: string;
  itemName: string | null;
  amount: number | null;
  uom: string | null;
  reason: string | null;
  sourceBatchId: number | null;
  note: string | null;
};
function parseLines(incoming: Record<string, unknown>): ParsedLine[] {
  const raw = Array.isArray(incoming.lines) ? (incoming.lines as unknown[]) : [];
  const out: ParsedLine[] = [];
  for (const item of raw) {
    const l = (item ?? {}) as Record<string, unknown>;
    const metrcTag = typeof l.metrcTag === "string" ? l.metrcTag.trim() : "";
    if (!metrcTag) continue;
    const amtRaw = l.amount;
    const amount =
      amtRaw === null || amtRaw === undefined || amtRaw === "" ? null : Number(amtRaw);
    out.push({
      metrcTag,
      itemName: typeof l.itemName === "string" && l.itemName.trim() ? l.itemName.trim() : null,
      amount: amount === null || Number.isNaN(amount) ? null : amount,
      uom: typeof l.uom === "string" && l.uom.trim() ? l.uom.trim() : null,
      reason: typeof l.reason === "string" && l.reason.trim() ? l.reason.trim() : null,
      sourceBatchId: typeof l.sourceBatchId === "number" ? l.sourceBatchId : null,
      note: typeof l.note === "string" && l.note.trim() ? l.note.trim() : null,
    });
  }
  return out;
}

// Session 49 — METRC destruction record CRUD.
//
// Michigan CRA requires a METRC destruction tag whenever product is destroyed,
// and one tag can cover MANY destroyed batches. So destruction_records is its
// own table and non_conformances links to it via destruction_record_id
// (many NCs : one destruction record). See lib/db/src/schema/destruction_records.ts.

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
      tableName: "destruction_records",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

// Mirrors NC_CREATE_ALLOWED — explicit allowlist so the route is deterministic
// and resilient to accidental client fields / schema drift.
const DR_CREATE_ALLOWED = new Set([
  "metrcTag",
  "destroyedAt",
  "destroyedByName",
  "witnessName",
  "weight",
  "weightUom",
  "method",
  "notes",
  "reason",
  "nonCannabisMaterial",
  "mixtureConfirmed",
  "disposalRoute",
  "haulerName",
  "manifestNumber",
  "sourceBatchId",
  "sourceLotNumber",
  "surveillanceConfirmed",
  "surveillanceCameraRef",
  "metrcAdjustmentReason",
]);

// Immutable / server-managed fields stripped from PATCH bodies. archivedAt is
// managed by /archive + /unarchive; the cancelled_* fields by /cancel +
// /uncancel — never by a field edit.
const DR_PATCH_STRIP = new Set([
  "id", "createdAt", "updatedAt", "archivedAt", "status",
  "cancelledAt", "cancelledReason", "cancelledByName", "cancelledByInitials", "cancelledMeaning",
  "signedByName", "signedByInitials", "signedMeaning", "signedAt",
]);

const router = Router();

// GET /destruction-records — list, newest destruction first.
//   ?recent=true    last 30 days, active only (for the NC link-selector dropdown).
//   ?archived=true  archived (non-cancelled) records only.
//   ?cancelled=true cancelled records only.
//   ?all=true       everything.
// Default: active only — not archived AND not cancelled. Session 51 added the
// cancelled exclusion on top of Session 50's archived exclusion.
router.get("/destruction-records", async (req, res) => {
  try {
    const recent = req.query.recent === "true";
    const archived = req.query.archived === "true";
    const cancelled = req.query.cancelled === "true";
    const all = req.query.all === "true";

    const conditions = [];
    if (recent) {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      conditions.push(gte(destructionRecordsTable.destroyedAt, cutoff));
      // dropdown wants active records only
      conditions.push(isNull(destructionRecordsTable.archivedAt));
      conditions.push(isNull(destructionRecordsTable.cancelledAt));
    } else if (!all) {
      if (cancelled) {
        conditions.push(isNotNull(destructionRecordsTable.cancelledAt));
      } else if (archived) {
        conditions.push(isNotNull(destructionRecordsTable.archivedAt));
        conditions.push(isNull(destructionRecordsTable.cancelledAt));
      } else {
        conditions.push(isNull(destructionRecordsTable.archivedAt));
        conditions.push(isNull(destructionRecordsTable.cancelledAt));
      }
    }

    const base = db.select().from(destructionRecordsTable);
    const rows = await (conditions.length ? base.where(and(...conditions)) : base)
      .orderBy(desc(destructionRecordsTable.destroyedAt));
    // Attach each record's package METRC tags so the list can be searched down
    // to the tag level (find a package number without opening every record).
    const ids = rows.map((r) => r.id);
    const tagsByRecord = new Map<number, string[]>();
    if (ids.length) {
      const lineTags = await db
        .select({ rid: destructionRecordLinesTable.destructionRecordId, tag: destructionRecordLinesTable.metrcTag })
        .from(destructionRecordLinesTable)
        .where(inArray(destructionRecordLinesTable.destructionRecordId, ids));
      for (const lt of lineTags) {
        const arr = tagsByRecord.get(lt.rid) ?? [];
        arr.push(lt.tag);
        tagsByRecord.set(lt.rid, arr);
      }
    }
    res.json(rows.map((r) => ({ ...r, packageTags: tagsByRecord.get(r.id) ?? [] })));
  } catch (err) {
    req.log.error({ err }, "Failed to list destruction records");
    res.status(500).json({ error: "Failed to list destruction records" });
  }
});

// Roles permitted to Cancel / Uncancel a record. Deliberately NARROWER than
// the approver/supervisor sets elsewhere (no Supervisor) so cancellation stays
// a rare, senior action and doesn't become common practice (Jonathan, S50).
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

// POST /destruction-records/:id/archive  — soft-archive (set archived_at=now).
// POST /destruction-records/:id/unarchive — clear archived_at.
async function setArchived(req: import("express").Request, res: import("express").Response, value: Date | null) {
  // Express 5 types `req.params.id` as string | string[] on a generically-typed
  // Request (the inline route handlers infer plain string from the :id path).
  // String() coerces it safely for parseInt.
  const id = parseInt(String(req.params.id));
  const [before] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
  if (!before) { res.status(404).json({ error: "Destruction record not found" }); return; }
  const actor = await getOrProvisionCurrentUser(req).catch(() => null);
  const [record] = await db
    .update(destructionRecordsTable)
    .set({ archivedAt: value, updatedAt: new Date() } as never)
    .where(eq(destructionRecordsTable.id, id))
    .returning();
  void writeAuditLog({
    rowId: id,
    operation: value ? "ARCHIVE" : "UNARCHIVE",
    changedById: actor?.id ?? null,
    changedByName: actor?.fullName ?? null,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: record as unknown as Record<string, unknown>,
  });
  res.json(record);
}

router.post("/destruction-records/:id/archive", async (req, res) => {
  try { await setArchived(req, res, new Date()); }
  catch (err) {
    req.log.error({ err }, "Failed to archive destruction record");
    res.status(500).json({ error: "Failed to archive destruction record" });
  }
});

router.post("/destruction-records/:id/unarchive", async (req, res) => {
  try { await setArchived(req, res, null); }
  catch (err) {
    req.log.error({ err }, "Failed to unarchive destruction record");
    res.status(500).json({ error: "Failed to unarchive destruction record" });
  }
});

// GET /destruction-records/:id — one record + the NCs that reference it.
router.get("/destruction-records/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!record) { res.status(404).json({ error: "Destruction record not found" }); return; }
    const linkedNcs = await db
      .select({
        id: nonConformancesTable.id,
        ncNumber: nonConformancesTable.ncNumber,
        title: nonConformancesTable.title,
        status: nonConformancesTable.status,
        severity: nonConformancesTable.severity,
      })
      .from(nonConformancesTable)
      .where(eq(nonConformancesTable.destructionRecordId, id));
    const lines = await db
      .select()
      .from(destructionRecordLinesTable)
      .where(eq(destructionRecordLinesTable.destructionRecordId, id))
      .orderBy(asc(destructionRecordLinesTable.id));
    res.json({ ...record, linkedNcs, lines });
  } catch (err) {
    req.log.error({ err }, "Failed to get destruction record");
    res.status(500).json({ error: "Failed to get destruction record" });
  }
});

// POST /destruction-records — create.
router.post("/destruction-records", async (req, res) => {
  try {
    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (DR_CREATE_ALLOWED.has(k)) safe[k] = v;
    }

    // 2026-08-05 — multi-tag lines. When the client sends a `lines` array, the
    // header's own metrcTag/weight become a summary of the lines: metrcTag mirrors
    // the first line's tag (keeps the list view + NC dropdown labels meaningful),
    // and the per-line amounts replace the single header weight. `reason` at the
    // top level is the header DEFAULT reason. Legacy single-tag callers (no lines)
    // are unchanged.
    const lines = parseLines(incoming);
    if (lines.length === 0) {
      res.status(400).json({ error: "At least one package (METRC tag) is required to open a destruction record." });
      return;
    }
    if (lines.length > 0) {
      safe.metrcTag = lines[0].metrcTag;
      // Per-line amounts are the source of truth now; don't keep a header weight.
      delete safe.weight;
      delete safe.weightUom;
    }

    // Required-field guard with a clear message.
    const missing: string[] = [];
    for (const k of ["metrcTag", "destroyedByName"]) {
      if (typeof safe[k] !== "string" || !((safe[k] as string).trim())) missing.push(k);
    }
    if (!safe.destroyedAt) missing.push("destroyedAt");
    if (missing.length > 0) {
      res.status(400).json({ error: `Required field${missing.length > 1 ? "s" : ""} missing: ${missing.join(", ")}.` });
      return;
    }

    // Coerce destroyedAt ISO string -> Date (drizzle timestamp mapper expects a Date).
    if (typeof safe.destroyedAt === "string") {
      const d = new Date(safe.destroyedAt as string);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "destroyedAt is not a valid date." });
        return;
      }
      safe.destroyedAt = d;
    }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }

    // Session 52 — records now OPEN and unsigned; the 21 CFR Part 11 signature
    // moves to POST /:id/close. Default the METRC adjustment reason to Waste
    // (Michigan's catch-all destruction reason); Spoilage is picked for expired
    // edibles.
    safe.status = "Open";
    if (typeof safe.metrcAdjustmentReason !== "string" || !(safe.metrcAdjustmentReason as string).trim()) {
      safe.metrcAdjustmentReason = "Waste";
    }

    const record = await db.transaction(async (tx) => {
      const [header] = await tx
        .insert(destructionRecordsTable)
        .values(safe as typeof destructionRecordsTable.$inferInsert)
        .returning();
      if (lines.length > 0) {
        await tx.insert(destructionRecordLinesTable).values(
          lines.map((l) => ({
            destructionRecordId: header.id,
            metrcTag: l.metrcTag,
            itemName: l.itemName,
            amount: l.amount,
            uom: l.uom,
            // Each line falls back to the header's default reason when none set.
            reason: l.reason ?? (typeof safe.reason === "string" ? (safe.reason as string) : null),
            sourceBatchId: l.sourceBatchId,
            note: l.note,
          })),
        );
      }
      return header;
    });
    void writeAuditLog({
      rowId: record.id,
      operation: "INSERT",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? (safe.destroyedByName as string) ?? null,
      afterState: record as unknown as Record<string, unknown>,
    });
    res.status(201).json(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to create destruction record");
    res.status(500).json({ error: `Failed to create destruction record: ${msg}` });
  }
});

// POST /destruction-records/:id/lines — append a package (METRC tag) to an OPEN
// record. Any authenticated user may add; blocked once Closed or cancelled.
router.post("/destruction-records/:id/lines", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!record) { res.status(404).json({ error: "Destruction record not found." }); return; }
    if (record.cancelledAt) { res.status(400).json({ error: "This record is cancelled — packages can't be added." }); return; }
    if (record.status === "Closed") { res.status(400).json({ error: "This record is closed — packages can only be added while it is Open." }); return; }

    const [line] = parseLines({ lines: [req.body ?? {}] });
    if (!line) { res.status(400).json({ error: "A METRC tag is required." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const [created] = await db.insert(destructionRecordLinesTable).values({
      destructionRecordId: id,
      metrcTag: line.metrcTag,
      itemName: line.itemName,
      amount: line.amount,
      uom: line.uom,
      reason: line.reason ?? (typeof record.reason === "string" ? record.reason : null),
      sourceBatchId: line.sourceBatchId,
      note: line.note,
    }).returning();

    void writeAuditLog({ rowId: id, operation: "ADD_LINE", changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null, afterState: created as unknown as Record<string, unknown> });
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to add destruction line");
    res.status(500).json({ error: "Failed to add package." });
  }
});

// PATCH /destruction-records/:id/lines/:lineId — edit a package on an OPEN
// record. Admin only (while Open, non-admins add only; an Admin can correct
// amounts/reasons or remove a package).
router.patch("/destruction-records/:id/lines/:lineId", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const lineId = parseInt(req.params.lineId);
    const [record] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!record) { res.status(404).json({ error: "Destruction record not found." }); return; }
    if (record.cancelledAt || record.status === "Closed") { res.status(400).json({ error: "This record is not Open — packages can't be edited." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: `Editing a package is restricted to Admin. Your role is "${actor.role}".` }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ("itemName" in body) patch.itemName = typeof body.itemName === "string" && body.itemName.trim() ? body.itemName.trim() : null;
    if ("uom" in body) patch.uom = typeof body.uom === "string" && body.uom.trim() ? body.uom.trim() : null;
    if ("reason" in body) patch.reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    if ("note" in body) patch.note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    if ("amount" in body) {
      const a = body.amount;
      const n = a === null || a === undefined || a === "" ? null : Number(a);
      if (n !== null && Number.isNaN(n)) { res.status(400).json({ error: "Amount must be a number." }); return; }
      patch.amount = n;
    }
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "No editable fields provided." }); return; }

    const [updated] = await db.update(destructionRecordLinesTable).set(patch as never)
      .where(and(eq(destructionRecordLinesTable.id, lineId), eq(destructionRecordLinesTable.destructionRecordId, id))).returning();
    if (!updated) { res.status(404).json({ error: "Package line not found." }); return; }
    void writeAuditLog({ rowId: id, operation: "EDIT_LINE", changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null, afterState: updated as unknown as Record<string, unknown> });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to edit destruction line");
    res.status(500).json({ error: "Failed to edit package." });
  }
});

// DELETE /destruction-records/:id/lines/:lineId — remove a package from an OPEN
// record. Admin only. A record must keep at least one package.
router.delete("/destruction-records/:id/lines/:lineId", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const lineId = parseInt(req.params.lineId);
    const [record] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!record) { res.status(404).json({ error: "Destruction record not found." }); return; }
    if (record.cancelledAt || record.status === "Closed") { res.status(400).json({ error: "This record is not Open — packages can't be removed." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: `Removing a package is restricted to Admin. Your role is "${actor.role}".` }); return; }

    const existing = await db.select().from(destructionRecordLinesTable).where(eq(destructionRecordLinesTable.destructionRecordId, id));
    if (existing.length <= 1) { res.status(400).json({ error: "A record must keep at least one package. Add another before removing this one, or cancel the record." }); return; }

    const [removed] = await db.delete(destructionRecordLinesTable)
      .where(and(eq(destructionRecordLinesTable.id, lineId), eq(destructionRecordLinesTable.destructionRecordId, id))).returning();
    if (!removed) { res.status(404).json({ error: "Package line not found." }); return; }
    void writeAuditLog({ rowId: id, operation: "DELETE_LINE", changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null, beforeState: removed as unknown as Record<string, unknown> });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove destruction line");
    res.status(500).json({ error: "Failed to remove package." });
  }
});

// POST /destruction-records/:id/close — Close & Sign. Captures the 21 CFR Part
// 11 signature (initials must match the signed-in user) and locks the record.
// Phase 2 will additionally push each package's adjust-to-0 + finish to METRC.
router.post("/destruction-records/:id/close", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!record) { res.status(404).json({ error: "Destruction record not found." }); return; }
    if (record.cancelledAt) { res.status(400).json({ error: "This record is cancelled." }); return; }
    if (record.status === "Closed") { res.status(400).json({ error: "This record is already closed." }); return; }

    const existing = await db.select().from(destructionRecordLinesTable).where(eq(destructionRecordLinesTable.destructionRecordId, id));
    if (existing.length === 0) { res.status(400).json({ error: "Add at least one package before closing." }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Not signed in." }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const initials = typeof body.initials === "string" ? body.initials.trim() : "";
    const meaning = typeof body.signatureMeaning === "string" ? (body.signatureMeaning as string).trim()
      : typeof body.signingMeaning === "string" ? (body.signingMeaning as string).trim() : "";
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning are required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) { res.status(400).json({ error: "Initials do not match the signed-in user." }); return; }

    // ── Phase 2 — push each package's adjust-to-0 (+ finish) to METRC. Gated by
    // METRC_WRITE_ENABLED (off by default → nothing is sent, each line records
    // "write-back disabled"). NON-BLOCKING: a METRC failure is recorded per
    // package (metrcSyncError) and surfaced, but never stops the record closing.
    const writeEnabled = (process.env["METRC_WRITE_ENABLED"] ?? "").trim().toLowerCase() === "true";
    const adjReason = (typeof record.metrcAdjustmentReason === "string" && record.metrcAdjustmentReason.trim())
      ? record.metrcAdjustmentReason.trim() : "Waste";
    const whenISO = facilityDateStr((record.destroyedAt instanceof Date ? record.destroyedAt : new Date()));
    const emsg = (r: { ok: boolean; status?: number; error?: string }): string =>
      (r as { error?: string }).error || ((r as { status?: number }).status ? `HTTP ${(r as { status?: number }).status}` : "unknown error");
    const metrcResults: { tag: string; ok: boolean; error?: string }[] = [];
    // Only touch METRC (and set per-package sync status) when write-back is on.
    // With the flag OFF, closing is unchanged — no adjustments, no status badges.
    if (writeEnabled) for (const line of existing) {
      let synced = false;
      let syncError: string | null = null;
      try {
        if (!writeEnabled) {
          syncError = "METRC write-back disabled (set METRC_WRITE_ENABLED=true to push).";
        } else {
          const pkg = await getPackageByLabel(line.metrcTag);
          const pdata = (pkg as { data?: { Quantity?: number | null; UnitOfMeasureName?: string | null } }).data;
          if (!pkg.ok || !pdata) {
            syncError = `Package not found or unreadable in METRC (${emsg(pkg)}).`;
          } else {
            const onHand = Number(pdata.Quantity ?? 0);
            const metrcUnit = pdata.UnitOfMeasureName || line.uom || "Each";
            const want = (line.amount != null && line.amount > 0) ? line.amount : onHand;
            const destroyAmt = Math.min(want, onHand);
            if (!(destroyAmt > 0)) {
              syncError = "Nothing to adjust — METRC shows 0 on hand for this tag.";
            } else {
              const adj = await adjustPackages([{ label: line.metrcTag, quantity: -destroyAmt, unitOfMeasure: metrcUnit, reason: adjReason, date: whenISO, note: line.reason ?? record.reason ?? null }]);
              if (!adj.ok) {
                syncError = `METRC adjust failed (${emsg(adj)}).`;
              } else if (onHand - destroyAmt <= 1e-6) {
                const fin = await finishPackages([{ label: line.metrcTag, date: whenISO }]);
                synced = fin.ok;
                syncError = fin.ok ? null : `Adjusted to 0, but METRC finish failed (${emsg(fin)}).`;
              } else {
                synced = true; // partial adjust succeeded; tag left open in METRC
              }
            }
          }
        }
      } catch (e) {
        syncError = e instanceof Error ? e.message : String(e);
      }
      await db.update(destructionRecordLinesTable)
        .set({ metrcSynced: synced, metrcSyncError: syncError, metrcSyncedAt: synced ? new Date() : null } as never)
        .where(eq(destructionRecordLinesTable.id, line.id));
      metrcResults.push({ tag: line.metrcTag, ok: synced, error: syncError ?? undefined });
    }

    const [updated] = await db.update(destructionRecordsTable).set({
      status: "Closed",
      signedByName: actor.fullName,
      signedByInitials: initials.toUpperCase(),
      signedMeaning: meaning,
      signedAt: new Date(),
      updatedAt: new Date(),
    } as never).where(eq(destructionRecordsTable.id, id)).returning();

    void writeAuditLog({ rowId: id, operation: "CLOSE", changedById: actor?.id ?? null, changedByName: actor?.fullName ?? null, beforeState: record as unknown as Record<string, unknown>, afterState: { ...updated, metrcResults } as unknown as Record<string, unknown> });
    res.json({ ...updated, metrcResults });
  } catch (err) {
    req.log.error({ err }, "Failed to close destruction record");
    res.status(500).json({ error: "Failed to close destruction record." });
  }
});


// PATCH /destruction-records/:id — update; strips audit/immutable fields.
router.patch("/destruction-records/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Destruction record not found" }); return; }
    if (before.status === "Closed") { res.status(400).json({ error: "This record is closed and locked." }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (DR_PATCH_STRIP.has(k)) continue;
      update[k] = v;
    }
    if (typeof update.destroyedAt === "string") {
      const d = new Date(update.destroyedAt as string);
      if (!Number.isNaN(d.getTime())) update.destroyedAt = d;
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No editable fields provided." });
      return;
    }
    update.updatedAt = new Date();

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const [record] = await db
      .update(destructionRecordsTable)
      .set(update as never)
      .where(eq(destructionRecordsTable.id, id))
      .returning();
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: record as unknown as Record<string, unknown>,
    });
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to update destruction record");
    res.status(500).json({ error: "Failed to update destruction record" });
  }
});

// DELETE /destruction-records/:id — guarded. If any NCs still reference this
// POST /destruction-records/:id/cancel  — soft Cancel (Part 11).
//   Replaces the old hard DELETE. QMS records are never hard-deleted (Part 11);
//   Cancel retains the row, is recoverable via /uncancel, and requires:
//     - a Manager/Quality/Admin actor (CANCEL_ROLES),
//     - a rationale,
//     - a Part 11 e-signature (initials matching the signed-in user + meaning),
//     - no OPEN linked NCs (close them first).
//   body: { reason, initials, signatureMeaning }
router.post("/destruction-records/:id/cancel", async (req, res) => {
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
    if (!reason || !reason.trim()) {
      res.status(400).json({ error: "A cancellation rationale is required." }); return;
    }
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Destruction record not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }

    // Open-NC guard: a record may not be cancelled while NCs that reference it
    // are still open. Closed linked NCs are fine.
    const openNcs = await db
      .select({ id: nonConformancesTable.id })
      .from(nonConformancesTable)
      .where(and(eq(nonConformancesTable.destructionRecordId, id), ne(nonConformancesTable.status, "Closed")));
    if (openNcs.length > 0) {
      const n = openNcs.length;
      res.status(409).json({
        error: `Cannot cancel: ${n} open NC${n === 1 ? "" : "s"} reference this record. Close ${n === 1 ? "it" : "them"} first.`,
        openNcCount: n,
      });
      return;
    }

    const [record] = await db.update(destructionRecordsTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(destructionRecordsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "CANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: record as unknown as Record<string, unknown>,
    });
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel destruction record");
    res.status(500).json({ error: "Failed to cancel destruction record" });
  }
});

// POST /destruction-records/:id/uncancel — reverse a Cancel. Same CANCEL_ROLES
// gate + Part 11 signature. Clears the cancel fields. body: { initials, signatureMeaning }
router.post("/destruction-records/:id/uncancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    // Re-open is Admin-ONLY (Session 52 decision) — narrower than Cancel. The
    // normal path is to open a new record; re-opening is a rare exception.
    if (actor.role !== "Admin") {
      res.status(403).json({ error: `Re-opening a record is restricted to Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(destructionRecordsTable).where(eq(destructionRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Destruction record not found" }); return; }
    if (!before.cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [record] = await db.update(destructionRecordsTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(destructionRecordsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UNCANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: record as unknown as Record<string, unknown>,
    });
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel destruction record");
    res.status(500).json({ error: "Failed to uncancel destruction record" });
  }
});

export default router;
