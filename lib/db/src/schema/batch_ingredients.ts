import { pgTable, serial, text, integer, real, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { inventoryItemsTable } from "./inventory";
import { suppliersTable } from "./suppliers";

export const batchIngredientsTable = pgTable("batch_ingredients", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  inventoryItemId: integer("inventory_item_id").references(() => inventoryItemsTable.id),
  lotId: integer("lot_id"),
  ingredientName: text("ingredient_name").notNull(),
  lotNumber: text("lot_number"),
  plannedQuantity: real("planned_quantity"),
  actualQuantity: real("actual_quantity"),
  unitOfMeasure: text("unit_of_measure").notNull(),
  // "Ingredient" (consumable, e.g. distillate, terpenes) or "Material"
  // (packaging, e.g. cartridge, pre-roll cone, label). Surfaces both kinds in
  // the labeling panel since labels need to reflect every component on a batch.
  kind: text("kind").notNull().default("Ingredient"),
  // Session 40 (Tier 3 #12e) — packaging materials lot capture. When
  // kind="Material" the server requires `lotNumber` and at least one of
  // (supplierId, supplierLotNumber) before accepting the row, so packaging
  // (cartridges, cones, child-resistant containers, etc.) carries enough
  // provenance to satisfy MI MRA R 420.704 traceability on a complaint or
  // recall. `supplierLotNumber` is the supplier's own ref (different from the
  // internal `lotNumber`), `receivedAt` is when the material lot was
  // physically received. All three are nullable for back-compat with the
  // "Ingredient" rows that have always populated only `lotNumber`.
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  supplierLotNumber: text("supplier_lot_number"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  // BR-1/BR-3 (Expiration tracking) — the expiry of the specific lot/material
  // consumed on this batch line. Snapshotted onto the row (auto-populated in the
  // ingredient dialog from the selected inventory lot, editable for un-lotted
  // materials) so the batch record/print shows the expiry that was in force at
  // time of use, independent of later changes to the source lot. Nullable for
  // back-compat with rows entered before expiry tracking.
  expirationDate: date("expiration_date"),
  // How much of `actualQuantity` we've already deducted from inventory_items
  // for this row. Used to compute the delta on PATCH so re-edits don't
  // double-decrement, and to refund on DELETE.
  invDecrementedQty: real("inv_decremented_qty").notNull().default(0),
  // Session 79 (Step 3) — how much of actualQuantity has been pulled from the
  // linked LOT via the signed "confirm ingredients" e-signature. The lot is the
  // visible on-hand ledger (Step 2); this is its draw-down bookkeeping so a
  // re-sign after an edit moves only the delta. Distinct from invDecrementedQty
  // (the legacy inventory_items catalog draw-down).
  lotCommittedQty: real("lot_committed_qty").notNull().default(0),
  // 2026-09-08 — RESERVED, nothing writes it yet. It would tie sibling rows
  // together when one recipe line is filled from several lots. ⛔ Jonathan
  // deliberately did NOT take that: mixing lots changes the potency number, so a
  // mixed line has to be re-tested and re-labelled, and two strains of flower
  // means two harvest dates on one package. Kept because the column is free and
  // the day it is wanted it will be wanted with this shape.
  parentIngredientId: integer("parent_ingredient_id"),
  // Set when Management or Quality authorised running the line SHORT: the lots
  // could not cover the plan and the batch went ahead anyway. Carries who, when
  // and why — the ledger is never allowed to invent the missing material.
  shortDrawApprovedByName: text("short_draw_approved_by_name"),
  shortDrawApprovedInitials: text("short_draw_approved_initials"),
  shortDrawReason: text("short_draw_reason"),
  shortDrawAt: timestamp("short_draw_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchIngredientSchema = createInsertSchema(batchIngredientsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBatchIngredient = z.infer<typeof insertBatchIngredientSchema>;
export type BatchIngredient = typeof batchIngredientsTable.$inferSelect;
