import { pgTable, serial, text, integer, date, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — ⛔ NULL MEANS CORPORATE. SOPs are written
  // once for the company and go to every site (his ruling 08-27: "Corporate
  // documents go to each state"); a Work Instruction is how ONE plant does the job
  // and carries its facility. This is the one table that is deliberately both.
  facilityId: integer("facility_id"),
  docNumber: text("doc_number").notNull().unique(),
  title: text("title").notNull(),
  documentType: text("document_type").notNull(),
  revision: text("revision").notNull().default("1"),
  status: text("status").notNull().default("Draft"),
  ownerName: text("owner_name"),
  department: text("department"),
  // Multi-department support (2026-07-31). A document can belong to several
  // departments; `departments` is the source of truth and `department` (single) is
  // kept in sync with the first entry for legacy readers. text[] like usersTable.departments.
  departments: text("departments").array(),
  description: text("description"),
  scope: text("scope"),

  // Starter document library (2026-07-21): a readable on-screen body (markdown)
  // for SOP/Policy/Manual documents, rendered read-only in the document viewer.
  // Purpose -> description, Scope -> scope, the rest of the procedure -> here.
  bodyMarkdown: text("body_markdown"),
  // Flags a document that belongs to the pre-approved starter set seeded into a
  // new facility. The whole set is identifiable and REMOVABLE (Admin) if the
  // facility brings its own documents. Null/false = a normal facility document.
  isStarterDefault: boolean("is_starter_default").notNull().default(false),

  // Hybrid doc<->process bridge (2026-06-07): a document can OPTIONALLY be
  // backed by a recipe/process. When set, the document's "process_steps" section
  // renders from this recipe's recipe_process_steps — single source of truth (the
  // same steps the operator executes on a batch). Null = standalone policy doc.
  // Soft link (no FK constraint), matching the specDocId convention on batches.
  recipeId: integer("recipe_id"),

  effectiveDate: date("effective_date"),
  reviewDate: date("review_date"),
  approvedByName: text("approved_by_name"),
  approvalDate: date("approval_date"),
  summaryOfChanges: text("summary_of_changes"),
  // Review rounds within the CURRENT change cycle (0 = not yet sent for review).
  // Displayed as the ".x" after the whole revision number; resets each new revision.
  reviewRound: integer("review_round").notNull().default(0),
  changeSeverity: text("change_severity"),
  // Retraining method for a Major change (2026-07-31). Chosen by the author when a
  // change is marked Major; editable while the doc is in Draft, then locks.
  //   "Read & Understand" (default) — self-serve: each prior-rev trainee gets an
  //     assignment they acknowledge themselves in the app.
  //   "Instructor-Led" — a trainer runs one session, picks the roster, and signs
  //     once as trainer; every attendee's record is completed under that session.
  // Null on Minor changes / legacy docs → treated as "Read & Understand".
  retrainingMethod: text("retraining_method"),
  createdByName: text("created_by_name"),
  createdByUserId: integer("created_by_user_id"),

  assignedReviewerId: integer("assigned_reviewer_id"),
  assignedReviewerName: text("assigned_reviewer_name"),
  assignedApproverId: integer("assigned_approver_id"),
  assignedApproverName: text("assigned_approver_name"),

  reviewerSignedAt: timestamp("reviewer_signed_at", { withTimezone: true }),
  reviewerSignedName: text("reviewer_signed_name"),
  reviewerSignedInitials: text("reviewer_signed_initials"),
  reviewerSignedMeaning: text("reviewer_signed_meaning"),

  approverSignedAt: timestamp("approver_signed_at", { withTimezone: true }),
  approverSignedInitials: text("approver_signed_initials"),
  approverSignedMeaning: text("approver_signed_meaning"),
  // 2026-08-09 — recipe-backed work instructions: the approver confirms the
  // backing recipe reflects this revision before release. A check, not a forced
  // edit (many updates don't touch the recipe). Records the confirmation time
  // and which recipe version was current at approval.
  recipeConfirmedAt: timestamp("recipe_confirmed_at", { withTimezone: true }),
  recipeConfirmedVersion: integer("recipe_confirmed_version"),
  // 2026-08-25 - the author's answer to "does this revision require a recipe
  // update?", asked when the revision is STARTED (the author knows what changed;
  // the approver's recipeConfirmed tick above is the terminal check). Advisory
  // only - many document changes never touch the recipe - but it surfaces a
  // notice on the linked recipe. Cleared on approval.
  recipeUpdateFlagged: boolean("recipe_update_flagged").notNull().default(false),

  reviewIntervalYears: integer("review_interval_years").notNull().default(3),
  nextReviewDate: date("next_review_date"),
  // 2026-08-27 — THE DECLARED EFFECTIVE DATE. Jonathan: "It's just train people by this
  // date, this is when its going live. So, it doesn't really depend on training."
  //
  // The day this revision goes into force, agreed between the reviewer and the
  // approver and set when one of them signs. It replaces the old behaviour where a
  // document flipped itself Effective the moment the last person finished training —
  // the date is now DECLARED, and training is measured against it rather than
  // gating it. `effectiveDate` still records the day it actually went into force.
  //
  // Null on documents approved before this existed; those keep the old behaviour.
  plannedEffectiveDate: date("planned_effective_date"),

  obsoletedAt: timestamp("obsoleted_at", { withTimezone: true }),
  obsoletedByName: text("obsoleted_by_name"),
  obsoletedMeaning: text("obsoleted_meaning"),

  // Session 52 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires
  // a Part 11 e-signature from a Manager/Quality/Admin plus a rationale.
  // Cancel is allowed only while the document is pre-effective (Draft / In
  // Review / Approved); an Effective or Obsolete document cannot be cancelled.
  // All nullable; null = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),

  // 2026-08-27 — ADMINISTRATIVE RESCIND OF AN APPROVAL (Admin/Quality).
  // Jonathan's rule: an administrative move NEVER clears or overwrites a signature.
  // The reviewer/approver signatures collected for the rescinded round stay exactly
  // where they are; these fields only carry the notice shown at the top of the
  // document page until it reaches its next normal state. They are a banner, not a
  // record — the record is the document_revisions row and the audit entry.
  rescindedAt: timestamp("rescinded_at", { withTimezone: true }),
  rescindedReason: text("rescinded_reason"),
  rescindedByName: text("rescinded_by_name"),
  rescindedToStatus: text("rescinded_to_status"),
  // Which administrative move produced the notice above — the banner heading reads
  // from this, so a rescind and a reinstatement do not have to share wording.
  // Null on rows written before 2026-08-27 (treated as an approval rescind).
  rescindedAction: text("rescinded_action"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const documentRevisionsTable = pgTable("document_revisions", {
  id: serial("id").primaryKey(),
  documentId: serial("document_id").notNull().references(() => documentsTable.id, { onDelete: "cascade" }),
  revision: text("revision").notNull(),
  status: text("status").notNull(),
  summaryOfChanges: text("summary_of_changes"),
  changeSeverity: text("change_severity"),
  // Snapshot of the retraining method that was in effect for this revision.
  retrainingMethod: text("retraining_method"),
  authorName: text("author_name"),
  reviewerName: text("reviewer_name"),
  reviewerSignedAt: timestamp("reviewer_signed_at", { withTimezone: true }),
  approvedByName: text("approved_by_name"),
  approvalDate: date("approval_date"),
  effectiveDate: date("effective_date"),
  obsoletedAt: timestamp("obsoleted_at", { withTimezone: true }),
  obsoletedByName: text("obsoleted_by_name"),
  // 2026-08-27 — the permanent record of an ADMINISTRATIVE move. A rescind writes
  // its own row here rather than editing the row the approval wrote: history reads
  // forward (signed, rescinded, signed again) and nothing is overwritten.
  adminAction: text("admin_action"),
  adminReason: text("admin_reason"),
  adminByName: text("admin_by_name"),
  adminByInitials: text("admin_by_initials"),
  adminMeaning: text("admin_meaning"),
  // 2026-08-25 — RETENTION OF THE SUPERSEDED REVISION ITSELF.
  //
  // A document lives in ONE `documents` row, edited in place, so starting Rev 2
  // overwrites the sections that held Rev 1. This table recorded that a revision
  // existed — author, approver, dates — but never what it SAID, so the usual
  // investigation ("find the revision effective on the batch date and read it")
  // had nothing to open. 21 CFR 211.180(e) and ISO 13485 4.2.5 want the superseded
  // version retained, not merely a note that there was one.
  //
  // Written by /approve onto the row that approval already inserts: that signed act
  // is what made the content controlled, so it is the right moment to freeze it.
  // Draft states are deliberately NOT snapshotted — they never governed anything.
  // Mirrors the spec snapshot batches already keep (see batch_records).
  contentSnapshot: jsonb("content_snapshot").$type<{
    header: Record<string, unknown>;
    sections: Array<{
      id: number; sortOrder: number; kind: string; title: string;
      bodyMarkdown: string | null; data: unknown;
    }>;
    process: {
      recipeId: number | null; recipeName: string | null; recipeVersion: number | null;
      steps: Array<{ id: number; stepNumber: number; description: string; template: string | null }>;
    } | null;
  }>(),
  contentSnapshotAt: timestamp("content_snapshot_at", { withTimezone: true }),
  // "approval" — frozen by the approver's signature (the real evidence).
  // "backfill" — captured later from live content by the one-time admin sweep, for
  // revisions approved before this existed. Labelled so nobody mistakes the two.
  contentSnapshotSource: text("content_snapshot_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  id: true,
  docNumber: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
export type DocumentRevision = typeof documentRevisionsTable.$inferSelect;
