import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

// DOCUMENT CHANGE REQUESTS — multi-facility Phase 3 (2026-08-28).
//
// "This document is wrong, and here is why." Raised by anyone, at any site, against
// a document that is in force. Quality rules on it. Only then does a revision start.
//
// ⛔ THE DOCUMENT IS NOT TOUCHED. His correction to my first draft, 08-27:
//   "The current document remains and the change request remains until an approver
//    approves the request. Then it can go to draft for revision."
// A document in force is never left sitting in Draft because somebody asked a
// question about it. That is why this is its own record and not a flag on the
// document, and why I could not keep my earlier promise of "no new record types" —
// there is no revision yet to carry the request, and a DECLINED request outlives one.
//
// ⛔ A DECLINE IS KEPT. His words: "We cannot really get rid of records. I want us to
// be compliant for when we need it to be compliant." Declining ends the request; it
// does not delete it.
//
// The document's own status never changes because of this record. What the document
// shows beside its status is a MARKER derived from here — Change Requested, then
// Change Request Approved — and a marker is not a seventh lifecycle status: a status
// would leak into every list, filter and gate, and would have a document in force
// reporting itself as something other than Effective. See [[document-lifecycle]].
export const documentChangeRequestsTable = pgTable("document_change_requests", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id")
    .notNull()
    .references(() => documentsTable.id, { onDelete: "cascade" }),

  // Where it was raised. Requests follow the pattern he set for NCs and CAPAs:
  // raised at a facility, visible company-wide — a plant reporting that a corporate
  // SOP is wrong is exactly the case this exists for, and hiding that from the other
  // sites would defeat it. So the facility is recorded, not used to filter.
  facilityId: integer("facility_id"),

  // The revision the person was actually looking at. Without it, a request read six
  // weeks later is about a document that may have moved on twice.
  revisionAtRequest: text("revision_at_request"),

  whatIsWrong: text("what_is_wrong").notNull(),
  whyItMatters: text("why_it_matters"),

  // Open → Approved | Declined, and Approved → Resolved when the revision it asked
  // for comes into force. This is the REQUEST's own state; it says nothing about the
  // document's status.
  status: text("status").notNull().default("Open"),

  raisedByUserId: integer("raised_by_user_id"),
  raisedByName: text("raised_by_name"),
  raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),

  decidedByUserId: integer("decided_by_user_id"),
  decidedByName: text("decided_by_name"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // Required in both directions. An approval without a reason is an instruction with
  // no rationale, and a decline without one is the thing people escalate over.
  decisionReason: text("decision_reason"),

  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByRevision: text("resolved_by_revision"),
});

export const insertDocumentChangeRequestSchema = createInsertSchema(documentChangeRequestsTable).omit({
  id: true,
  raisedAt: true,
});
export type InsertDocumentChangeRequest = z.infer<typeof insertDocumentChangeRequestSchema>;
export type DocumentChangeRequest = typeof documentChangeRequestsTable.$inferSelect;
