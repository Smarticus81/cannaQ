import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { recipesTable } from "./recipes";

// Session 59 (06-04 FDA food GMP) — approved manufacturing/process steps that
// live on the Recipe (the controlled master). Session 59.1 reshapes a step into
// a fill-in-the-blank instruction taken from the procedure, e.g.
//   "Once ingredients are mixed, {baker} placed 2 inch round spoons of cookie
//    dough onto the tray and baked at {temp} degrees {unit} for {time} minutes."
// The {tokens} are blanks the baker completes during execution on the batch.
// `description` is a short title for tables; `template` is the printable
// narrative. Steps are copied onto each batch of the recipe (batch_process_steps),
// where the baker fills the blanks and e-signs. Keeping the master on the recipe
// is what makes the steps "approved" rather than ad-hoc per batch.
export const recipeProcessStepsTable = pgTable("recipe_process_steps", {
  id: serial("id").primaryKey(),
  recipeId: integer("recipe_id").notNull().references(() => recipesTable.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull().default(1),
  // Short title, e.g. "Bake cookies".
  description: text("description").notNull(),
  // The procedure narrative with {blank} tokens the baker fills in. Optional so
  // a step can be a simple titled check with no fill-ins.
  template: text("template"),
  // Optional longer instructions / critical-control notes.
  instructions: text("instructions"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRecipeProcessStepSchema = createInsertSchema(recipeProcessStepsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type RecipeProcessStep = typeof recipeProcessStepsTable.$inferSelect;
export type InsertRecipeProcessStep = z.infer<typeof insertRecipeProcessStepSchema>;
