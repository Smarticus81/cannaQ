import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-product-type label attributes (Settings → Product Setup). Replaces the
// hardcoded LABEL_SHELF_LIFE_DAYS map that used to live in routes/batches.ts:
// shelf-life drives the computed expiration date, and the default net weight,
// serving info, and activation time flow into the per-package label data export.
// Keyed by the same productType discriminator batches already carry (Flower,
// Pre-Roll, Concentrate, Vape, Topical, Edible).
export const productTypeSettingsTable = pgTable("product_type_settings", {
  id: serial("id").primaryKey(),
  productType: text("product_type").notNull().unique(),
  shelfLifeDays: integer("shelf_life_days"),
  defaultNetWeight: real("default_net_weight"),
  defaultNetWeightUnit: text("default_net_weight_unit"),
  servingSize: text("serving_size"),
  servingsPerPackage: integer("servings_per_package"),
  activationTime: text("activation_time"),
  updatedByName: text("updated_by_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProductTypeSettingsSchema = createInsertSchema(productTypeSettingsTable).omit({ id: true, updatedAt: true });
export type InsertProductTypeSettings = z.infer<typeof insertProductTypeSettingsSchema>;
export type ProductTypeSettings = typeof productTypeSettingsTable.$inferSelect;
