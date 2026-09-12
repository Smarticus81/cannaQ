import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchManifestsTable } from "./batch_manifests";

// Line items on an outbound manifest — one row per Metrc package (sellable unit
// run) placed on the manifest. Sourced from the batch's LABELED metrc tag runs
// (JIT commit 2 label_status='labeled'); the pre-flight refuses unlabeled/untested
// packages. wholesalePrice applies to the priced transfer types (Wholesale).
export const batchManifestPackagesTable = pgTable("batch_manifest_packages", {
  id: serial("id").primaryKey(),
  manifestId: integer("manifest_id").notNull().references(() => batchManifestsTable.id, { onDelete: "cascade" }),
  // The Metrc package tag (single) or first tag of a range placed on the manifest.
  packageLabel: text("package_label").notNull(),
  itemName: text("item_name"),
  quantity: numeric("quantity"),
  uom: text("uom"),
  grossWeight: numeric("gross_weight"),
  grossUnitOfWeightName: text("gross_unit_of_weight_name"),
  wholesalePrice: numeric("wholesale_price"),
  // Soft link back to the batch_metrc_tags run this package came from (traceability).
  sourceTagRunId: integer("source_tag_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchManifestPackageSchema = createInsertSchema(batchManifestPackagesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type BatchManifestPackage = typeof batchManifestPackagesTable.$inferSelect;
export type InsertBatchManifestPackage = z.infer<typeof insertBatchManifestPackageSchema>;
