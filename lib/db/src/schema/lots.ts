import { pgTable, serial, text, integer, real, timestamp, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";
import { inventoryItemsTable } from "./inventory";
import { incomingInspectionsTable } from "./incoming_inspections";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

// First-class lot identity. Every physical batch of material that moves through
// the facility — whether received from a supplier or produced internally — gets
// exactly one row here, with a unique lot_number used everywhere downstream.
//
// status lifecycle: Active -> (Quarantined | Consumed | Recalled | Expired)
// origin: 'received' (from a supplier inspection) or 'produced' (output of a batch)
//         or 'split' (subdivided from a parent lot) or 'merged' (combined from siblings)
export const lotsTable = pgTable("lots", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  lotNumber: text("lot_number"),
  itemName: text("item_name").notNull(),
  itemType: text("item_type").notNull(),
  unitOfMeasure: text("unit_of_measure").notNull(),
  originalQuantity: real("original_quantity").notNull(),
  currentQuantity: real("current_quantity").notNull(),
  origin: text("origin").notNull(),
  status: text("status").notNull().default("Active"),
  // Cannabis overlay flag. The lots table is the single shared on-hand ledger
  // for ALL materials; is_cannabis marks the ones that get METRC tags / appear
  // on the cannabis-only Lot Traceability view. Defaults true so pre-existing
  // (all-cannabis) lots stay visible; receiving sets it from the supplier type.
  isCannabis: boolean("is_cannabis").notNull().default(true),
  // Intermediates-as-ingredient flag (follow-up #2, post-Session 79). A
  // produced lot (cannabutter, distillate, etc.) is finished-goods by default
  // and excluded from the raw-material Inventory rollup. Once it passes test it
  // can be RELEASED for downstream use as an ingredient via a Part 11-signed
  // disposition, which flips this flag true — promoting it onto the Inventory
  // view + the ingredient lot-picker (both read listInventoryView). Defaults
  // false so existing produced lots stay finished-goods-only.
  availableAsIngredient: boolean("available_as_ingredient").notNull().default(false),
  // Source pointers — exactly one set should be populated based on origin
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  inventoryItemId: integer("inventory_item_id").references(() => inventoryItemsTable.id),
  sourceInspectionId: integer("source_inspection_id").references(() => incomingInspectionsTable.id),
  sourceBatchId: integer("source_batch_id").references(() => batchRecordsTable.id),
  parentLotId: integer("parent_lot_id"),
  metrcPackageId: text("metrc_package_id"),
  expirationDate: date("expiration_date"),
  // Potency (2026-09-06) — THC/CBD carried by a CANNABIS lot. Michigan requires
  // transferred cannabis to be tested, so a received lot arrives with a COA: the
  // receiving team either types the values off it or pulls them from the Metrc
  // lab results attached to the incoming package. Percentages for flower/extract.
  // Null on non-cannabis lots (is_cannabis = false) and on cannabis lots whose
  // COA has not been recorded yet — null means UNKNOWN, never zero.
  thcPct: real("thc_pct"),
  cbdPct: real("cbd_pct"),
  // Provenance of the two values above, so the Inventory screen can show whether
  // a number was hand-entered or came from the state system: 'manual' | 'metrc'
  // | 'batch' (derived from the producing batch's own test result).
  potencySource: text("potency_source"),
  potencyTestedAt: date("potency_tested_at"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Append-only ledger. Every quantity-affecting or lifecycle event on a lot
// produces a row here. Splits/merges/recalls require Manager+ e-sig per Part 11.
export const lotEventsTable = pgTable("lot_events", {
  id: serial("id").primaryKey(),
  lotId: integer("lot_id").notNull().references(() => lotsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  quantityDelta: real("quantity_delta").notNull().default(0),
  resultingQuantity: real("resulting_quantity").notNull(),
  relatedLotId: integer("related_lot_id").references(() => lotsTable.id),
  relatedBatchId: integer("related_batch_id").references(() => batchRecordsTable.id),
  reason: text("reason"),
  notes: text("notes"),
  performedBy: integer("performed_by").references(() => usersTable.id),
  performedByName: text("performed_by_name"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Output lots produced by a batch. A single batch may yield multiple output
// lots (e.g. cartridges + disposables from the same distillate run).
export const batchOutputsTable = pgTable("batch_outputs", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  lotId: integer("lot_id").notNull().references(() => lotsTable.id),
  quantity: real("quantity").notNull(),
  unitOfMeasure: text("unit_of_measure").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Shipments to customers. Required for downstream recall tracing.
export const shipmentsTable = pgTable("shipments", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  lotId: integer("lot_id").notNull().references(() => lotsTable.id),
  customerName: text("customer_name").notNull(),
  customerLicense: text("customer_license"),
  shippedQuantity: real("shipped_quantity").notNull(),
  unitOfMeasure: text("unit_of_measure").notNull(),
  manifestNumber: text("manifest_number"),
  status: text("status").notNull().default("Shipped"),
  shippedDate: date("shipped_date").notNull(),
  shippedBy: integer("shipped_by").references(() => usersTable.id),
  shippedByName: text("shipped_by_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLotSchema = createInsertSchema(lotsTable).omit({
  id: true, createdAt: true, updatedAt: true, currentQuantity: true,
});
export type InsertLot = z.infer<typeof insertLotSchema>;
export type Lot = typeof lotsTable.$inferSelect;

export const insertLotEventSchema = createInsertSchema(lotEventsTable).omit({ id: true, createdAt: true });
export type InsertLotEvent = z.infer<typeof insertLotEventSchema>;
export type LotEvent = typeof lotEventsTable.$inferSelect;

export const insertBatchOutputSchema = createInsertSchema(batchOutputsTable).omit({ id: true, createdAt: true });
export type InsertBatchOutput = z.infer<typeof insertBatchOutputSchema>;
export type BatchOutput = typeof batchOutputsTable.$inferSelect;

export const insertShipmentSchema = createInsertSchema(shipmentsTable).omit({ id: true, createdAt: true });
export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipmentsTable.$inferSelect;
