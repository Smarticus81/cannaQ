import { Router } from "express";
import { db } from "@workspace/db";
import { documentChangeRequestsTable, documentsTable, usersTable, auditLogTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getAuth } from "@clerk/express";

// DOCUMENT CHANGE REQUESTS — multi-facility Phase 3 (2026-08-28).
//
// The flow, in his words and his order: anyone at any facility raises a request →
// the document is untouched and no draft exists → Quality approves or declines with
// a reason → only on approval does a revision start → normal flow from there.
//
// ⛔ NOTHING HERE TOUCHES THE DOCUMENT. Not its status, not its assignment, not its
// revision. The only thing the document gains is a MARKER, and that is derived by
// reading this table rather than stored on the document — so there is no second copy
// of the fact to drift out of step, and no seventh lifecycle status leaking into
// every list and filter in the app.
const router = Router();

// Ruling on a change request is a Quality judgement about a controlled document.
// Admin is included because Admin can act anywhere; Manager is not, deliberately —
// he said Quality, and widening it is his call to make, not mine.
const DECIDE_ROLES = new Set(["Quality", "Admin"]);

// A request can only be raised against a document that is IN FORCE. A draft is
// already being edited — the way to change it is to edit it — and a document under
// review is mid-decision. Raising a request against either would be asking for a
// change to something nobody has agreed to yet.
const IN_FORCE = ["Approved", "Effective"];

// The two live states. Anything else is finished: a decline stops there, and a
// resolved request has been answered by a revision that is now in force.
const LIVE_STATUSES = ["Open", "Approved"];

type Actor = { id: number; fullName: string; role: string };

async function getActor(req: import("express").Request): Promise<Actor | null> {
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) return null;
  const [user] = await db
    .select({ id: usersTable.id, fullName: usersTable.fullName, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  return user ?? null;
}

/**
 * The marker a document shows beside its status, derived from the live request.
 * Null when there is none — which is the ordinary case for most documents.
 */
export function markerFor(status: string | null | undefined): "Change Requested" | "Change Request Approved" | null {
  if (status === "Open") return "Change Requested";
  if (status === "Approved") return "Change Request Approved";
  return null;
}

/** The live change request for each of the given documents, keyed by document id. */
export async function liveChangeRequestsFor(documentIds: number[]) {
  if (documentIds.length === 0) return new Map<number, typeof documentChangeRequestsTable.$inferSelect>();
  const rows = await db
    .select()
    .from(documentChangeRequestsTable)
    .where(
      and(
        inArray(documentChangeRequestsTable.documentId, documentIds),
        inArray(documentChangeRequestsTable.status, LIVE_STATUSES),
      ),
    );
  return new Map(rows.map((r) => [r.documentId, r]));
}

/**
 * Close out approved requests once the revision they asked for is in force.
 *
 * Called from the one place that records a revision coming into force, so the marker
 * clears at the same moment the new document takes effect — not at approval, when the
 * floor is still working to the old one.
 */
export async function resolveChangeRequestsOnEffective(documentId: number, revision: string): Promise<number> {
  const rows = await db
    .update(documentChangeRequestsTable)
    .set({ status: "Resolved", resolvedAt: new Date(), resolvedByRevision: revision })
    .where(
      and(
        eq(documentChangeRequestsTable.documentId, documentId),
        eq(documentChangeRequestsTable.status, "Approved"),
      ),
    )
    .returning();
  return rows.length;
}

// GET /documents/:id/change-requests — every request ever raised, newest first.
router.get("/documents/:id/change-requests", async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(documentId)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const rows = await db
      .select()
      .from(documentChangeRequestsTable)
      .where(eq(documentChangeRequestsTable.documentId, documentId))
      .orderBy(desc(documentChangeRequestsTable.raisedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list change requests");
    res.status(500).json({ error: "Failed to list change requests" });
  }
});

// GET /change-requests?status=Open — the Quality queue.
router.get("/change-requests", async (req, res) => {
  try {
    const status = String(req.query.status ?? "");
    const rows = await db
      .select({
        request: documentChangeRequestsTable,
        docNumber: documentsTable.docNumber,
        title: documentsTable.title,
        documentStatus: documentsTable.status,
      })
      .from(documentChangeRequestsTable)
      .leftJoin(documentsTable, eq(documentsTable.id, documentChangeRequestsTable.documentId))
      .where(status ? eq(documentChangeRequestsTable.status, status) : inArray(documentChangeRequestsTable.status, LIVE_STATUSES))
      .orderBy(desc(documentChangeRequestsTable.raisedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list change requests");
    res.status(500).json({ error: "Failed to list change requests" });
  }
});

// POST /documents/:id/change-requests — raise one. Anyone signed in, any facility.
router.post("/documents/:id/change-requests", async (req, res) => {
  try {
    const actor = await getActor(req);
    if (!actor) {
      res.status(401).json({ error: "Authentication required for this action." });
      return;
    }
    const documentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(documentId)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, documentId));
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (doc.cancelledAt) {
      res.status(409).json({ error: "This document is cancelled." });
      return;
    }
    if (!IN_FORCE.includes(doc.status)) {
      res.status(409).json({
        error: `A change request can only be raised against a document that is in force. This one is ${doc.status} — it is already being worked on.`,
      });
      return;
    }

    const whatIsWrong = String((req.body ?? {}).whatIsWrong ?? "").trim();
    if (!whatIsWrong) {
      res.status(400).json({ error: "Say what is wrong with the document." });
      return;
    }
    const whyItMatters = String((req.body ?? {}).whyItMatters ?? "").trim() || null;

    const [live] = await db
      .select()
      .from(documentChangeRequestsTable)
      .where(
        and(
          eq(documentChangeRequestsTable.documentId, documentId),
          inArray(documentChangeRequestsTable.status, LIVE_STATUSES),
        ),
      );
    if (live) {
      // Not an error the person did anything wrong — they are told what is already
      // open, so they can add to it rather than start a parallel queue.
      res.status(409).json({
        error:
          live.status === "Open"
            ? `A change request is already open on this document, raised by ${live.raisedByName ?? "someone"}.`
            : "A change request has already been approved on this document and a revision is expected.",
        existing: live,
      });
      return;
    }

    const [created] = await db
      .insert(documentChangeRequestsTable)
      .values({
        documentId,
        revisionAtRequest: doc.revision,
        whatIsWrong,
        whyItMatters,
        status: "Open",
        raisedByUserId: actor.id,
        raisedByName: actor.fullName,
      })
      .returning();

    await db.insert(auditLogTable).values({
      tableName: "document_change_requests",
      rowId: created.id,
      operation: "CHANGE_REQUEST_RAISED",
      changedBy: actor.id,
      changedByName: actor.fullName,
      beforeState: null,
      afterState: { documentId, docNumber: doc.docNumber, revision: doc.revision, whatIsWrong },
    });

    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to raise a change request");
    res.status(500).json({ error: "Failed to raise a change request" });
  }
});

// POST /change-requests/:id/decide — Quality approves or declines, with a reason.
router.post("/change-requests/:id/decide", async (req, res) => {
  try {
    const actor = await getActor(req);
    if (!actor) {
      res.status(401).json({ error: "Authentication required for this action." });
      return;
    }
    if (!DECIDE_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Quality can approve or decline a change request." });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const decision = String((req.body ?? {}).decision ?? "");
    if (decision !== "approve" && decision !== "decline") {
      res.status(400).json({ error: 'decision must be "approve" or "decline".' });
      return;
    }
    // Required in both directions: an approval without a rationale is an instruction
    // nobody can trace, and a decline without one is what people escalate over.
    const reason = String((req.body ?? {}).reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "Give a reason for the decision." });
      return;
    }

    const [existing] = await db
      .select()
      .from(documentChangeRequestsTable)
      .where(eq(documentChangeRequestsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Change request not found" });
      return;
    }
    if (existing.status !== "Open") {
      res.status(409).json({ error: `This change request has already been ${existing.status.toLowerCase()}.` });
      return;
    }

    const [updated] = await db
      .update(documentChangeRequestsTable)
      .set({
        status: decision === "approve" ? "Approved" : "Declined",
        decidedByUserId: actor.id,
        decidedByName: actor.fullName,
        decidedAt: new Date(),
        decisionReason: reason,
      })
      .where(eq(documentChangeRequestsTable.id, id))
      .returning();

    await db.insert(auditLogTable).values({
      tableName: "document_change_requests",
      rowId: id,
      operation: decision === "approve" ? "CHANGE_REQUEST_APPROVED" : "CHANGE_REQUEST_DECLINED",
      changedBy: actor.id,
      changedByName: actor.fullName,
      beforeState: { status: existing.status },
      afterState: { status: updated.status, reason },
    });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to decide a change request");
    res.status(500).json({ error: "Failed to decide a change request" });
  }
});

export default router;
