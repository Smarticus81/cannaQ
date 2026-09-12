import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  trainingRecordsTable,
  usersTable,
  documentsTable,
  auditLogTable,
  DEPARTMENTS,
} from "@workspace/db";
import { and, count, eq, inArray, isNotNull, like, lt, ne, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { randomUUID } from "node:crypto";
import { supersedePriorRevisions, recordEffectiveRevision } from "../lib/documentRevisions";
import { facilityPrefix, nextForPrefix, numbersInUseEverywhere } from "../lib/recordNumber";
import { addBusinessDays, facilityDateStr, getFacilityTimeZone } from "../lib/facilityDate";

const router = Router();

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// Batch 6 — after a training record for a document is completed, promote the
// document to "Effective" once EVERY assigned trainee on the current revision is
// trained. Only an Approved doc flips (Effective/other statuses are left alone);
// a doc with no assigned training never auto-flips (those are marked Effective
// manually by Quality/Manager). Best-effort + idempotent: a promotion hiccup must
// never fail the training completion that triggered it.
async function maybeMarkDocumentEffective(
  documentId: number | null | undefined,
  actor: { id: number; fullName: string },
): Promise<void> {
  if (documentId == null) return;
  try {
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, documentId));
    if (!doc || doc.status !== "Approved") return;
    const records = await db
      .select()
      .from(trainingRecordsTable)
      .where(eq(trainingRecordsTable.documentId, documentId));
    // A Waived record is an explicit decision that this person does not need to
    // train on this revision, so it must not hold the document at Approved. A user
    // with BOTH a waived and an active record still counts through the active one.
    const forRev = records.filter(
      (r) =>
        r.documentRevisionSnapshot === doc.revision &&
        r.assignedToUserId != null &&
        r.status !== "Waived",
    );
    const assignedIds = new Set(forRev.map((r) => r.assignedToUserId as number));
    if (assignedIds.size === 0) return; // no training assigned -> manual mark only
    const trainedIds = new Set(
      forRev
        .filter((r) => r.status === "Completed" && r.signedAt !== null)
        .map((r) => r.assignedToUserId as number),
    );
    for (const uid of assignedIds) if (!trainedIds.has(uid)) return; // still someone untrained
    const now = new Date();
    const [updated] = await db
      .update(documentsTable)
      .set({ status: "Effective", effectiveDate: facilityDateStr(now), updatedAt: now })
      .where(and(eq(documentsTable.id, documentId), eq(documentsTable.status, "Approved")))
      .returning();
    if (!updated) return; // lost the race -- already flipped
    // The new revision is in force from this moment, so this is where the one it
    // replaces retires. Approval alone no longer supersedes anything (2026-08-26).
    const supersededRevision = await supersedePriorRevisions(documentId, doc.revision);
    await recordEffectiveRevision({
      documentId,
      doc: updated,
      trigger: "Came into force — everyone assigned completed their training.",
    });
    await db.insert(auditLogTable).values({
      tableName: "documents",
      rowId: documentId,
      operation: "EFFECTIVE",
      changedBy: actor.id,
      changedByName: actor.fullName,
      beforeState: { status: "Approved" } as never,
      afterState: { status: "Effective", trigger: "training-100%", effectiveDate: facilityDateStr(now), supersededRevision } as never,
    });
  } catch {
    // best-effort: swallow so the training completion still succeeds
  }
}

// Training type written for instructor-led retraining assignments. A record of this
// type is completed by the trainer's session sign-off (see the instructor-led-session
// route), NOT by the trainee acknowledging it themselves.
const INSTRUCTOR_LED_TYPE = "Instructor-Led Process Change";
function isInstructorLed(trainingType: string | null | undefined): boolean {
  return (trainingType ?? "") === INSTRUCTOR_LED_TYPE;
}

const DEPT_SET = new Set<string>(DEPARTMENTS);

// Training whose delivery type includes supervision needs a trainer competency
// co-sign in addition to the operator's acknowledgment before it can complete.
const SUPERVISION_TYPE = "Direct / Indirect Supervision";
function requiresTrainerCosign(trainingType: string | null | undefined): boolean {
  return (trainingType ?? "").includes(SUPERVISION_TYPE);
}

function invalidDepartments(departments: unknown): string | null {
  if (!Array.isArray(departments)) return "departments must be an array of strings.";
  const bad = departments.filter((d) => !DEPT_SET.has(String(d)));
  return bad.length ? `Invalid department(s): ${bad.join(", ")}` : null;
}

// Resolve the active users a training assignment should target. Priority:
// explicit userIds; otherwise everyone matching the selected role(s) (if any)
// whose departments overlap the selected departments (if given). Accepts either a
// single `role` (legacy) or a `roles` array; both are normalized to a role list
// and matched with IN. Overlap is computed in JS since a facility's user list is
// small.
async function resolveTargetUsers(opts: {
  userIds?: number[];
  role?: string;
  roles?: string[];
  departments?: string[];
}): Promise<(typeof usersTable.$inferSelect)[]> {
  if (Array.isArray(opts.userIds) && opts.userIds.length > 0) {
    return db
      .select()
      .from(usersTable)
      .where(and(inArray(usersTable.id, opts.userIds), eq(usersTable.active, true)));
  }
  const roleList =
    opts.roles && opts.roles.length > 0 ? opts.roles : opts.role ? [opts.role] : [];
  const rows = await db
    .select()
    .from(usersTable)
    .where(
      roleList.length > 0
        ? and(eq(usersTable.active, true), inArray(usersTable.role, roleList))
        : eq(usersTable.active, true),
    );
  if (opts.departments && opts.departments.length > 0) {
    const want = new Set(opts.departments);
    return rows.filter((u) => (u.departments ?? []).some((d) => want.has(d)));
  }
  return rows;
}

type Actor = { id: number; fullName: string; role: string; initials: string };

async function getActor(req: Request, res: Response): Promise<Actor | null> {
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentication required for this action." });
    return null;
  }
  const [user] = await db
    .select({
      id: usersTable.id,
      fullName: usersTable.fullName,
      role: usersTable.role,
      initials: usersTable.initials,
    })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user) {
    res.status(403).json({ error: "Your account is not linked to a CannaQMS user. Visit /users/me to provision." });
    return null;
  }
  return user;
}

async function logAudit(rowId: number, op: string, actor: Actor, before: unknown, after: unknown) {
  await db.insert(auditLogTable).values({
    tableName: "training_records",
    rowId,
    operation: op,
    changedBy: actor.id,
    changedByName: actor.fullName,
    beforeState: before as never,
    afterState: after as never,
  });
}

// A training record belongs to the plant the person was trained at, so its number
// carries that plant's code — TR-BA-26-0001.
//
// ⛔ AND IT IS NO LONGER COUNTED. count(*) only ever saw this site's records, so a
// second plant with no training would have counted zero and reached for TR-26-0001,
// which the first plant already holds — a failed save, in front of whoever was being
// signed off. Reading the highest number actually in use under this site's prefix is
// both collision-proof and immune to a deleted row compressing the sequence.
async function generateRecordNumber(): Promise<string> {
  const prefix = facilityPrefix("TR");
  // Across every site: the number must be unique in the whole database, so a number
  // that looks free here can still be taken at another plant.
  const used = await numbersInUseEverywhere("training_records", "record_number", prefix);
  return nextForPrefix(prefix, used);
}

function todayStr(): string {
  return facilityDateStr();
}

const TRAINING_RECNUM_LOCK = 7281001;

/**
 * Auto-create "Assigned" training records when a document is approved at a *new*
 * revision, for two audiences:
 *  1. RETRAIN — every user who completed training on the *prior* revision.
 *  2. INITIAL (2026-08-26, Jonathan) — every active user in the document's
 *     department(s) who never trained on it, so a new employee is not silently
 *     left untrained on a procedure that governs their work.
 * Idempotent: skips users who already have an active assignment for the new revision.
 * Returns the number of assignments created per audience.
 */
export async function autoAssignFromPriorRevision(args: {
  documentId: number;
  newRevision: string;
  priorRevision: string;
  docNumber: string;
  docTitle: string;
  docDescription: string | null;
  // The document's departments — its intended audience, so active members who have
  // never trained on it are assigned alongside those retraining. Null/empty means
  // no defined audience, and only prior-trained users are assigned.
  docDepartments: string[] | null;
  // Retraining method for this Major change. "Instructor-Led" writes assignments a
  // trainer completes via a session; anything else (incl. null) is self-serve
  // "Read & Understand" as before.
  method?: string | null;
  // 2026-08-27 — set when the document is being approved again after an
  // administrative rescind. The revision NUMBER has not changed, so the usual
  // "already trained on this revision" guard would refuse to reissue and the
  // re-approval would train nobody. Jonathan: void the incomplete records and
  // "start them all again". Completed records are left standing as the record of
  // the rescinded approval; this only stops them blocking a fresh assignment.
  reissueAfterRescind?: boolean;
  // 2026-08-27 — the document's DECLARED effective date, when it has one. Training
  // is due by the day the document goes live, not on a window of its own: that is
  // what makes On-Time Training mean anything. Falls back to the standard window
  // for documents approved before declared dates existed.
  dueDate?: string | null;
  actor: { id: number; fullName: string; role: string };
}): Promise<{ retrained: number; initial: number }> {
  const { documentId, newRevision, priorRevision, docNumber, docTitle, docDescription, docDepartments, method, reissueAfterRescind, dueDate: declaredDue, actor } = args;
  if (newRevision === priorRevision) return { retrained: 0, initial: 0 };
  const instructorLed = method === "Instructor-Led";

  // Find users whose Completed record on the prior revision means they need to retrain.
  const priorTrained = await db
    .selectDistinct({ userId: trainingRecordsTable.assignedToUserId })
    .from(trainingRecordsTable)
    .where(
      and(
        eq(trainingRecordsTable.documentId, documentId),
        eq(trainingRecordsTable.documentRevisionSnapshot, priorRevision),
        eq(trainingRecordsTable.status, "Completed"),
      ),
    );
  const priorIds = new Set(
    priorTrained.map((r) => r.userId).filter((u): u is number => typeof u === "number"),
  );

  const activeUsers = await db.select().from(usersTable).where(eq(usersTable.active, true));
  const retrainTargets = activeUsers.filter((u) => priorIds.has(u.id));
  const wantDepts = new Set((docDepartments ?? []).filter(Boolean));
  const initialTargets = wantDepts.size
    ? activeUsers.filter(
        (u) => !priorIds.has(u.id) && (u.departments ?? []).some((d) => wantDepts.has(d)),
      )
    : [];
  if (retrainTargets.length === 0 && initialTargets.length === 0) return { retrained: 0, initial: 0 };

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${TRAINING_RECNUM_LOCK})`);
    // Numbered from the highest number this site has actually used, not from a row
    // count: the count only sees this site's records, so a second plant would start
    // again at 0001 and collide with the first plant's numbers. The site code in the
    // prefix is what keeps the two runs apart. See lib/recordNumber.ts.
    const prefix = facilityPrefix("TR");
    const used = await numbersInUseEverywhere("training_records", "record_number", prefix);
    let nextSeq = parseInt(nextForPrefix(prefix, used).slice(-4), 10);
    const mkRecNum = () => `${prefix}${String(nextSeq++).padStart(4, "0")}`;

    const counts = { retrained: 0, initial: 0 };
    const targets = [
      ...retrainTargets.map((u) => ({ u, initial: false })),
      ...initialTargets.map((u) => ({ u, initial: true })),
    ];
    for (const { u, initial } of targets) {
      // Skip if user already has an active assignment for the new revision (defensive — re-runs are safe).
      const existing = await tx
        .select()
        .from(trainingRecordsTable)
        .where(
          and(
            eq(trainingRecordsTable.documentId, documentId),
            eq(trainingRecordsTable.assignedToUserId, u.id),
            eq(trainingRecordsTable.documentRevisionSnapshot, newRevision),
          ),
        );
      const blocking = reissueAfterRescind
        ? ["Assigned", "In Progress"]
        : ["Assigned", "In Progress", "Completed"];
      if (existing.some((r) => blocking.includes(r.status))) {
        continue;
      }
      // An assignment on this revision that was waived stays waived — a re-run
      // must not resurrect a decision someone already made.
      if (existing.some((r) => r.status === "Waived")) {
        continue;
      }
      const [rec] = await tx
        .insert(trainingRecordsTable)
        .values({
          recordNumber: mkRecNum(),
          employeeName: u.fullName,
          employeeId: String(u.id),
          department: null,
          trainingType: instructorLed ? INSTRUCTOR_LED_TYPE : "Process Change",
          topic: initial
            ? `${docNumber} ${docTitle} (Rev ${newRevision} — training required, new to this document${instructorLed ? ", instructor-led" : ""})`
            : `${docNumber} ${docTitle} (Rev ${newRevision} — re-training required${instructorLed ? ", instructor-led" : ""})`,
          description: docDescription ?? null,
          documentReference: docNumber,
          assignedDate: todayStr(),
          dueDate: declaredDue ?? dueInBusinessDays(TRAINING_DUE_BUSINESS_DAYS),
          status: "Assigned",
          createdByName: actor.fullName,
          assignedToUserId: u.id,
          documentId,
          documentRevisionSnapshot: newRevision,
          acknowledgmentText: initial
            ? `Document ${docNumber} "${docTitle}" is now at rev ${newRevision}. I have not previously trained on this document. I have read and understand this revision and agree to comply with its requirements.`
            : `Document ${docNumber} "${docTitle}" has been revised from rev ${priorRevision} to rev ${newRevision}. I have read and understand the new revision and agree to comply with its requirements.`,
        })
        .returning();
      await tx.insert(auditLogTable).values({
        tableName: "training_records",
        rowId: rec.id,
        operation: "AUTO_ASSIGN_REVISION",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: null as never,
        afterState: {
          documentId,
          docNumber,
          priorRevision,
          newRevision,
          assignedToUserId: u.id,
          employeeName: u.fullName,
          reason: initial
            ? "auto-assign department member new to this document on revision"
            : "auto-retrain on document revision",
        } as never,
      });
      if (initial) counts.initial += 1;
      else counts.retrained += 1;
    }
    return counts;
  });

  return created;
}

// Training window (Jonathan, 2026-08-26, superseding the 7 calendar days set on
// 08-25): "Users are given 10 business days to complete the training, then the
// document should become Effective (or when everyone has completed training)."
// Counted in working days so a Friday approval does not spend a third of its
// window on a weekend. Auto-assigned training used to be created with dueDate
// null, so it could never go Overdue and never showed on the My Training tile;
// it now gets a real clock from the day it is assigned.
const TRAINING_DUE_BUSINESS_DAYS = 10;

// Document training is given a working-day window, not a calendar one: a revision
// approved on a Friday must not spend two of its days on a weekend when nobody is
// on site. Weekends and US federal holidays are both skipped (2026-08-27) — see
// lib/facilityDate.ts.
function dueInBusinessDays(days: number): string {
  // Working days counted on the FACILITY's calendar, not the server's. Both the
  // starting day and "is this a weekend" have to be answered where the people
  // are — see lib/facilityDate.ts.
  return addBusinessDays(days);
}

function applyOverdue<T extends { status: string; dueDate: string | null }>(r: T): T {
  const today = todayStr();
  if ((r.status === "Assigned" || r.status === "In Progress") && r.dueDate && r.dueDate < today) {
    return { ...r, status: "Overdue" };
  }
  return r;
}

router.get("/training", async (req, res) => {
  try {
    const rows = await db.select().from(trainingRecordsTable).orderBy(trainingRecordsTable.createdAt);
    const result = rows.map(applyOverdue);
    const { status, type, employee } = req.query;
    let filtered = result.reverse();
    if (status) filtered = filtered.filter((r) => r.status === status);
    if (type) filtered = filtered.filter((r) => r.trainingType === type);
    if (employee) {
      const q = (employee as string).toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.employeeName.toLowerCase().includes(q) ||
          (r.employeeId ?? "").toLowerCase().includes(q),
      );
    }
    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Failed to list training records");
    res.status(500).json({ error: "Failed to list training records" });
  }
});

// "My Training" — pending + overdue assignments for the current user
router.get("/training/my", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const rows = await db
      .select()
      .from(trainingRecordsTable)
      .where(eq(trainingRecordsTable.assignedToUserId, actor.id))
      .orderBy(trainingRecordsTable.dueDate);
    const result = rows.map(applyOverdue);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to list my training");
    res.status(500).json({ error: "Failed to list my training" });
  }
});

router.post("/training", async (req, res) => {
  try {
    const recordNumber = await generateRecordNumber();
    const [record] = await db
      .insert(trainingRecordsTable)
      .values({ ...req.body, recordNumber })
      .returning();
    res.status(201).json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to create training record");
    res.status(500).json({ error: "Failed to create training record" });
  }
});

// Record a COMPLETED instructor-led GROUP training in one entry (Manager+):
// writes a "Completed" training record for every selected attendee. Attendees
// resolve like assignment does - explicit userIds, or a role and/or departments.
// Skips a user who already has a Completed record for the same topic + date so a
// double-submit cannot duplicate.
router.post("/training/record-group", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can record group training." });
      return;
    }
    const { topic, trainingType, trainerName, completedDate, notes, userIds, role, departments, supervisedTaskQty } = req.body as {
      topic?: string; trainingType?: string; trainerName?: string; completedDate?: string;
      notes?: string; userIds?: number[]; role?: string; departments?: string[]; supervisedTaskQty?: number | null;
    };
    if (!topic?.trim() || !trainingType?.trim() || !completedDate) {
      res.status(400).json({ error: "topic, trainingType, and completedDate are required." }); return;
    }
    if (departments) { const dErr = invalidDepartments(departments); if (dErr) { res.status(400).json({ error: dErr }); return; } }
    const users = await resolveTargetUsers({ userIds, role, departments });
    if (users.length === 0) {
      res.status(400).json({ error: "No matching active users to record training for." }); return;
    }
    let created = 0, skipped = 0;
    for (const u of users) {
      const existing = await db.select({ id: trainingRecordsTable.id })
        .from(trainingRecordsTable)
        .where(and(
          eq(trainingRecordsTable.assignedToUserId, u.id),
          eq(trainingRecordsTable.topic, topic.trim()),
          eq(trainingRecordsTable.completedDate, completedDate),
          eq(trainingRecordsTable.status, "Completed"),
        ));
      if (existing.length > 0) { skipped++; continue; }
      const recordNumber = await generateRecordNumber();
      await db.insert(trainingRecordsTable).values({
        recordNumber,
        employeeName: u.fullName,
        assignedToUserId: u.id,
        department: (u.departments ?? [])[0] ?? null,
        trainingType: trainingType.trim(),
        topic: topic.trim(),
        trainerName: trainerName?.trim() || null,
        assignedDate: completedDate,
        completedDate,
        status: "Completed",
        supervisedTaskQty: supervisedTaskQty ?? null,
        notes: notes?.trim() || null,
        createdByName: actor.fullName,
      });
      created++;
    }
    res.status(201).json({ created, skipped, total: users.length });
  } catch (err) {
    req.log.error({ err }, "Failed to record group training");
    res.status(500).json({ error: "Failed to record group training" });
  }
});

// Bulk assign a document for training to a list of users (Manager+ only)
router.post("/training/assign-document", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can assign training." });
      return;
    }
    const { documentId, documentIds, userIds, role, roles, departments, dueDate, acknowledgmentText, trainingType, supervisedTaskQty } = req.body as {
      documentId?: number;
      documentIds?: number[];
      userIds?: number[];
      role?: string;
      roles?: string[];
      departments?: string[];
      dueDate?: string;
      acknowledgmentText?: string;
      trainingType?: string;
      supervisedTaskQty?: number | null;
    };
    // Accept a single documentId (legacy) or a documentIds[] array (bulk / onboarding).
    const docIdList =
      Array.isArray(documentIds) && documentIds.length > 0
        ? Array.from(new Set(documentIds))
        : documentId
          ? [documentId]
          : [];
    if (docIdList.length === 0) {
      res.status(400).json({ error: "Provide documentId or documentIds[]." });
      return;
    }
    const hasTarget =
      (Array.isArray(userIds) && userIds.length > 0) ||
      (typeof role === "string" && role.length > 0) ||
      (Array.isArray(roles) && roles.length > 0) ||
      (Array.isArray(departments) && departments.length > 0);
    if (!hasTarget) {
      res.status(400).json({ error: "Provide userIds[], or role(s) and/or departments to target." });
      return;
    }
    if (departments !== undefined) {
      const deptErr = invalidDepartments(departments);
      if (deptErr) { res.status(400).json({ error: deptErr }); return; }
    }
    const docs = await db.select().from(documentsTable).where(inArray(documentsTable.id, docIdList));
    if (docs.length !== docIdList.length) {
      res.status(404).json({ error: "One or more selected documents were not found." });
      return;
    }
    const notReleased = docs.filter((d) => d.status !== "Approved" && d.status !== "Effective");
    if (notReleased.length > 0) {
      res.status(400).json({
        error: `These documents are not Approved/Effective and can't be assigned: ${notReleased.map((d) => d.docNumber).join(", ")}. Approve them first.`,
      });
      return;
    }
    const targetUsers = await resolveTargetUsers({ userIds, role, roles, departments });
    if (targetUsers.length === 0) {
      res.status(400).json({ error: "No active users match the selected person/role/departments." });
      return;
    }

    // Wrap in a transaction with a Postgres advisory lock so concurrent bulk-assigns
    // can't generate duplicate `record_number` values via the count(*)+1 pattern.
    // Assigns every selected document to every targeted user (docs × users).
    const { created, updated, skipped } = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${TRAINING_RECNUM_LOCK})`);
      // Same reasoning as the other numbering paths: the highest number this site
      // has used, not a row count, because the count only sees this site's records.
      const prefix = facilityPrefix("TR");
      const used = await numbersInUseEverywhere("training_records", "record_number", prefix);
      let nextSeq = parseInt(nextForPrefix(prefix, used).slice(-4), 10);
      const mkRecNum = () => `${prefix}${String(nextSeq++).padStart(4, "0")}`;

      const createdLocal: typeof trainingRecordsTable.$inferSelect[] = [];
      const updatedLocal: typeof trainingRecordsTable.$inferSelect[] = [];
      const skippedLocal: { userId: number; documentId: number; reason: string }[] = [];

      for (const doc of docs) {
        for (const u of targetUsers) {
          const existing = await tx
            .select()
            .from(trainingRecordsTable)
            .where(
              and(
                eq(trainingRecordsTable.documentId, doc.id),
                eq(trainingRecordsTable.assignedToUserId, u.id),
              ),
            );
          const stillCurrent = existing.find(
            (r) =>
              r.documentRevisionSnapshot === doc.revision &&
              (r.status === "Assigned" || r.status === "In Progress" || r.status === "Completed"),
          );
          if (stillCurrent) {
            // The person already has this revision. Assigning again used to skip
            // outright, which silently threw away a due date the assigner had just
            // set — the usual case being retraining auto-created at approval with no
            // date, then someone opening Training Coverage to give it one. Apply the
            // date to the record that exists rather than dropping it. A Completed
            // record is left alone: dating finished training changes nothing.
            const canRedate =
              !!dueDate &&
              stillCurrent.dueDate !== dueDate &&
              (stillCurrent.status === "Assigned" || stillCurrent.status === "In Progress");
            if (canRedate) {
              const [redated] = await tx
                .update(trainingRecordsTable)
                .set({ dueDate })
                .where(eq(trainingRecordsTable.id, stillCurrent.id))
                .returning();
              updatedLocal.push(redated);
              await tx.insert(auditLogTable).values({
                tableName: "training_records",
                rowId: stillCurrent.id,
                operation: "UPDATE",
                changedBy: actor.id,
                changedByName: actor.fullName,
                beforeState: { dueDate: stillCurrent.dueDate } as never,
                afterState: { dueDate, reason: "Due date set from Assign Training" } as never,
              });
            } else {
              skippedLocal.push({ userId: u.id, documentId: doc.id, reason: `Already assigned (${stillCurrent.recordNumber})` });
            }
            continue;
          }
          const [rec] = await tx
            .insert(trainingRecordsTable)
            .values({
              recordNumber: mkRecNum(),
              employeeName: u.fullName,
              employeeId: String(u.id),
              department: null,
              trainingType: trainingType ?? "Document Training",
              topic: `${doc.docNumber} ${doc.title} (Rev ${doc.revision})`,
              description: doc.description ?? null,
              documentReference: doc.docNumber,
              assignedDate: todayStr(),
              // 2026-08-27 — a manual assignment with no date used to be created with
              // dueDate null, and a record with no clock can never go Overdue, never
              // appears on anyone's My Training tile and is never chased. Assigning
              // training that nobody is ever asked to complete is worse than not
              // assigning it. Left blank it now gets the same 10-working-day window
              // the system gives itself at approval; an explicit date still wins.
              dueDate: dueDate ?? dueInBusinessDays(TRAINING_DUE_BUSINESS_DAYS),
              status: "Assigned",
              supervisedTaskQty: supervisedTaskQty ?? null,
              createdByName: actor.fullName,
              assignedToUserId: u.id,
              documentId: doc.id,
              documentRevisionSnapshot: doc.revision,
              acknowledgmentText:
                acknowledgmentText ??
                `I have read and understand ${doc.docNumber} "${doc.title}" revision ${doc.revision} and agree to comply with its requirements.`,
            })
            .returning();
          createdLocal.push(rec);
          await tx.insert(auditLogTable).values({
            tableName: "training_records",
            rowId: rec.id,
            operation: "ASSIGN",
            changedBy: actor.id,
            changedByName: actor.fullName,
            beforeState: null as never,
            afterState: {
              documentId: doc.id,
              docNumber: doc.docNumber,
              revision: doc.revision,
              assignedToUserId: u.id,
              employeeName: u.fullName,
            } as never,
          });
        }
      }
      return { created: createdLocal, updated: updatedLocal, skipped: skippedLocal };
    });

    res.status(201).json({
      assigned: created.length,
      updated: updated.length,
      skipped: skipped.length,
      documents: docs.length,
      people: targetUsers.length,
      records: created,
      updatedRecords: updated,
      skippedDetails: skipped,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to assign document training");
    res.status(500).json({ error: "Failed to assign document training" });
  }
});

// Preview who a role × departments assignment would hit, before committing.
router.post("/training/assign-preview", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin can assign training." });
      return;
    }
    const { role, roles, departments } = req.body as { role?: string; roles?: string[]; departments?: string[] };
    if (departments !== undefined) {
      const deptErr = invalidDepartments(departments);
      if (deptErr) { res.status(400).json({ error: deptErr }); return; }
    }
    const hasRole = (typeof role === "string" && role.length > 0) || (Array.isArray(roles) && roles.length > 0);
    if (!hasRole && !(Array.isArray(departments) && departments.length > 0)) {
      res.status(400).json({ error: "Provide role(s) and/or departments to preview." });
      return;
    }
    const users = await resolveTargetUsers({ role, roles, departments });
    res.json({
      count: users.length,
      users: users.map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, departments: u.departments })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to preview training assignment");
    res.status(500).json({ error: "Failed to preview training assignment" });
  }
});

router.get("/training/stats", async (req, res) => {
  try {
    const today = todayStr();
    // 2026-08-27 — a Cancelled assignment is a voided one (the approval that issued
    // it was rescinded). It is kept as a record but it is not work anyone owes, so it
    // can never be Overdue and it must not drag the completion rate down.
    const [total, completed, overdue, cancelled, withDeadline, onTime] = await Promise.all([
      db.select({ cnt: count() }).from(trainingRecordsTable),
      db.select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(eq(trainingRecordsTable.status, "Completed")),
      db.select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(
          and(
            ne(trainingRecordsTable.status, "Completed"),
            ne(trainingRecordsTable.status, "Waived"),
            ne(trainingRecordsTable.status, "Cancelled"),
            lt(trainingRecordsTable.dueDate, today),
          ),
        ),
      db.select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(eq(trainingRecordsTable.status, "Cancelled")),
      // 2026-08-27 — ON-TIME TRAINING. Jonathan: "The Effective date is the timeline
      // each person / facility has to get people trained… the on-time training metric
      // will show they suck at On-Time Training. Its up to Mgt to take action."
      //
      // Measured only over training that HAD a deadline and was completed: a record
      // with no due date cannot be late, and one still open is not yet either. Signed
      // ON the due date counts as on time — the deadline is a day, not an instant.
      db.select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(and(
          eq(trainingRecordsTable.status, "Completed"),
          isNotNull(trainingRecordsTable.dueDate),
          isNotNull(trainingRecordsTable.signedAt),
        )),
      db.select({ cnt: count() })
        .from(trainingRecordsTable)
        .where(and(
          eq(trainingRecordsTable.status, "Completed"),
          isNotNull(trainingRecordsTable.dueDate),
          isNotNull(trainingRecordsTable.signedAt),
          sql`(${trainingRecordsTable.signedAt} AT TIME ZONE ${getFacilityTimeZone()})::date <= ${trainingRecordsTable.dueDate}`,
        )),
    ]);
    res.json({
      total: Number(total[0]?.cnt ?? 0),
      completed: Number(completed[0]?.cnt ?? 0),
      overdue: Number(overdue[0]?.cnt ?? 0),
      cancelled: Number(cancelled[0]?.cnt ?? 0),
      // Null rather than 0% when nothing has been measured yet — a facility that has
      // completed no dated training has not scored badly, it has no score.
      onTimeCompleted: Number(onTime[0]?.cnt ?? 0),
      completedWithDeadline: Number(withDeadline[0]?.cnt ?? 0),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get training stats");
    res.status(500).json({ error: "Failed to get training stats" });
  }
});

// Coverage report: for a given document, who's trained on the current revision vs not
router.get("/training/document/:docId/coverage", async (req, res) => {
  try {
    const docId = parseInt(req.params.docId);
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const records = await db
      .select()
      .from(trainingRecordsTable)
      .where(eq(trainingRecordsTable.documentId, docId));

    // Find users who have a Completed ack on the CURRENT revision
    const currentlyTrainedUserIds = new Set(
      records
        .filter(
          (r) =>
            r.status === "Completed" &&
            r.documentRevisionSnapshot === doc.revision &&
            r.signedAt !== null,
        )
        .map((r) => r.assignedToUserId)
        .filter((u): u is number => u !== null),
    );

    // The document's department audience: active members of its department(s), who
    // are assigned training when a revision is approved even without prior training.
    // Returned so the approval preview can show the real head-count up front.
    const deptList = (doc.departments?.length ? doc.departments : doc.department ? [doc.department] : []).filter(Boolean);
    let departmentAudienceUserIds: number[] = [];
    if (deptList.length) {
      const want = new Set(deptList);
      const activeUsers = await db
        .select({ id: usersTable.id, departments: usersTable.departments })
        .from(usersTable)
        .where(eq(usersTable.active, true));
      departmentAudienceUserIds = activeUsers
        .filter((u) => (u.departments ?? []).some((d) => want.has(d)))
        .map((u) => u.id);
    }

    res.json({
      document: { id: doc.id, docNumber: doc.docNumber, title: doc.title, revision: doc.revision, status: doc.status },
      currentlyTrainedUserIds: Array.from(currentlyTrainedUserIds),
      departmentAudienceUserIds,
      records: records.map(applyOverdue).sort((a, b) =>
        (b.assignedDate ?? "").localeCompare(a.assignedDate ?? ""),
      ),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get document training coverage");
    res.status(500).json({ error: "Failed to get document training coverage" });
  }
});

router.get("/training/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [record] = await db.select().from(trainingRecordsTable).where(eq(trainingRecordsTable.id, id));
    if (!record) {
      res.status(404).json({ error: "Training record not found" });
      return;
    }
    res.json(applyOverdue(record));
  } catch (err) {
    req.log.error({ err }, "Failed to get training record");
    res.status(500).json({ error: "Failed to get training record" });
  }
});

// Acknowledge — Part 11 e-sig completion. Must be the assigned user OR an admin/manager
// (e.g. for in-person training the trainer signs on behalf of the employee).
router.post("/training/:id/acknowledge", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, meaning, score, notes } = req.body as {
      initials?: string;
      meaning?: string;
      score?: number;
      notes?: string;
    };
    if (!initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "Signature initials and meaning are required (Part 11)." });
      return;
    }
    if (score !== undefined && score !== null) {
      if (typeof score !== "number" || Number.isNaN(score) || score < 0 || score > 100) {
        res.status(400).json({ error: "Score must be a number between 0 and 100." });
        return;
      }
    }
    const [record] = await db.select().from(trainingRecordsTable).where(eq(trainingRecordsTable.id, id));
    if (!record) {
      res.status(404).json({ error: "Training record not found" });
      return;
    }
    if (record.status === "Completed") {
      res.status(409).json({ error: "Training is already acknowledged." });
      return;
    }
    if (record.status === "Waived") {
      res.status(409).json({ error: "This record has been waived and cannot be acknowledged." });
      return;
    }
    // Authorization: assignee OR an approver-role user (trainer-attests)
    const isAssignee = record.assignedToUserId === actor.id;
    const isApprover = APPROVER_ROLES.has(actor.role);
    if (!isAssignee && !isApprover) {
      res.status(403).json({ error: "Only the assigned trainee or a Supervisor+ can acknowledge this record." });
      return;
    }
    // Instructor-led retraining is completed by the trainer's session sign-off, not by
    // the trainee acknowledging on their own. A trainee (non-approver) is blocked here;
    // an approver may still sign (e.g. one-off make-up), which the session route uses.
    if (isInstructorLed(record.trainingType) && !isApprover) {
      res.status(403).json({ error: "This is instructor-led training — your trainer records completion in a training session." });
      return;
    }
    // For supervision training the operator acknowledgment and the trainer co-sign
    // must be two different people. The trainer-sign route already blocks this when
    // the operator signs first; this guards the reverse order (trainer signed first,
    // then the same person tries to acknowledge as the operator).
    if (record.trainerSignedByUserId && record.trainerSignedByUserId === actor.id) {
      res.status(403).json({ error: "The operator acknowledgment and the trainer co-sign must be different people." });
      return;
    }
    // Verify the signed initials match the actor's stored initials (second-factor identity)
    if (initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({
        error: `Initials must match your account initials ("${actor.initials}"). This is a Part 11 identity check.`,
      });
      return;
    }
    // If passing score is required, enforce it
    if (record.passingScore !== null && record.passingScore !== undefined) {
      if (score === undefined || score === null) {
        res.status(400).json({ error: `A score is required to acknowledge (passing score: ${record.passingScore}).` });
        return;
      }
      if (score < record.passingScore) {
        res.status(400).json({
          error: `Score ${score} is below the passing score ${record.passingScore}. Cannot mark complete.`,
        });
        return;
      }
    }

    const before = { ...record };
    const signedAt = new Date();
    // Supervision training needs a trainer co-sign too. If this record requires it
    // and no trainer has signed yet, the operator's acknowledgment is recorded but
    // the record stays "In Progress" (awaiting the trainer) rather than Completed.
    const needsTrainer = requiresTrainerCosign(record.trainingType);
    const trainerSigned = record.trainerSignedByUserId !== null && record.trainerSignedByUserId !== undefined;
    const willComplete = !needsTrainer || trainerSigned;
    const [updated] = await db
      .update(trainingRecordsTable)
      .set({
        status: willComplete ? "Completed" : "In Progress",
        completedDate: willComplete ? todayStr() : null,
        signedInitials: initials.trim().toUpperCase(),
        signedMeaning: meaning.trim(),
        signedAt,
        signedByUserId: actor.id,
        signedByFullName: actor.fullName,
        score: score ?? record.score,
        notes: notes ?? record.notes,
        updatedAt: new Date(),
      })
      .where(eq(trainingRecordsTable.id, id))
      .returning();
    await logAudit(id, "ACKNOWLEDGE", actor, before, updated);
    if (updated.status === "Completed" && updated.documentId != null) {
      await maybeMarkDocumentEffective(updated.documentId, actor);
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to acknowledge training");
    res.status(500).json({ error: "Failed to acknowledge training" });
  }
});

// Trainer competency co-sign (Part 11) — only for supervision training. The trainer
// attests the operator is competent. Supervisor+ only, must differ from the operator
// (the assignee and the operator-ack signer), and the record completes only once the
// operator has also acknowledged.
router.post("/training/:id/trainer-sign", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, meaning } = req.body as { initials?: string; meaning?: string };
    if (!initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "Signature initials and meaning are required (Part 11)." });
      return;
    }
    const [record] = await db.select().from(trainingRecordsTable).where(eq(trainingRecordsTable.id, id));
    if (!record) {
      res.status(404).json({ error: "Training record not found" });
      return;
    }
    if (!requiresTrainerCosign(record.trainingType)) {
      res.status(400).json({ error: "This training type does not require a trainer co-sign." });
      return;
    }
    if (record.status === "Completed") {
      res.status(409).json({ error: "Training is already completed." });
      return;
    }
    if (record.status === "Waived") {
      res.status(409).json({ error: "This record has been waived and cannot be signed." });
      return;
    }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only a Supervisor, Manager, Quality, or Admin can provide the trainer co-sign." });
      return;
    }
    // The trainer must be someone other than the operator being signed off.
    if (record.assignedToUserId === actor.id || record.signedByUserId === actor.id) {
      res.status(403).json({ error: "The trainer co-sign must be a different person from the operator." });
      return;
    }
    if (initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({
        error: `Initials must match your account initials ("${actor.initials}"). This is a Part 11 identity check.`,
      });
      return;
    }
    const before = { ...record };
    // Complete only if the operator has already acknowledged; otherwise hold In Progress.
    const operatorSigned = record.signedByUserId !== null && record.signedByUserId !== undefined;
    const [updated] = await db
      .update(trainingRecordsTable)
      .set({
        status: operatorSigned ? "Completed" : "In Progress",
        completedDate: operatorSigned ? todayStr() : null,
        trainerSignedInitials: initials.trim().toUpperCase(),
        trainerSignedMeaning: meaning.trim(),
        trainerSignedAt: new Date(),
        trainerSignedByUserId: actor.id,
        trainerSignedByFullName: actor.fullName,
        updatedAt: new Date(),
      })
      .where(eq(trainingRecordsTable.id, id))
      .returning();
    await logAudit(id, "TRAINER_SIGN", actor, before, updated);
    if (updated.status === "Completed" && updated.documentId != null) {
      await maybeMarkDocumentEffective(updated.documentId, actor);
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to record trainer co-sign");
    res.status(500).json({ error: "Failed to record trainer co-sign" });
  }
});

// Update — restricted: cannot bypass Part 11 by setting status=Completed via PATCH.
// Use /:id/acknowledge for Part 11 completion.
router.patch("/training/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body: Record<string, unknown> = { ...req.body, updatedAt: new Date() };
    if (body.status === "Completed") {
      res.status(400).json({
        error: "Cannot set status=Completed via PATCH. Use POST /training/:id/acknowledge to capture the Part 11 e-signature.",
      });
      return;
    }
    // Block direct manipulation of signature, document-link, and assignment columns via PATCH —
    // these can only change through dedicated workflow endpoints.
    for (const k of [
      "signedInitials",
      "signedMeaning",
      "signedAt",
      "signedByUserId",
      "signedByFullName",
      "trainerSignedInitials",
      "trainerSignedMeaning",
      "trainerSignedAt",
      "trainerSignedByUserId",
      "trainerSignedByFullName",
      "documentId",
      "documentRevisionSnapshot",
      "acknowledgmentText",
      "assignedToUserId",
      "recordNumber",
    ]) {
      delete body[k];
    }
    const [record] = await db
      .update(trainingRecordsTable)
      .set(body)
      .where(eq(trainingRecordsTable.id, id))
      .returning();
    if (!record) {
      res.status(404).json({ error: "Training record not found" });
      return;
    }
    res.json(record);
  } catch (err) {
    req.log.error({ err }, "Failed to update training record");
    res.status(500).json({ error: "Failed to update training record" });
  }
});

// Instructor-led retraining SESSION (Part 11). A trainer (Supervisor+) records ONE
// session for a document: pick the roster, sign once as trainer, optionally attach a
// scanned paper sign-in sheet. Every attendee gets their own Completed record — the
// existing "owed" instructor-led assignment is completed if present, otherwise a new
// completed record is created — and all records share one trainingSessionId so the UI
// rolls the sign-offs up as a single event. The trainer's signature attests each
// attendee (signs-on-behalf, as the acknowledge route documents), so coverage credits
// the trainee. Idempotent: an attendee already Completed on this revision is skipped.
router.post("/training/document/:docId/instructor-led-session", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only a Supervisor, Manager, Quality, or Admin can record an instructor-led training session." });
      return;
    }
    const docId = parseInt(req.params.docId);
    const { initials, meaning, completedDate, userIds, attachmentId, notes } = req.body as {
      initials?: string; meaning?: string; completedDate?: string;
      userIds?: number[]; attachmentId?: number | null; notes?: string;
    };
    if (!initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "Trainer signature initials and meaning are required (Part 11)." });
      return;
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ error: "Select at least one attendee for the session." });
      return;
    }
    // Part 11 identity check — the signed initials must match the trainer's account.
    if (!actor.initials || initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: `Initials must match your account initials ("${actor.initials ?? ""}"). This is a Part 11 identity check.` });
      return;
    }
    const date = completedDate || todayStr();
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
    if (!doc) { res.status(404).json({ error: "Document not found." }); return; }

    const attendees = await db
      .select()
      .from(usersTable)
      .where(and(inArray(usersTable.id, userIds), eq(usersTable.active, true)));
    if (attendees.length === 0) {
      res.status(400).json({ error: "No matching active users to record training for." });
      return;
    }

    const sessionId = `TS-${new Date().getFullYear().toString().slice(-2)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const signedAt = new Date();
    const trainerFields = {
      status: "Completed" as const,
      completedDate: date,
      signedInitials: initials.trim().toUpperCase(),
      signedMeaning: meaning.trim(),
      signedAt,
      signedByUserId: actor.id,
      signedByFullName: actor.fullName,
      trainerName: actor.fullName,
      trainingSessionId: sessionId,
      sessionAttachmentId: attachmentId ?? null,
      notes: notes?.trim() || null,
      updatedAt: new Date(),
    };

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${TRAINING_RECNUM_LOCK})`);
      // Same reasoning as the other numbering paths: the highest number this site
      // has used, not a row count, because the count only sees this site's records.
      const prefix = facilityPrefix("TR");
      const used = await numbersInUseEverywhere("training_records", "record_number", prefix);
      let nextSeq = parseInt(nextForPrefix(prefix, used).slice(-4), 10);
      const mkRecNum = () => `${prefix}${String(nextSeq++).padStart(4, "0")}`;

      let completed = 0, created = 0, skipped = 0;
      for (const u of attendees) {
        const existing = await tx
          .select()
          .from(trainingRecordsTable)
          .where(and(
            eq(trainingRecordsTable.documentId, docId),
            eq(trainingRecordsTable.assignedToUserId, u.id),
            eq(trainingRecordsTable.documentRevisionSnapshot, doc.revision),
          ));
        if (existing.some((r) => r.status === "Completed")) { skipped++; continue; }
        const open = existing.find((r) => r.status === "Assigned" || r.status === "In Progress" || r.status === "Overdue");
        if (open) {
          const [upd] = await tx
            .update(trainingRecordsTable)
            .set(trainerFields)
            .where(eq(trainingRecordsTable.id, open.id))
            .returning();
          await tx.insert(auditLogTable).values({
            tableName: "training_records", rowId: upd.id, operation: "INSTRUCTOR_LED_COMPLETE",
            changedBy: actor.id, changedByName: actor.fullName,
            beforeState: { status: open.status } as never,
            afterState: { sessionId, docId, revision: doc.revision, attendee: u.fullName } as never,
          });
          completed++;
        } else {
          const [rec] = await tx
            .insert(trainingRecordsTable)
            .values({
              recordNumber: mkRecNum(),
              employeeName: u.fullName,
              employeeId: String(u.id),
              department: (u.departments ?? [])[0] ?? null,
              trainingType: INSTRUCTOR_LED_TYPE,
              topic: `${doc.docNumber} ${doc.title} (Rev ${doc.revision} — instructor-led training)`,
              description: doc.description ?? null,
              documentReference: doc.docNumber,
              assignedDate: date,
              assignedToUserId: u.id,
              documentId: docId,
              documentRevisionSnapshot: doc.revision,
              acknowledgmentText: `Instructor-led training on ${doc.docNumber} "${doc.title}" rev ${doc.revision}, attested by the trainer.`,
              createdByName: actor.fullName,
              ...trainerFields,
            })
            .returning();
          await tx.insert(auditLogTable).values({
            tableName: "training_records", rowId: rec.id, operation: "INSTRUCTOR_LED_COMPLETE",
            changedBy: actor.id, changedByName: actor.fullName,
            beforeState: null as never,
            afterState: { sessionId, docId, revision: doc.revision, attendee: u.fullName, created: true } as never,
          });
          created++;
        }
      }
      return { completed, created, skipped };
    });

    await maybeMarkDocumentEffective(docId, actor);

    res.status(201).json({ sessionId, documentId: docId, revision: doc.revision, attendees: attendees.length, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to record instructor-led training session");
    res.status(500).json({ error: "Failed to record instructor-led training session" });
  }
});

export default router;
