import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const fieldActionsTable = pgTable("field_actions", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  faNumber: text("fa_number").notNull().unique(),
  actionType: text("action_type").notNull(),
  status: text("status").notNull().default("Initiated"),
  title: text("title").notNull(),
  initiationReason: text("initiation_reason").notNull(),
  affectedBatches: text("affected_batches"),
  scopeDescription: text("scope_description"),
  // Legacy free-text response-actions log. Preserved for back-compat with FAs
  // created before Session 13. New work writes structured rows to
  // fa_response_actions; the UI surfaces the legacy column under a "Legacy
  // notes" affordance when present.
  responseActions: text("response_actions"),
  dueDiligenceNotes: text("due_diligence_notes"),
  closureNotes: text("closure_notes"),
  closedBy: integer("closed_by").references(() => usersTable.id),
  closedByName: text("closed_by_name"),
  closedByInitials: text("closed_by_initials"),
  // Gate 3. The signing MEANING, kept apart from the signer name — closed_by_name
  // used to be handed the meaning, which lost the name of the person who signed.
  closedByMeaning: text("closed_by_meaning"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // ── Session 13 additions ─────────────────────────────────────────────────
  // Product context captured at FA creation. Optional — process / system
  // FAs may not have specific product lineage. Mirrors the pattern used on
  // non_conformances (Session 11) and capas (Session 12).
  productType: text("product_type"),
  productName: text("product_name"),
  lotNumber: text("lot_number"),
  department: text("department"),

  // Optional links back to the originating NC or Complaint. When set at
  // creation, the API auto-prefills `initiationReason` from the source
  // record's description; the operator can then edit before saving.
  sourceNcId: integer("source_nc_id"),
  sourceComplaintId: integer("source_complaint_id"),

  // Optional forward link to the CAPA opened in response to this field action.
  // Not a hard reference (no FK) so that an FA can be opened before the CAPA
  // is created and linked retroactively; integrity is enforced at the
  // application layer.
  linkedCapaId: integer("linked_capa_id"),

  // ── Session 76 — request → approval workflow ──────────────────────────────
  // An Operator may not open an FA directly; they submit a request (status
  // "Requested") that an approver reviews. requested_* captures who asked;
  // reviewed_* captures the approver who approved or rejected it; rejection
  // reason is required on reject. The mandatory CAPA is created at approval,
  // not at request time. All nullable / additive — existing FAs are unaffected.
  requestedById: integer("requested_by_id"),
  requestedByName: text("requested_by_name"),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  reviewedById: integer("reviewed_by_id"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),

  // ── Session 63.4 — Gate reviews ───────────────────────────────────────────
  // A field action used to advance by picking the next status from a dropdown,
  // which is no control at all: a recall could reach Closed without anyone
  // signing that the scope was right or the reconciliation held. Each gate is a
  // Part 11 e-signature that moves the record forward; nothing else does.
  //
  //   Gate 0 — below Initiation Reason.    Initiated    → Scope Defined
  //   Gate 1 — below Scope Description.    Scope Defined→ Response Active
  //   Gate 2 — below Due Diligence Notes.  Due Diligence→ ready for closure
  //   Gate 3 — closure. NO COLUMNS HERE: it is the existing Part 11 closure
  //            signature (closed_by / closed_by_initials / closed_at), renamed
  //            rather than duplicated so one act needs one signature.
  //
  // Response Active → Due Diligence is deliberately NOT a gate. It flips on its
  // own once every response action carries a notification date, because that is
  // exactly what "the response is done" means — there is no judgement left for
  // a signer to make.
  //
  // All nullable and additive; existing field actions are unaffected and simply
  // read as having no gates signed.
  gate0ApproverId: integer("gate0_approver_id").references(() => usersTable.id),
  gate0ApproverName: text("gate0_approver_name"),
  gate0ApproverInitials: text("gate0_approver_initials"),
  gate0ApproverMeaning: text("gate0_approver_meaning"),
  gate0ApprovedAt: timestamp("gate0_approved_at", { withTimezone: true }),

  gate1ApproverId: integer("gate1_approver_id").references(() => usersTable.id),
  gate1ApproverName: text("gate1_approver_name"),
  gate1ApproverInitials: text("gate1_approver_initials"),
  gate1ApproverMeaning: text("gate1_approver_meaning"),
  gate1ApprovedAt: timestamp("gate1_approved_at", { withTimezone: true }),

  gate2ApproverId: integer("gate2_approver_id").references(() => usersTable.id),
  gate2ApproverName: text("gate2_approver_name"),
  gate2ApproverInitials: text("gate2_approver_initials"),
  gate2ApproverMeaning: text("gate2_approver_meaning"),
  gate2ApprovedAt: timestamp("gate2_approved_at", { withTimezone: true }),

  // Latest rejection only — the full history lives in audit_log, same as CAPA.
  lastRejectionAt: timestamp("last_rejection_at", { withTimezone: true }),
  lastRejectionStage: text("last_rejection_stage"),   // "Gate 1" | "Gate 2"
  lastRejectionById: integer("last_rejection_by_id").references(() => usersTable.id),
  lastRejectionByName: text("last_rejection_by_name"),
  lastRejectionComment: text("last_rejection_comment"),
  // ─────────────────────────────────────────────────────────────────────────
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFieldActionSchema = createInsertSchema(fieldActionsTable).omit({ id: true, faNumber: true, createdAt: true, updatedAt: true });
export type InsertFieldAction = z.infer<typeof insertFieldActionSchema>;
export type FieldAction = typeof fieldActionsTable.$inferSelect;
