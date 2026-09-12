import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { complaintsTable } from "./complaints";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

// Session 74 — METRC Tag Lineage Phase 2 (complaint traceability).
//
// A complaint often CANNOT be tied to a single batch at intake: the METRC tag is
// torn off the label, the package was thrown away, or there are two lots of the
// same strain and we don't yet know which one the product came from. So a
// complaint links to ZERO, ONE, or SEVERAL candidate batches, and the
// INVESTIGATION narrows them down:
//
//   • suspected  — surfaced by the tag/lot/product lookup and attached at intake
//                  (or added later). The default state.
//   • confirmed  — the investigation determined THIS is the source batch. When a
//                  row is confirmed, complaints.batch_id is set to it (the single
//                  "official" link the rest of the app already understands).
//   • ruled_out  — the investigation excluded this candidate. Kept (not deleted)
//                  so the reasoning trail survives (Part 11).
//
// A complaint can still be CLOSED with no confirmed candidate — sometimes the
// info the customer gives us simply isn't enough to identify a lot. Nothing here
// forces a link.
//
// match_basis records HOW the candidate was found (audit/usability context):
//   tag_exact | tag_partial | product | manual.
export const complaintCandidateBatchesTable = pgTable("complaint_candidate_batches", {
  id: serial("id").primaryKey(),
  complaintId: integer("complaint_id").notNull().references(() => complaintsTable.id, { onDelete: "cascade" }),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id),
  // suspected | confirmed | ruled_out
  status: text("status").notNull().default("suspected"),
  // tag_exact | tag_partial | product | manual
  matchBasis: text("match_basis").notNull().default("manual"),
  // The identifier the user actually typed (the tag fragment / lot / product),
  // captured verbatim so the trail shows what we matched on.
  enteredValue: text("entered_value"),
  // Free-text investigator note (e.g. "ruled out — production date predates the
  // complaint", or "confirmed via remaining partial tag on returned packaging").
  note: text("note"),
  // Part 11 attribution — WHO attached / resolved this candidate.
  recordedByUserId: integer("recorded_by_user_id").references(() => usersTable.id),
  recordedByName: text("recorded_by_name"),
  // Set when status moves to confirmed/ruled_out.
  resolvedByUserId: integer("resolved_by_user_id").references(() => usersTable.id),
  resolvedByName: text("resolved_by_name"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertComplaintCandidateBatchSchema = createInsertSchema(complaintCandidateBatchesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type ComplaintCandidateBatch = typeof complaintCandidateBatchesTable.$inferSelect;
export type InsertComplaintCandidateBatch = z.infer<typeof insertComplaintCandidateBatchSchema>;
