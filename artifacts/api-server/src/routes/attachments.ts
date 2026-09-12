import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  attachmentsTable,
  documentsTable,
  auditLogTable,
  nonConformancesTable,
  complaintsTable,
  capasTable,
  incomingInspectionsTable,
  destructionRecordsTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

// Session 52.1.1 — parents that carry the cancel columns (Session 52/52.1).
// A cancelled QMS record is read-only, so new attachments are blocked. Map the
// parentTable string to its table for the cancelled_at lookup. Tables not here
// (suppliers, field_actions, lots, etc.) don't have cancel columns yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CANCELLABLE_PARENTS: Record<string, any> = {
  non_conformances: nonConformancesTable,
  complaints: complaintsTable,
  capas: capasTable,
  documents: documentsTable,
  incoming_inspections: incomingInspectionsTable,
  destruction_records: destructionRecordsTable,
};

// Session 52.2.1 — parents that are read-only in a terminal/closed state get
// their attachment uploads blocked server-side too (matches the per-page UI
// gates). Maps parentTable -> the status column + the values that mean
// "terminal / read-only". Mirrors each detail page's allowSupplementary gate.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TERMINAL_PARENTS: Record<string, { col: any; values: string[] }> = {
  non_conformances:     { col: nonConformancesTable.status, values: ["Closed"] },
  complaints:           { col: complaintsTable.status,      values: ["Closed"] },
  capas:                { col: capasTable.stage,            values: ["Closed"] },
  incoming_inspections: { col: incomingInspectionsTable.result, values: ["Closed"] },
  documents:            { col: documentsTable.status,       values: ["Obsolete", "Superseded"] },
};
import { getOrProvisionCurrentUser } from "../lib/currentUser";

const router = Router();

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

const ALLOWED_PARENT_TABLES = new Set([
  "documents",
  "training_records",
  "lots",
  "batch_records",
  "batch_testing",
  "non_conformances",
  "capas",
  "complaints",
  "incoming_inspections",
  "suppliers",
  "supplier_qualifications",
  "field_actions",
  "destruction_records",
  // 2026-07-22 — labeling proofs: retail packaging artwork proof + label
  // template proof live as attachments on these two records.
  "packaging_designs",
  "label_templates",
]);

type Actor = { id: number; fullName: string; role: string; initials: string };

async function getActor(req: Request, res: Response): Promise<Actor | null> {
  const user = await getOrProvisionCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required for this action." });
    return null;
  }
  return {
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    initials: user.initials ?? "",
  };
}

async function logAudit(
  rowId: number,
  op: string,
  actor: Actor,
  before: unknown,
  after: unknown,
) {
  await db.insert(auditLogTable).values({
    tableName: "attachments",
    rowId,
    operation: op,
    changedBy: actor.id,
    changedByName: actor.fullName,
    beforeState: before as never,
    afterState: after as never,
  });
}

// GET /attachments?parentTable=X&parentId=Y[&includeInactive=1]
router.get("/attachments", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const parentTable = String(req.query.parentTable ?? "");
    const parentId = parseInt(String(req.query.parentId ?? ""));
    const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";
    if (!ALLOWED_PARENT_TABLES.has(parentTable) || Number.isNaN(parentId)) {
      res.status(400).json({ error: "parentTable and parentId are required and must be valid." });
      return;
    }
    const rows = await db
      .select()
      .from(attachmentsTable)
      .where(
        and(
          eq(attachmentsTable.parentTable, parentTable),
          eq(attachmentsTable.parentId, parentId),
        ),
      )
      .orderBy(desc(attachmentsTable.uploadedAt));
    const filtered = includeInactive ? rows : rows.filter((r) => r.status === "Active");
    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Failed to list attachments");
    res.status(500).json({ error: "Failed to list attachments" });
  }
});

// POST /attachments  body: {parentTable, parentId, kind?, objectPath, fileName, contentType, sizeBytes, description?}
router.post("/attachments", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const {
      parentTable,
      parentId,
      kind,
      objectPath,
      fileName,
      contentType,
      sizeBytes,
      description,
    } = (req.body ?? {}) as {
      parentTable?: string;
      parentId?: number;
      kind?: string;
      objectPath?: string;
      fileName?: string;
      contentType?: string;
      sizeBytes?: number;
      description?: string;
    };
    if (!parentTable || !ALLOWED_PARENT_TABLES.has(parentTable)) {
      res.status(400).json({ error: `parentTable must be one of: ${[...ALLOWED_PARENT_TABLES].join(", ")}` });
      return;
    }
    if (typeof parentId !== "number" || !objectPath || !fileName || !contentType || typeof sizeBytes !== "number") {
      res.status(400).json({ error: "parentId, objectPath, fileName, contentType, and sizeBytes are required." });
      return;
    }
    if (!objectPath.startsWith("/objects/")) {
      res.status(400).json({ error: "objectPath must start with /objects/" });
      return;
    }
    const attachmentKind = kind === "primary" ? "primary" : "supplementary";

    // Session 52.1.1 — block uploads to a cancelled parent. A cancelled QMS
    // record is read-only; new attachments are not permitted (existing files
    // stay viewable). One guard covers every cancellable entity.
    const cancellableTbl = CANCELLABLE_PARENTS[parentTable];
    if (cancellableTbl) {
      const [parent] = await db
        .select({ cancelledAt: cancellableTbl.cancelledAt })
        .from(cancellableTbl)
        .where(eq(cancellableTbl.id, parentId));
      if (parent?.cancelledAt) {
        res.status(409).json({ error: "This record is cancelled; new attachments are not allowed. Re-open it first (Admin)." });
        return;
      }
    }

    // Session 52.2.1 — block uploads to a closed/terminal parent too (matches
    // each detail page's allowSupplementary gate). Existing files stay viewable.
    const terminal = TERMINAL_PARENTS[parentTable];
    if (terminal) {
      const [parent] = await db
        .select({ v: terminal.col })
        .from(CANCELLABLE_PARENTS[parentTable])
        .where(eq(CANCELLABLE_PARENTS[parentTable].id, parentId));
      if (parent && typeof parent.v === "string" && terminal.values.includes(parent.v)) {
        res.status(409).json({ error: `This record is ${parent.v} and read-only; new attachments are not allowed.` });
        return;
      }
    }

    // Special handling for Documents primary file: only allowed while Draft;
    // a new primary supersedes any existing Active primary on the same doc.
    if (parentTable === "documents" && attachmentKind === "primary") {
      const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, parentId));
      if (!doc) {
        res.status(404).json({ error: "Document not found." });
        return;
      }
      if (doc.status !== "Draft") {
        res.status(400).json({
          error: `Cannot attach a primary file to a document in status "${doc.status}". Start a new revision (Draft) first.`,
        });
        return;
      }
    }

    const created = await db.transaction(async (tx) => {
      // If primary on a document, supersede the prior active primary on that doc.
      let supersededRow: typeof attachmentsTable.$inferSelect | null = null;
      if (parentTable === "documents" && attachmentKind === "primary") {
        const [prior] = await tx
          .select()
          .from(attachmentsTable)
          .where(
            and(
              eq(attachmentsTable.parentTable, "documents"),
              eq(attachmentsTable.parentId, parentId),
              eq(attachmentsTable.kind, "primary"),
              eq(attachmentsTable.status, "Active"),
            ),
          )
          .orderBy(desc(attachmentsTable.uploadedAt))
          .limit(1);
        if (prior) supersededRow = prior;
      }

      const [row] = await tx
        .insert(attachmentsTable)
        .values({
          parentTable,
          parentId,
          kind: attachmentKind,
          objectPath,
          fileName,
          contentType,
          sizeBytes,
          description: description ?? null,
          status: "Active",
          uploadedByUserId: actor.id,
          uploadedByName: actor.fullName,
        })
        .returning();

      if (supersededRow) {
        await tx
          .update(attachmentsTable)
          .set({
            status: "Superseded",
            supersededByAttachmentId: row.id,
            updatedAt: new Date(),
          })
          .where(eq(attachmentsTable.id, supersededRow.id));
        await tx.insert(auditLogTable).values({
          tableName: "attachments",
          rowId: supersededRow.id,
          operation: "SUPERSEDE",
          changedBy: actor.id,
          changedByName: actor.fullName,
          beforeState: { status: "Active", fileName: supersededRow.fileName } as never,
          afterState: {
            status: "Superseded",
            supersededByAttachmentId: row.id,
            replacementFileName: fileName,
          } as never,
        });
      }

      await tx.insert(auditLogTable).values({
        tableName: "attachments",
        rowId: row.id,
        operation: "UPLOAD",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: null as never,
        afterState: {
          parentTable,
          parentId,
          kind: attachmentKind,
          fileName,
          contentType,
          sizeBytes,
          objectPath,
          supersedesAttachmentId: supersededRow?.id ?? null,
        } as never,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to create attachment");
    res.status(500).json({ error: "Failed to create attachment" });
  }
});

// PATCH /attachments/:id  body: {description?}
// Only the description (a free-text label) can be edited. The file itself is immutable.
router.patch("/attachments/:id", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { description } = (req.body ?? {}) as { description?: string };
    if (typeof description !== "string") {
      res.status(400).json({ error: "Only `description` may be edited." });
      return;
    }
    const [existing] = await db.select().from(attachmentsTable).where(eq(attachmentsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Attachment not found." });
      return;
    }
    if (existing.status !== "Active") {
      res.status(400).json({ error: `Cannot edit a ${existing.status} attachment.` });
      return;
    }
    if (existing.uploadedByUserId !== actor.id && !APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only the uploader or a Quality/Admin user can edit this attachment." });
      return;
    }
    const [row] = await db
      .update(attachmentsTable)
      .set({ description, updatedAt: new Date() })
      .where(eq(attachmentsTable.id, id))
      .returning();
    await logAudit(id, "EDIT_DESCRIPTION", actor,
      { description: existing.description },
      { description });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update attachment");
    res.status(500).json({ error: "Failed to update attachment" });
  }
});

// POST /attachments/:id/void  body: {reason, initials, meaning}
// Part 11 voiding. File stays in object storage; row remains for audit.
router.post("/attachments/:id/void", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { reason, initials, meaning } = (req.body ?? {}) as {
      reason?: string;
      initials?: string;
      meaning?: string;
    };
    if (!reason?.trim() || !initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "reason, initials, and meaning are all required to void (Part 11)." });
      return;
    }
    if (initials.trim().toUpperCase() !== (actor.initials ?? "").toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." });
      return;
    }
    const [existing] = await db.select().from(attachmentsTable).where(eq(attachmentsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Attachment not found." });
      return;
    }
    if (existing.status !== "Active") {
      res.status(400).json({ error: `Attachment is already ${existing.status}.` });
      return;
    }
    // Permission: uploader can void their own attachment; otherwise approver role required.
    const isUploader = existing.uploadedByUserId === actor.id;
    if (!isUploader && !APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({
        error: "Only the uploader or a Supervisor/Manager/Quality/Admin can void an attachment.",
      });
      return;
    }
    if (existing.parentTable === "documents" && existing.kind === "primary" && existing.documentRevisionSnapshot) {
      res.status(400).json({
        error: "Cannot void a primary file that is locked to an approved document revision. Issue a new revision instead.",
      });
      return;
    }
    const now = new Date();
    // TOCTOU-safe predicate: re-assert "still Active AND not locked" inside the
    // UPDATE so a concurrent approve→lock cannot lose the race.
    const [row] = await db
      .update(attachmentsTable)
      .set({
        status: "Voided",
        voidedAt: now,
        voidedByUserId: actor.id,
        voidedByName: actor.fullName,
        voidedReason: reason.trim(),
        voidedInitials: initials.trim().toUpperCase(),
        voidedMeaning: meaning.trim(),
        updatedAt: now,
      })
      .where(and(
        eq(attachmentsTable.id, id),
        eq(attachmentsTable.status, "Active"),
        isNull(attachmentsTable.documentRevisionSnapshot),
      ))
      .returning();
    if (!row) {
      res.status(409).json({ error: "Attachment state changed; refresh and try again." });
      return;
    }
    await logAudit(id, "VOID", actor,
      { status: "Active" },
      { status: "Voided", reason, initials, meaning });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to void attachment");
    res.status(500).json({ error: "Failed to void attachment" });
  }
});

/**
 * Lock all "primary" Active attachments on a Document to its revision when the
 * document is approved. Called from documents.ts/approve. Exported helper.
 *
 * Accepts an optional Drizzle tx so the caller can run the lock in the same
 * transaction as the document approval, making the two atomic. Each locked
 * row gets a LOCK audit entry so the Part 11 trail covers the snapshotting.
 */
export async function lockDocumentPrimaryAttachments(
  args: {
    documentId: number;
    revision: string;
    actor?: { id: number; fullName: string };
  },
  txArg?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number> {
  const exec = txArg ?? db;
  const { documentId, revision, actor } = args;
  const now = new Date();
  const rows = await exec
    .update(attachmentsTable)
    .set({ documentRevisionSnapshot: revision, updatedAt: now })
    .where(
      and(
        eq(attachmentsTable.parentTable, "documents"),
        eq(attachmentsTable.parentId, documentId),
        eq(attachmentsTable.kind, "primary"),
        eq(attachmentsTable.status, "Active"),
        isNull(attachmentsTable.documentRevisionSnapshot),
      ),
    )
    .returning();
  if (rows.length && actor) {
    await exec.insert(auditLogTable).values(
      rows.map((r) => ({
        tableName: "attachments",
        rowId: r.id,
        operation: "LOCK_TO_REVISION",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: { documentRevisionSnapshot: null } as never,
        afterState: { documentRevisionSnapshot: revision, documentId } as never,
      })),
    );
  }
  return rows.length;
}

export default router;
