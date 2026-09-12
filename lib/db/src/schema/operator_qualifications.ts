import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { recipesTable } from "./recipes";

// Session 62 — competency-based training for recipe-backed production processes.
// One row per (operator, recipe). The operator runs supervised batches (each
// step co-signed by a supervisor) until they reach the required count, then a
// supervisor records a Part 11 qualification sign-off → status "Qualified", and
// the operator may sign that recipe's batch steps solo. Until then, solo signing
// is hard-blocked (the step is recorded as pending co-sign).
//
// Policy SOPs (Complaint, Field Action, etc.) are NOT competency-gated — they
// stay read-and-acknowledge via training_records. Only recipe-backed WIs use
// this table, because only production batches have process steps.
//
// supervisedBatchCount is NOT stored — it is COMPUTED live (distinct batches of
// this recipe with a co-signed step performed by the operator) to avoid drift.
export const operatorQualificationsTable = pgTable("operator_qualifications", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  operatorUserId: integer("operator_user_id").notNull().references(() => usersTable.id),
  recipeId: integer("recipe_id").notNull().references(() => recipesTable.id, { onDelete: "cascade" }),

  status: text("status").notNull().default("In Training"), // "In Training" | "Qualified" | "Revoked"
  // Production default: an operator runs 5 supervised batches of a recipe before a
  // supervisor can qualify them for solo signing. (Was 2 during Session 65/66
  // validation; raised to the production value in Session 67.)
  requiredSupervisedBatches: integer("required_supervised_batches").notNull().default(5),

  // Part 11 qualification sign-off (the supervisor attests competency).
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
  qualifiedBySupervisorUserId: integer("qualified_by_supervisor_user_id").references(() => usersTable.id),
  qualifiedBySupervisorName: text("qualified_by_supervisor_name"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),

  // Optional revocation (Part 11; status -> Revoked). Recoverable by re-qualifying.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  revokedByName: text("revoked_by_name"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqOperatorRecipe: unique("uniq_operator_recipe").on(t.operatorUserId, t.recipeId),
}));

export const insertOperatorQualificationSchema = createInsertSchema(operatorQualificationsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type OperatorQualification = typeof operatorQualificationsTable.$inferSelect;
export type InsertOperatorQualification = z.infer<typeof insertOperatorQualificationSchema>;
