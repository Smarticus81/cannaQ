import { pgTable, serial, text, integer, date, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { suppliersTable } from "./suppliers";
import { usersTable } from "./users";
import { destructionRecordsTable } from "./destruction_records";
import { incomingInspectionsTable } from "./incoming_inspections";
import { complaintsTable } from "./complaints";
import { inventoryItemsTable } from "./inventory";
import { lotsTable } from "./lots";
import { documentsTable } from "./documents";

export const nonConformancesTable = pgTable("non_conformances", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  ncNumber: text("nc_number").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull(),
  // Session 48 — free-text rationale that justifies the severity classification.
  // Nullable for legacy rows; surfaced on the NC detail page next to severity.
  severityRationale: text("severity_rationale"),
  status: text("status").notNull().default("Open"),
  source: text("source").notNull(),
  // Session 48 — explicit "date the issue was identified" (vs createdAt which
  // is when the record was entered). Different things in practice — an
  // operator may have spotted an off-spec event yesterday but only logged it
  // today. Nullable for legacy rows and for cases where the date is unknown.
  identifiedAt: date("identified_at"),
  // Session 48 — who originally opened the NC. The non_conformances route
  // already had this in its NC_CREATE_ALLOWED set but the column was missing,
  // so the field was being accepted-and-dropped silently. Adding the column
  // closes the bug.
  reportedByName: text("reported_by_name"),
  // Session 54 — id of the app user who reported the NC. "Reported By" on an NC
  // is always an internal user with system access (decision B: strict picker),
  // so this is the canonical reference; reportedByName mirrors it for display.
  // Nullable for legacy rows created before the migration (id = null until re-saved).
  reportedByUserId: integer("reported_by_user_id").references(() => usersTable.id),
  // Session 101 — NC Owner: the person accountable for driving the NC to
  // closure, distinct from Reported By (who merely logged it). Nullable for
  // legacy rows; set/edited on the NC detail Overview from a user picker.
  ownerUserId: integer("owner_user_id").references(() => usersTable.id),
  ownerName: text("owner_name"),
  batchId: integer("batch_id").references(() => batchRecordsTable.id),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  // Session 97 (cross-linking Slice 4) — link an NC to the SPECIFIC origin record
  // when its Source is a system record, not just the category enum. Mirrors the
  // Field Actions source pattern: source = "Incoming Inspection" -> sourceInspectionId,
  // source = "Customer Complaint" -> sourceComplaintId. Both nullable (legacy rows +
  // sources like Audit / Environmental Monitoring that have no record table yet).
  sourceInspectionId: integer("source_inspection_id").references(() => incomingInspectionsTable.id),
  sourceComplaintId: integer("source_complaint_id").references(() => complaintsTable.id),
  disposition: text("disposition"),

  // Session 49 — when disposition is "Destroy", the NC links to a METRC
  // destruction record. Many NCs can point at the same record (one METRC
  // destruction tag covers many destroyed batches in Michigan). Nullable —
  // only set for Destroy dispositions that have been recorded.
  destructionRecordId: integer("destruction_record_id").references(() => destructionRecordsTable.id),

  // Use-As-Is disposition requires Supervisor+ Part 11 sign-off. These
  // mirror the row whenever the disposition is approved as Use-As-Is;
  // the audit log retains full history.
  useAsIsApproverName: text("use_as_is_approver_name"),
  useAsIsApproverInitials: text("use_as_is_approver_initials"),
  useAsIsApproverMeaning: text("use_as_is_approver_meaning"),
  useAsIsApprovedAt: timestamp("use_as_is_approved_at", { withTimezone: true }),
  // Session 101 — free-text justification for releasing nonconforming product
  // under a Use-As-Is disposition (why the material is acceptable despite the
  // NC). Captured at the Use-As-Is transition alongside the Part 11 sign-off;
  // distinct from the signer's "meaning" statement. Required by the route.
  useAsIsRationale: text("use_as_is_rationale"),

  rootCause: text("root_cause"),
  // Structured multi-select picks for metrics. Free-text rootCause above
  // remains for the narrative RCA write-up.
  rootCauses: text("root_causes").array(),

  // Session 48 — Major/Critical NCs typically escalate to CAPA. When they
  // don't (e.g., the cause is fully addressed by immediate corrections and
  // no preventive action is warranted), the QMS owner must record WHY no
  // CAPA was opened. Server enforces this at closure when severity is in
  // (Major, Critical) AND no linked CAPA exists. Nullable for Minor NCs and
  // for Major/Critical NCs that DO have a linked CAPA.
  skipCapaRationale: text("skip_capa_rationale"),

  // Session 60 — what the NC is ABOUT: "Product" or "Process". A SECOND axis,
  // orthogonal to `source` above: source is where the issue was CAUGHT (receiving,
  // in-process, audit...), type is what it turned out to concern.
  //
  // Two of them on purpose. An NC often starts life as a product problem and the
  // investigation lands on a process cause — Jonathan's case was cartridges that
  // met spec where the SPEC was wrong. Recording only the final answer loses how
  // it came in; recording only the initial one loses what it really was. Holding
  // both is what makes "we FIND product issues but they are mostly caused by
  // process" a measurable statement.
  //
  // asFound is required by the route on new NCs; confirmed stays null until the
  // investigation concludes. Legacy rows are null on both and are reported as
  // "Unclassified" — deliberately NOT backfilled, since a guess would pollute the
  // very metric these columns exist to produce.
  ncTypeAsFound: text("nc_type_as_found"),
  ncTypeConfirmed: text("nc_type_confirmed"),

  // Session 60 — WHAT is affected, resolved to real records rather than typed text
  // so it can drive metrics and supplier scoring.
  //
  // Shown when EITHER classification is "Product". The catalog item is the thing
  // itself; the lot narrows it to one receipt when the material carries a lot
  // number. The lot also carries the lineage that makes supplier scoring work:
  // lot -> receiving inspection -> supplier.
  affectedInventoryItemId: integer("affected_inventory_item_id").references(() => inventoryItemsTable.id),
  affectedLotId: integer("affected_lot_id").references(() => lotsTable.id),

  // Shown when EITHER classification is "Process": the SOP or Work Instruction at
  // issue. Until now nothing on an NC pointed at a document at all, so a process
  // failure had nowhere to say which procedure was wrong.
  affectedDocumentId: integer("affected_document_id").references(() => documentsTable.id),

  // Finished-product context captured at NC creation. Optional — historical NCs,
  // process NCs, and NCs about components or consumables have no finished-goods
  // lineage. See productTypes.ts: that list is things you SELL, which is why a
  // received component had no valid value here.
  productType: text("product_type"),
  productName: text("product_name"),
  lotNumber: text("lot_number"),
  department: text("department"),
  approvedBy: integer("approved_by").references(() => usersTable.id),
  approvalName: text("approval_name"),
  approvalInitials: text("approval_initials"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  // Management acknowledgement checkpoint. Required (server-side) before a
  // Major/Critical NC can be closed; pairs with at least one open/closed CAPA.
  mgmtAcknowledgedBy: integer("mgmt_acknowledged_by").references(() => usersTable.id),
  mgmtAcknowledgedName: text("mgmt_acknowledged_name"),
  mgmtAcknowledgedInitials: text("mgmt_acknowledged_initials"),
  mgmtAcknowledgedAt: timestamp("mgmt_acknowledged_at", { withTimezone: true }),
  mgmtAcknowledgedNotes: text("mgmt_acknowledged_notes"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Session 52 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires
  // a Part 11 e-signature (initials + meaning) from a Manager/Quality/Admin
  // plus a rationale. Cancel is allowed only while the NC is In-Process; a
  // Closed NC cannot be cancelled. All nullable; null cancelledAt = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Containment / correction tasks taken in response to an NC. Distinct from
// CAPAs (which are root-cause-driven preventive actions).
//
// Lifecycle: the NC originator sets `description` (Task), `dueDate`, and
// `taskOwnerName` (assignee). Only the assigned owner (or an approver role)
// can later flip `completed=true` and set `completedAt/completedByName` —
// the system captures both timestamps for Part 11 traceability.
//
// Legacy `performedBy*` / `performedAt` / `notes` columns remain for rows
// created before Session 11; new UI does not surface them.
export const ncCorrectionsTable = pgTable("nc_corrections", {
  id: serial("id").primaryKey(),
  ncId: integer("nc_id").notNull().references(() => nonConformancesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),

  // Task-model columns added in Session 11.
  dueDate: date("due_date"),
  taskOwnerUserId: integer("task_owner_user_id").references(() => usersTable.id),
  taskOwnerName: text("task_owner_name"),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: integer("completed_by_user_id").references(() => usersTable.id),
  completedByName: text("completed_by_name"),
  // Session 101 (#9) — completion detail: the date the correction was actually
  // performed (may differ from completedAt, which is when it was logged).
  // Required by the complete endpoint. "What was done" reuses the `notes` col.
  performedOn: date("performed_on"),

  // Legacy free-text-log columns (pre-Session 11).
  performedByUserId: integer("performed_by_user_id").references(() => usersTable.id),
  performedByName: text("performed_by_name"),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const correctiveActionsTable = pgTable("corrective_actions", {
  id: serial("id").primaryKey(),
  ncId: integer("nc_id").notNull().references(() => nonConformancesTable.id, { onDelete: "cascade" }),
  actionDescription: text("action_description").notNull(),
  assignedTo: integer("assigned_to").references(() => usersTable.id),
  assignedToName: text("assigned_to_name"),
  dueDate: date("due_date"),
  status: text("status").notNull().default("Open"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  verifiedBy: integer("verified_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertNonConformanceSchema = createInsertSchema(nonConformancesTable).omit({ id: true, ncNumber: true, createdAt: true, updatedAt: true });
export type InsertNonConformance = z.infer<typeof insertNonConformanceSchema>;
export type NonConformance = typeof nonConformancesTable.$inferSelect;

export const insertCorrectiveActionSchema = createInsertSchema(correctiveActionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCorrectiveAction = z.infer<typeof insertCorrectiveActionSchema>;
export type CorrectiveAction = typeof correctiveActionsTable.$inferSelect;

export const insertNcCorrectionSchema = createInsertSchema(ncCorrectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertNcCorrection = z.infer<typeof insertNcCorrectionSchema>;
export type NcCorrection = typeof ncCorrectionsTable.$inferSelect;
