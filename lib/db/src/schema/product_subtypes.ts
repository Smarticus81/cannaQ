import { pgTable, serial, text, real, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Facility-managed operational sub-forms WITHIN a product type (Settings →
// Product Setup). Purely descriptive for most types (Concentrate: live resin /
// wax / shatter / rosin; Edible: gummy / chocolate) and does NOT drive labeling
// or regulatory routing. The one exception is size-style subtypes (e.g. a "1g
// Pre-Roll"), which may carry an OPTIONAL default net weight + unit that
// pre-fills the recipe's net weight when the subtype is picked — keeping the
// size name and the actual weight in sync. A recipe stores its chosen subtype by
// name (recipes.subtype), so deleting a subtype here never orphans a recipe.
export const productSubtypesTable = pgTable("product_subtypes", {
  id: serial("id").primaryKey(),
  // The canonical product type this subtype belongs under (Flower, Pre-Roll, …).
  productType: text("product_type").notNull(),
  name: text("name").notNull(),
  // Optional size default. When set, picking this subtype on a recipe pre-fills
  // the recipe's net weight (still overridable). Null for purely descriptive
  // subtypes (live resin, gummy, …).
  defaultNetWeight: real("default_net_weight"),
  defaultNetWeightUnit: text("default_net_weight_unit"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProductSubtypeSchema = createInsertSchema(productSubtypesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProductSubtype = z.infer<typeof insertProductSubtypeSchema>;
export type ProductSubtype = typeof productSubtypesTable.$inferSelect;
