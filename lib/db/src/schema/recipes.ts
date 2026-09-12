import { pgTable, serial, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recipesTable = pgTable("recipes", {
  id: serial("id").primaryKey(),
  productType: text("product_type").notNull(),
  // Optional facility-managed sub-form within the product type (e.g. Concentrate
  // → "live resin", Pre-Roll → "1g Pre-Roll"). Stored by name so deleting a
  // subtype in Settings never orphans a recipe. See product_subtypes.ts.
  subtype: text("subtype"),
  productName: text("product_name").notNull(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  // Session 82 follow-up — the reference output count the recipe's item
  // quantities are authored for. The seed recipes are written as "100-count
  // batch" totals (e.g. 100 g flower → 100 cones), so this defaults to 100.
  // At batch creation, planned quantities scale by Scheduled Output ÷ this
  // basis, so any batch size pulls the right amount. Author a recipe with
  // referenceUnitCount = 1 and per-unit quantities (0.5 g/unit) to get the pure
  // per-unit model — it's the same ratio math.
  referenceUnitCount: integer("reference_unit_count").notNull().default(100),
  // Recipe version lineage (2026-08-12) — change control. Every version of the
  // same product shares a lineageId (= the id of the first/root version). The
  // "New Version" action clones a recipe into a new row (version + 1, same
  // lineageId) and stamps the prior row's supersededByRecipeId, freezing it
  // read-only. The current ("head") version of a lineage is the row whose
  // supersededByRecipeId IS NULL. Nullable for pre-existing single-version
  // recipes; backfilled to id in ensureSchema.
  lineageId: integer("lineage_id"),
  supersededByRecipeId: integer("superseded_by_recipe_id"),
  // 2026-08-25 - change control against LINKED WORK INSTRUCTIONS. Bumped by any
  // mutation of this version's BOM items or process steps. The version number
  // only moves on "New Version", so without this an in-place edit would silently
  // change the procedure printed by every WI pinned to this recipe. A linked WI
  // compares its recipeConfirmedAt against this to know it is stale.
  contentRevisedAt: timestamp("content_revised_at", { withTimezone: true }),
  // 2026-09-07 — RECIPE RELEASE CONTROL (his ruling). A batch may only link a
  // RELEASED recipe, and a recipe is released when its linked work instruction
  // is Effective: "in reality, the WI and recipe will release together." That
  // state is DERIVED from the document rather than mirrored here, so it cannot
  // drift across the four separate paths a document takes to Effective.
  //
  // This column is the one-time exception: every recipe that existed before the
  // rule was introduced is grandfathered in, because they predate the linked-WI
  // requirement and blocking them would have taken the whole app offline. Set
  // once by the ensureSchema backfill; never set for a recipe created after.
  grandfatheredAt: timestamp("grandfathered_at", { withTimezone: true }),
  notes: text("notes"),
  // Session 103 - per-product label attributes (a recipe = a finished product).
  // These flow onto the batch label data export. Net weight is a default the
  // actual METRC package quantity still overrides.
  netWeight: real("net_weight"),
  netWeightUnit: text("net_weight_unit"),
  servingSize: text("serving_size"),
  servingStrengthMg: real("serving_strength_mg"),
  servingsPerPackage: integer("servings_per_package"),
  // Dual Chamber Vape Cartridge config (CRA MI_IB_0114, eff. 2026-07-28). Only
  // meaningful when productType = "Dual Chamber Vape Cartridge". Drives how many
  // final-form test groups the batch needs: same oil in both chambers = 1 test;
  // two different oils = 2 (Chamber A + Chamber B); two oils that can be used
  // together (combined draw) = 3 (adds the combined Chamber C). Nullable (unset)
  // until configured; consumed by the three-group testing tab (later build).
  dualChamberTwoOils: boolean("dual_chamber_two_oils"),
  dualChamberCombinedDraw: boolean("dual_chamber_combined_draw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const recipeItemsTable = pgTable("recipe_items", {
  id: serial("id").primaryKey(),
  recipeId: integer("recipe_id").notNull().references(() => recipesTable.id, { onDelete: "cascade" }),
  ingredientName: text("ingredient_name").notNull(),
  plannedQuantity: real("planned_quantity"),
  unitOfMeasure: text("unit_of_measure").notNull().default("g"),
  kind: text("kind").notNull().default("Ingredient"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRecipeSchema = createInsertSchema(recipesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRecipeItemSchema = createInsertSchema(recipeItemsTable).omit({ id: true, createdAt: true });
export type Recipe = typeof recipesTable.$inferSelect;
export type RecipeItem = typeof recipeItemsTable.$inferSelect;
export type InsertRecipe = z.infer<typeof insertRecipeSchema>;
export type InsertRecipeItem = z.infer<typeof insertRecipeItemSchema>;
