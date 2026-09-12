import { db } from "@workspace/db";
import { documentRevisionsTable, documentsTable, trainingRecordsTable, auditLogTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Document } from "@workspace/db";
import { resolveChangeRequestsOnEffective } from "../routes/document_change_requests";

/**
 * Retire the revision a document has just replaced.
 *
 * Jonathan, 2026-08-26: "the previous version should never have been superseded
 * until the new document is Effective." A revision that has been approved but is
 * still waiting on training has not replaced anything yet — the old revision is
 * what the floor is working to, and it stays in force until the new one takes
 * over. This also means rescinding an approval has nothing to undo.
 *
 * Called from every path that puts a revision into force, and only from those:
 *   - training completion flipping the document to Effective
 *   - a Manager/Quality/Admin releasing it by hand
 *   - approval of a revision that needs no training, which is Effective at once
 *
 * Only the prior revision's most recent Approved/Effective record is flipped, so
 * the earlier records stay as the events they were and the history still reads
 * Draft → Approved → Effective → Superseded rather than collapsing into one row.
 *
 * `runner` accepts a transaction so a caller already inside one supersedes in the
 * same commit as the status change; it defaults to the shared connection.
 */
export async function supersedePriorRevisions(
  documentId: number,
  currentRevision: string,
  runner: Pick<typeof db, "select" | "update"> = db,
): Promise<string | null> {
  const [priorRow] = await runner
    .select()
    .from(documentRevisionsTable)
    .where(
      and(
        eq(documentRevisionsTable.documentId, documentId),
        ne(documentRevisionsTable.revision, currentRevision),
        inArray(documentRevisionsTable.status, ["Approved", "Effective"]),
      ),
    )
    .orderBy(desc(documentRevisionsTable.createdAt))
    .limit(1);
  if (!priorRow) return null;
  await runner
    .update(documentRevisionsTable)
    .set({ status: "Superseded" })
    .where(eq(documentRevisionsTable.id, priorRow.id));
  return priorRow.revision;
}

/**
 * Record the day a revision came into force.
 *
 * Revision history had no row for it. The `Effective` row only ever appeared when
 * the NEXT revision was started, because /new-revision snapshots whatever status
 * the outgoing revision happened to hold — so a document that had been in force for
 * a year, and never revised since, showed a history ending at "Approved". The one
 * date an inspector asks for ("which revision was in force on the day this batch
 * ran, and from when") was the one date not written down.
 *
 * Called from the three paths that put a revision into force, beside
 * supersedePriorRevisions: training completing, a manual release, and approval of a
 * revision that needs no training.
 *
 * Idempotent — a revision cannot come into force twice, and a duplicate row would
 * make the history read as though it had.
 */
export async function recordEffectiveRevision(args: {
  documentId: number;
  doc: Pick<Document, "revision" | "effectiveDate" | "approvedByName" | "approvalDate" | "createdByName" | "ownerName" | "reviewerSignedName" | "reviewerSignedAt" | "summaryOfChanges" | "changeSeverity" | "retrainingMethod">;
  /** What put it into force, for the row's summary line. */
  trigger: string;
  runner?: Pick<typeof db, "select" | "insert">;
}): Promise<boolean> {
  const { documentId, doc, trigger } = args;
  const runner = args.runner ?? db;
  const existing = await runner
    .select()
    .from(documentRevisionsTable)
    .where(
      and(
        eq(documentRevisionsTable.documentId, documentId),
        eq(documentRevisionsTable.revision, doc.revision),
        eq(documentRevisionsTable.status, "Effective"),
      ),
    );
  if (existing.length > 0) return false;

  // Phase 3 (2026-08-28): a change request that was approved is answered by THIS
  // moment — the revision it asked for is now what the floor works to. Clearing the
  // marker here rather than at approval is the same reasoning as superseding here:
  // until the new revision is in force, nothing has actually changed.
  await resolveChangeRequestsOnEffective(documentId, doc.revision).catch(() => undefined);
  await runner.insert(documentRevisionsTable).values({
    documentId,
    revision: doc.revision,
    status: "Effective",
    summaryOfChanges: trigger,
    changeSeverity: doc.changeSeverity,
    retrainingMethod: doc.retrainingMethod,
    authorName: doc.createdByName ?? doc.ownerName,
    reviewerName: doc.reviewerSignedName,
    reviewerSignedAt: doc.reviewerSignedAt,
    approvedByName: doc.approvedByName,
    approvalDate: doc.approvalDate,
    effectiveDate: doc.effectiveDate,
    createdAt: new Date(),
  });
  return true;
}

/**
 * Put every approved revision whose declared effective date has arrived into force.
 *
 * Jonathan, 2026-08-27: "It's just train people by this date, this is when it's going
 * live. So, it doesn't really depend on training." The date is declared at review or
 * approval, and the document goes live on it whether or not everyone finished — the
 * floor gate stops untrained work and the On-Time Training metric records who was
 * late. Management acts; the software makes it visible.
 *
 * Run on a schedule and again at boot, so a date that arrived while the server was
 * down is not silently skipped. Documents approved before declared dates existed
 * carry no planned date and are left to the old training-completion path.
 */
export async function releaseDueDocuments(today: string): Promise<{ released: number }> {
  const due = await db
    .select()
    .from(documentsTable)
    .where(and(
      eq(documentsTable.status, "Approved"),
      isNull(documentsTable.cancelledAt),
      isNotNull(documentsTable.plannedEffectiveDate),
      lte(documentsTable.plannedEffectiveDate, today),
    ));

  let released = 0;
  for (const doc of due) {
    const now = new Date();
    const [updated] = await db
      .update(documentsTable)
      .set({ status: "Effective", effectiveDate: doc.plannedEffectiveDate, updatedAt: now })
      .where(and(eq(documentsTable.id, doc.id), eq(documentsTable.status, "Approved")))
      .returning();
    if (!updated) continue; // someone released or rescinded it first

    const superseded = await supersedePriorRevisions(doc.id, doc.revision);
    await recordEffectiveRevision({
      documentId: doc.id,
      doc: updated,
      trigger: "Came into force on its declared effective date.",
    });

    const open = await db
      .select()
      .from(trainingRecordsTable)
      .where(and(
        eq(trainingRecordsTable.documentId, doc.id),
        eq(trainingRecordsTable.documentRevisionSnapshot, doc.revision),
      ));
    const untrained = open.filter(
      (r) => r.assignedToUserId != null && r.status !== "Waived" && r.status !== "Cancelled" &&
        !(r.status === "Completed" && r.signedAt !== null),
    );

    await db.insert(auditLogTable).values({
      tableName: "documents",
      rowId: doc.id,
      operation: "EFFECTIVE",
      changedBy: null,
      changedByName: "System",
      beforeState: { status: "Approved" } as never,
      afterState: {
        status: "Effective",
        trigger: "declared effective date reached",
        effectiveDate: doc.plannedEffectiveDate,
        supersededRevision: superseded,
        // Named on the record, because "who was late" is the point of the deadline.
        outstandingTrainees: untrained.length,
        outstandingNames: untrained.map((r) => r.employeeName),
      } as never,
    });
    released += 1;
  }
  return { released };
}
