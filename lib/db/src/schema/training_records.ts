import { pgTable, serial, text, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { documentsTable } from "./documents";

export const trainingRecordsTable = pgTable("training_records", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  recordNumber: text("record_number").notNull().unique(),
  employeeName: text("employee_name").notNull(),
  employeeId: text("employee_id"),
  department: text("department"),
  trainingType: text("training_type").notNull(),
  topic: text("topic").notNull(),
  description: text("description"),
  documentReference: text("document_reference"),
  trainerName: text("trainer_name"),
  assignedDate: date("assigned_date").notNull(),
  dueDate: date("due_date"),
  completedDate: date("completed_date"),
  status: text("status").notNull().default("Assigned"),
  score: integer("score"),
  passingScore: integer("passing_score"),
  // Number of tasks the supervisor observed the operator perform. Only relevant
  // when the training type includes "Direct / Indirect Supervision"; the facility
  // decides how many tasks warrant sign-off, so this is an open, nullable count.
  supervisedTaskQty: integer("supervised_task_qty"),
  notes: text("notes"),
  createdByName: text("created_by_name"),

  // Instructor-led retraining session grouping (2026-07-31). When a Major change's
  // retraining method is "Instructor-Led", one trainer session completes many
  // records at once; every record it produces shares this session id so the UI can
  // roll ~30 sign-offs up as a single event. Null = not part of an instructor-led
  // session (self-serve / individual record).
  trainingSessionId: text("training_session_id"),
  // Optional scanned paper sign-in sheet for the session (attachment id). Evidence
  // only; a session is valid without it.
  sessionAttachmentId: integer("session_attachment_id"),

  // Acknowledgment workflow (Part 11 §11.50, §11.200)
  assignedToUserId: integer("assigned_to_user_id").references(() => usersTable.id),
  documentId: integer("document_id").references(() => documentsTable.id),
  documentRevisionSnapshot: text("document_revision_snapshot"),
  acknowledgmentText: text("acknowledgment_text"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signedByUserId: integer("signed_by_user_id").references(() => usersTable.id),
  signedByFullName: text("signed_by_full_name"),

  // Trainer competency co-sign (Part 11) — for "Direct / Indirect Supervision"
  // training, the trainer attests the operator is competent. Such a record only
  // reaches "Completed" once BOTH the operator's acknowledgment (signed_* above)
  // and this trainer co-sign are present, and the two signers must be different
  // people. Other training types complete on the single acknowledgment as before.
  trainerSignedInitials: text("trainer_signed_initials"),
  trainerSignedMeaning: text("trainer_signed_meaning"),
  trainerSignedAt: timestamp("trainer_signed_at", { withTimezone: true }),
  trainerSignedByUserId: integer("trainer_signed_by_user_id").references(() => usersTable.id),
  trainerSignedByFullName: text("trainer_signed_by_full_name"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTrainingRecordSchema = createInsertSchema(trainingRecordsTable).omit({
  id: true,
  recordNumber: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTrainingRecord = z.infer<typeof insertTrainingRecordSchema>;
export type TrainingRecord = typeof trainingRecordsTable.$inferSelect;
