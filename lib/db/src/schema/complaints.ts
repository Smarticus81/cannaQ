import { pgTable, serial, text, integer, date, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";

export const complaintsTable = pgTable("complaints", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  complaintNumber: text("complaint_number").notNull().unique(),
  receivedDate: date("received_date").notNull(),
  customerName: text("customer_name"),
  productName: text("product_name"),
  batchId: integer("batch_id").references(() => batchRecordsTable.id),
  // Session 75 — a complaint can be linked to the internal Nonconformance (NC)
  // opened to investigate it. Many complaints → one NC (a bad batch can draw
  // several customer complaints that all trace to one internal nonconformance).
  // Nullable: not every complaint warrants an NC. The reverse (NC → its related
  // complaints) is a query on this column, surfaced on the NC detail page.
  ncId: integer("nc_id"),
  // Session 101 — a complaint can be escalated directly to a CAPA (no NC
  // first). Backlink to that CAPA; the CAPA's source_complaint_id points back.
  capaId: integer("capa_id"),
  complaintType: text("complaint_type").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("Open"),
  investigation: text("investigation"),
  resolution: text("resolution"),
  // Session 101 (#2) — structured root-cause categories for metrics/trending
  // (mirrors nc.root_causes). Free-text investigation stays in `investigation`.
  rootCauses: text("root_causes").array(),
  // Session 101 — "no corrective action required" disposition + its rationale
  // (audit-defensible reason nothing was done, e.g. KPI review shows control).
  noActionRequired: boolean("no_action_required").notNull().default(false),
  noActionRationale: text("no_action_rationale"),
  fieldActionId: integer("field_action_id"),
  closedAt: timestamp("closed_at", { withTimezone: true }),

  // ── Session 38 (Tier 4 #20) — MVP expansion of complaint intake. ───────
  // Pulls the obvious gaps that ISO 13485 §8.2.2 and FDA QMSR §820.198
  // baseline; the full FDA x ISO 13485 x food-reg cross-walk is Tier 5
  // research that lands as a separate later expansion. Reporter is distinct
  // from customerName because the person reporting (e.g. dispensary staff
  // calling on behalf of a patron) often isn't the consumer themselves.
  reporterName: text("reporter_name"),
  reporterEmail: text("reporter_email"),
  reporterPhone: text("reporter_phone"),
  // Operator-entered lot string; distinct from batchId FK because the
  // affected lot may pre-date this CannaQMS install or come from a third
  // party. Stored as text so the value survives even if no batch_records
  // row exists.
  lotNumber: text("lot_number"),
  // Severity assessment is the operator's documented reasoning for the
  // severity tag; separate from the severity enum so the audit trail can
  // show "Why Critical?" alongside the tag.
  severityRationale: text("severity_rationale"),
  // Regulatory notification flags. Set at intake by the reviewer; drives
  // the downstream notification queues (MDR, MDARD, FDA). Default all
  // false so legacy rows default to "no reportable obligation noted."
  mdrReportable: boolean("mdr_reportable").notNull().default(false),
  mdardReportable: boolean("mdard_reportable").notNull().default(false),
  fdaReportable: boolean("fda_reportable").notNull().default(false),
  // Session 101 — CRA is the primary authority for a MI marihuana product
  // adverse reaction: notify the CRA + log in METRC within 1 BUSINESS DAY
  // (R 420.214b). Drives the 1-business-day notification banner.
  craReportable: boolean("cra_reportable").notNull().default(false),
  // Stored yes/no answers from the reportability triage — the audit trail of
  // how the reviewer reached the CRA/FDA determination.
  reportabilityTriage: jsonb("reportability_triage"),

  // Session 52 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires
  // a Part 11 e-signature from a Manager/Quality/Admin plus a rationale.
  // Cancel is allowed only while the complaint is In-Process; a Closed
  // complaint cannot be cancelled. All nullable; null = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertComplaintSchema = createInsertSchema(complaintsTable).omit({ id: true, complaintNumber: true, createdAt: true, updatedAt: true });
export type InsertComplaint = z.infer<typeof insertComplaintSchema>;
export type Complaint = typeof complaintsTable.$inferSelect;

// Session 101 (#3) — immediate containment actions logged on a complaint
// (what was done / when / by whom). Distinct from a CAPA's corrective &
// preventive actions; mirrors the NC nc_corrections log model.
export const complaintCorrectionsTable = pgTable("complaint_corrections", {
  id: serial("id").primaryKey(),
  complaintId: integer("complaint_id").notNull().references(() => complaintsTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),

  // Session 62 — task model, mirroring nc_corrections. A correction started life
  // here as a LOG of something already done, which is why the date field was
  // capped at today. In practice a containment action is assigned before it is
  // performed — "quarantine the remaining stock, Marcus, by Friday" — so it is a
  // task with an owner and a due date that is later completed, exactly as on an NC.
  //
  // Kept deliberately identical to nc_corrections rather than simplified: the two
  // are the same concept on different parents, and a second, subtly different
  // shape is how vocabularies drift apart in this codebase.
  dueDate: date("due_date"),
  taskOwnerUserId: integer("task_owner_user_id"),
  taskOwnerName: text("task_owner_name"),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: integer("completed_by_user_id"),
  completedByName: text("completed_by_name"),

  // performedOn = the date the work actually happened, recorded at completion.
  // Distinct from completedAt, which is when it was logged in the system.
  performedOn: date("performed_on"),
  performedByUserId: integer("performed_by_user_id"),
  performedByName: text("performed_by_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertComplaintCorrectionSchema = createInsertSchema(complaintCorrectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertComplaintCorrection = z.infer<typeof insertComplaintCorrectionSchema>;
export type ComplaintCorrection = typeof complaintCorrectionsTable.$inferSelect;
