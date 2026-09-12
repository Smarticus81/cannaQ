import { pgTable, serial, text, integer, real, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";

export const inventoryItemsTable = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  itemName: text("item_name").notNull(),
  itemType: text("item_type").notNull(),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  lotNumber: text("lot_number"),
  quantity: real("quantity").notNull().default(0),
  unitOfMeasure: text("unit_of_measure").notNull(),
  reorderPoint: real("reorder_point"),
  reorderQuantity: real("reorder_quantity"),
  notes: text("notes"),
  // Set when this row was auto-created from an Incoming Inspection line item.
  // Unique so re-applying Pass on the same inspection is idempotent.
  sourceInspectionItemId: integer("source_inspection_item_id").unique(),
  // Marks the removable pre-approved starter catalog items (see seedStarterInventory.ts).
  isStarterDefault: boolean("is_starter_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertInventoryItemSchema = createInsertSchema(inventoryItemsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItemsTable.$inferSelect;
