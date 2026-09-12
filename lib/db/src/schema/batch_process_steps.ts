import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

// Session 59 / 59.1 (06-04 FDA food GMP) — per-batch instance of an approved
// process step. Copied from recipe_process_steps when the batch is created from
// a recipe (recipeStepId points back to the master), carrying the instruction
// `template` (a procedure narrative with {blank} tokens). The baker fills the
// blanks (fieldValues) and e-signs (Part 11): completing a step records WHO
// baked, their initials + signing meaning, WHEN, the filled-in values, and the
// fully rendered sentence (renderedText) that prints on the batch record.
export const batchProcessStepsTable = pgTable("batch_process_steps", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  // Source master step (nullable — a step may be added directly on the batch).
  recipeStepId: integer("recipe_step_id"),
  stepNumber: integer("step_number").notNull().default(1),
  description: text("description").notNull(),
  // Instruction narrative with {blank} tokens, copied from the recipe step.
  template: text("template"),
  instructions: text("instructions"),
  // 2026-08-19 — what KIND of step this is. Null for every ordinary recipe/ad-hoc
  // step (the overwhelming majority) and the only non-null value today is
  // "metrc_package": the one step seeded onto EVERY batch regardless of recipe,
  // where the operator records the tag for the bulk package and signing it makes
  // CannaQMS create that package in METRC. Marked with a column rather than
  // matched on the description so an operator renaming the step can't detach it
  // from the behaviour, and so the Testing gate has something exact to look for.
  stepKind: text("step_kind"),
  sortOrder: integer("sort_order").notNull().default(0),
  // Baker sign-off (Part 11). `completed` flips true only via the /sign route,
  // which captures the acting user as the baker, the filled-in blank values, and
  // the rendered sentence.
  completed: boolean("completed").notNull().default(false),
  // Map of blank-token -> value the baker entered, e.g. { temp: "350", time: "10" }.
  fieldValues: jsonb("field_values"),
  // The template with every {token} substituted by its value — the printable line.
  renderedText: text("rendered_text"),
  performedByUserId: integer("performed_by_user_id").references(() => usersTable.id),
  performedByName: text("performed_by_name"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),
  performedAt: timestamp("performed_at", { withTimezone: true }),
  notes: text("notes"),
  // Session 62 — competency co-sign. When an operator who is NOT yet Qualified
  // for this batch's recipe signs a step, the step is recorded but stays pending
  // (cosignRequired=true, completed=false) until a Supervisor+ co-signs via the
  // /cosign route, which captures the co-signer (Part 11) and completes the step.
  // A Qualified operator signs solo and these stay null.
  cosignRequired: boolean("cosign_required").notNull().default(false),
  supervisorUserId: integer("supervisor_user_id").references(() => usersTable.id),
  supervisorName: text("supervisor_name"),
  supervisorInitials: text("supervisor_initials"),
  supervisorMeaning: text("supervisor_meaning"),
  supervisorSignedAt: timestamp("supervisor_signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchProcessStepSchema = createInsertSchema(batchProcessStepsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type BatchProcessStep = typeof batchProcessStepsTable.$inferSelect;
export type InsertBatchProcessStep = z.infer<typeof insertBatchProcessStepSchema>;
