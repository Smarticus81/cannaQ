import { pgTable, serial, text, integer, date, timestamp, boolean } from "drizzle-orm/pg-core";
import { nonConformancesTable } from "./non_conformances";
import { complaintsTable } from "./complaints";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// CAPA workflow stages — Session 35 (Tier 3 #13) reshape.
//
//   Stage 1: Initiation         — title, description, originator, Risk classification
//
//   ▼▼▼ GATE 0 — Manager/Quality acceptance ▼▼▼ (Session 35)
//     1 approver (Manager / Quality / Admin only — no Supervisors). Confirms
//     the CAPA is worth opening and routes it to Investigation. Originator
//     cannot sign their own. On approval, stage advances to Investigation.
//
//   Stage 2: Investigation      — RCA narrative + methodologies
//   Stage 3: Planning           — corrective actions + EC criteria + EC Owner
//                                 (Session 35: consolidates the prior
//                                 "Action Planning" and "EC Planning" stages
//                                 into one. Migration maps existing rows.)
//
//   ▼▼▼ GATE 1 — Pre-Implementation Approval ▼▼▼
//     2 distinct approvers (Sup / Mgr / Quality / Admin, neither = originator,
//     neither = EC Owner, neither = action item owner). Approves bundle of
//     Investigation + Planning. On approval the problem statement, RCA,
//     actions and EC plan become read-only. On rejection the CAPA returns to
//     Investigation or Planning with a mandatory comment.
//
//   Stage 4: Action Execution   — owners record actual work + completion date
//   Stage 5: EC Execution       — EC Owner records results vs. plan
//
//   ▼▼▼ GATE 2 — Closure ▼▼▼
//     1 approver (Manager / Quality / Admin only — no Supervisors). Pass →
//     Stage 6. Fail → comment + select rollback target (Investigation or
//     Planning). Approver ≠ originator, ≠ EC Owner, ≠ any action owner.
//
//   Stage 6: Closed (terminal)
//
// Legacy "status" column is preserved for back-compat; new code reads/writes
// "stage". A future migration can remove "status" once the UI no longer
// references it.
// ─────────────────────────────────────────────────────────────────────────────

export const CAPA_STAGES = [
  "Initiation",
  "Investigation",
  "Planning",
  "Action Execution",
  "EC Execution",
  "Closed",
] as const;
export type CapaStage = typeof CAPA_STAGES[number];

// Session 35 — Gate-1 and Gate-2 rejections target one of these stages.
// Was ["Investigation", "Action Planning"] in the pre-consolidation model.
export const CAPA_ROLLBACK_TARGETS = ["Investigation", "Planning"] as const;
export type CapaRollbackTarget = typeof CAPA_ROLLBACK_TARGETS[number];

export const capasTable = pgTable("capas", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  capaNumber: text("capa_number").notNull().unique(),
  type: text("type").notNull().default("Corrective"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  sourceNcId: integer("source_nc_id").references(() => nonConformancesTable.id),
  sourceComplaintId: integer("source_complaint_id").references(() => complaintsTable.id),
  rootCauseAnalysis: text("root_cause_analysis"),
  // Legacy single-value RCA method (kept for back-compat). New code writes
  // rcaMethods (array) instead and treats this field as read-only.
  rcaMethod: text("rca_method"),
  // Multi-select RCA methodologies: "5 Whys", "Fishbone", "FMEA", "Pareto", etc.
  rcaMethods: text("rca_methods").array(),
  // 2026-08-27 — who actually did the investigation. Jonathan: the investigator can
  // differ from the CAPA owner or the person who raised it, and until now the record
  // had nowhere to say so. A name rather than a user reference on purpose: an
  // investigation is often run by someone outside the app — a contract lab, a
  // supplier's engineer, a consultant — and a foreign key would make those
  // unrecordable.
  rcaInvestigatorName: text("rca_investigator_name"),
  effectivenessCriteria: text("effectiveness_criteria"),
  effectivenessCheckDue: date("effectiveness_check_due"),
  effectivenessVerifiedAt: timestamp("effectiveness_verified_at", { withTimezone: true }),
  effectivenessVerifiedById: integer("effectiveness_verified_by_id").references(() => usersTable.id),
  effectivenessVerifiedByName: text("effectiveness_verified_by_name"),
  effectivenessVerifiedByInitials: text("effectiveness_verified_by_initials"),
  effectivenessOutcome: text("effectiveness_outcome"),
  effectivenessNotes: text("effectiveness_notes"),

  // New workflow stage (replaces "status" for new code).
  stage: text("stage").notNull().default("Initiation"),

  // Legacy linear status (preserved for back-compat — do not write from new
  // code; map to stage instead).
  status: text("status").notNull().default("Open"),

  // Originator — defaults from openedBy* but stored explicitly so segregation
  // rules don't have to chase historical signatures.
  originatorId: integer("originator_id").references(() => usersTable.id),
  originatorName: text("originator_name"),

  // Effectiveness Check Owner — assigned at Stage 4 by the CAPA owner.
  // Server enforces: ≠ originator, ≠ any action item assignedTo.
  effectivenessOwnerId: integer("effectiveness_owner_id").references(() => usersTable.id),
  effectivenessOwnerName: text("effectiveness_owner_name"),
  // 2026-08-28 — the segregation rule (EC Owner is neither the originator nor an
  // action owner) can leave a small site with NOBODY eligible. Jonathan: "Some
  // locations may not have enough people to complete a CAPA if we do that."
  //
  // So the rule stays the default and becomes overridable with a written reason,
  // rather than being dropped. "We have four employees" is a perfectly good reason
  // to an inspector — as long as somebody wrote it down. Null means the assignment
  // met the rule and needed no exception.
  ecOwnerSegregationOverrideReason: text("ec_owner_segregation_override_reason"),
  ecOwnerSegregationOverrideBy: text("ec_owner_segregation_override_by"),
  ecOwnerSegregationOverrideAt: timestamp("ec_owner_segregation_override_at", { withTimezone: true }),

  // Session 35 — Gate 0 — Manager/Quality acceptance (single approver,
  // Manager / Quality / Admin only). Originator cannot sign their own; on
  // approval the CAPA advances Initiation → Investigation.
  gate0ApproverId: integer("gate0_approver_id").references(() => usersTable.id),
  gate0ApproverName: text("gate0_approver_name"),
  gate0ApproverInitials: text("gate0_approver_initials"),
  gate0ApproverAt: timestamp("gate0_approver_at", { withTimezone: true }),
  gate0ApproverMeaning: text("gate0_approver_meaning"),
  gate0ApprovedAt: timestamp("gate0_approved_at", { withTimezone: true }),

  // Gate 1 — Pre-Implementation Approval (two distinct approvers).
  gate1Approver1Id: integer("gate1_approver1_id").references(() => usersTable.id),
  gate1Approver1Name: text("gate1_approver1_name"),
  gate1Approver1Initials: text("gate1_approver1_initials"),
  gate1Approver1At: timestamp("gate1_approver1_at", { withTimezone: true }),
  gate1Approver1Meaning: text("gate1_approver1_meaning"),
  gate1Approver2Id: integer("gate1_approver2_id").references(() => usersTable.id),
  gate1Approver2Name: text("gate1_approver2_name"),
  gate1Approver2Initials: text("gate1_approver2_initials"),
  gate1Approver2At: timestamp("gate1_approver2_at", { withTimezone: true }),
  gate1Approver2Meaning: text("gate1_approver2_meaning"),
  gate1ApprovedAt: timestamp("gate1_approved_at", { withTimezone: true }),

  // Gate 2 — Closure (single approver, Pass/Fail).
  gate2ApproverId: integer("gate2_approver_id").references(() => usersTable.id),
  gate2ApproverName: text("gate2_approver_name"),
  gate2ApproverInitials: text("gate2_approver_initials"),
  gate2ApproverAt: timestamp("gate2_approver_at", { withTimezone: true }),
  gate2ApproverMeaning: text("gate2_approver_meaning"),
  gate2Outcome: text("gate2_outcome"), // "Pass" | "Fail"

  // Latest rejection metadata — overwritten on each rejection, full history
  // is in audit_log.
  lastRejectionAt: timestamp("last_rejection_at", { withTimezone: true }),
  lastRejectionStage: text("last_rejection_stage"), // "Gate 1" | "Gate 2"
  lastRejectionById: integer("last_rejection_by_id").references(() => usersTable.id),
  lastRejectionByName: text("last_rejection_by_name"),
  lastRejectionComment: text("last_rejection_comment"),
  lastRejectionTarget: text("last_rejection_target"), // "Investigation" | "Action Planning"

  openedById: integer("opened_by_id").references(() => usersTable.id),
  openedByName: text("opened_by_name"),
  closedById: integer("closed_by_id").references(() => usersTable.id),
  closedByName: text("closed_by_name"),
  closedByInitials: text("closed_by_initials"),
  closureNotes: text("closure_notes"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Product context captured at CAPA creation (Session 12). Optional —
  // process / system CAPAs may not have specific product lineage.
  productType: text("product_type"),
  productName: text("product_name"),
  lotNumber: text("lot_number"),
  department: text("department"),

  // Per-phase due dates (Session 12). Each phase has its own commitment date
  // independent of the others; effectivenessCheckDue covers the EC Execution
  // phase already.
  investigationDueDate: date("investigation_due_date"),
  actionPlanningDueDate: date("action_planning_due_date"),
  ecPlanningDueDate: date("ec_planning_due_date"),
  // Session 101 (#15, Jonathan 08-03) — closure-milestone target dates.
  correctionPaClosureDueDate: date("correction_pa_closure_due_date"),
  ecCheckClosureDueDate: date("ec_check_closure_due_date"),

  // Structured multi-select picks for metrics. Separate from rcaMethods
  // (methodologies like "5 Whys", "Fishbone") — these are categorical root
  // causes ("Operator Error", "Procedure Gap", etc.).
  rootCauses: text("root_causes").array(),

  // ── Session 34 (Tier 2 #10) — Initial Risk classification ────────────────
  //
  // Operator picks Critical | High | Medium | Low at CAPA open with a free-
  // text rationale documenting WHY. The five boolean prompts below are the
  // guiding questions from the QMS review — they're stored structurally so
  // the Track C Risk Memory agent (Tier 6) can learn which combinations
  // correlate with future failures. None of the booleans auto-compute the
  // tier; the operator's judgment remains authoritative.
  //
  // Risk can be revised during Investigation. Every revision writes a
  // RISK_REVISED audit_log entry. These four columns mirror the most recent
  // revision for at-a-glance display.
  riskLevel: text("risk_level"),
  riskRationale: text("risk_rationale"),
  riskReleased: boolean("risk_released"),
  riskCustomerAffected: boolean("risk_customer_affected"),
  riskLabelingImpact: boolean("risk_labeling_impact"),
  riskInHouseOnly: boolean("risk_in_house_only"),
  riskPreBulk: boolean("risk_pre_bulk"),
  riskRevisedAt: timestamp("risk_revised_at", { withTimezone: true }),
  riskRevisedByName: text("risk_revised_by_name"),
  riskRevisedReason: text("risk_revised_reason"),
  riskRevisedFrom: text("risk_revised_from"),

  // Session 52 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires
  // a Part 11 e-signature from a Manager/Quality/Admin plus a rationale.
  // Cancel is allowed only while the CAPA is In-Process; a Closed CAPA
  // (stage = "Closed") cannot be cancelled. All nullable; null = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const capaActionItemsTable = pgTable("capa_action_items", {
  id: serial("id").primaryKey(),
  capaId: integer("capa_id").notNull().references(() => capasTable.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull().default(1),
  actionDescription: text("action_description").notNull(),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id),
  assignedToName: text("assigned_to_name"),
  dueDate: date("due_date"),
  status: text("status").notNull().default("Open"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedById: integer("completed_by_id").references(() => usersTable.id),
  completedByName: text("completed_by_name"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedById: integer("verified_by_id").references(() => usersTable.id),
  verifiedByName: text("verified_by_name"),
  notes: text("notes"),
  // Session 101 (#16) — date the corrective/preventive action was actually
  // performed (may differ from completedAt). Required when marking Completed.
  performedOn: date("performed_on"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Capa = typeof capasTable.$inferSelect;
export type CapaActionItem = typeof capaActionItemsTable.$inferSelect;
