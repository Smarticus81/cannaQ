import { db } from "@workspace/db";
import { lotsTable, inventoryItemsTable } from "@workspace/db";
import { and, eq, ne, or } from "drizzle-orm";

// Session 79 (Step 2) — single source of truth for "what's on hand as raw
// materials & ingredients". The lots table is the shared on-hand ledger
// (Session 77/78); the Inventory screen and the inventory digest both read
// THIS view so they can never drift from Lot Traceability again.
//
// Scope = raw materials / incoming + RELEASED intermediates:
//   - status = 'Active'        (consumed/recalled/expired lots drop off)
//   - origin <> 'produced' OR available_as_ingredient = true
//                              (finished goods / batch outputs are tracked
//                               elsewhere, NOT on the Inventory screen — per
//                               Jonathan's 06-24 call — UNLESS a produced lot
//                               has been released as an ingredient via the
//                               Part 11 promote disposition, in which case it
//                               belongs in raw-material inventory like a
//                               cannabutter/distillate the operator consumes
//                               downstream — follow-up #2)
//
// Quantity comes straight off each lot's live currentQuantity, so the Inventory
// rollup always equals the sum of the underlying lots by construction. Reorder
// thresholds still live on the inventory_items catalog row each lot is linked
// to (lots.inventory_item_id, set at receiving), so low-stock continues to work.
export type InventoryViewRow = {
  id: number;
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  quantity: number;
  lotNumber: string | null;
  origin: string;
  status: string;
  isCannabis: boolean;
  availableAsIngredient: boolean;
  supplierId: number | null;
  inventoryItemId: number | null;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  sourceInspectionItemId: number | null;
  // BR-1/BR-3 — lot expiry, so the ingredient dialog can auto-populate the
  // Expiration Date from the picked lot. Null when no expiry was captured.
  expirationDate: string | null;
  // Potency (2026-09-06) — THC/CBD carried by a CANNABIS lot, so the Inventory
  // screen can show an operator what a lot actually assays at before they pick
  // it. Null means UNKNOWN (not tested, or COA not yet recorded) — never zero.
  // potencySource says where the number came from: 'manual' | 'metrc' | 'batch'.
  thcPct: number | null;
  cbdPct: number | null;
  potencySource: string | null;
  potencyTestedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listInventoryView(): Promise<InventoryViewRow[]> {
  const rows = await db
    .select({
      id: lotsTable.id,
      itemName: lotsTable.itemName,
      itemType: lotsTable.itemType,
      unitOfMeasure: lotsTable.unitOfMeasure,
      quantity: lotsTable.currentQuantity,
      lotNumber: lotsTable.lotNumber,
      origin: lotsTable.origin,
      status: lotsTable.status,
      isCannabis: lotsTable.isCannabis,
      availableAsIngredient: lotsTable.availableAsIngredient,
      supplierId: lotsTable.supplierId,
      inventoryItemId: lotsTable.inventoryItemId,
      reorderPoint: inventoryItemsTable.reorderPoint,
      reorderQuantity: inventoryItemsTable.reorderQuantity,
      sourceInspectionItemId: inventoryItemsTable.sourceInspectionItemId,
      expirationDate: lotsTable.expirationDate,
      thcPct: lotsTable.thcPct,
      cbdPct: lotsTable.cbdPct,
      potencySource: lotsTable.potencySource,
      potencyTestedAt: lotsTable.potencyTestedAt,
      createdAt: lotsTable.createdAt,
      updatedAt: lotsTable.updatedAt,
    })
    .from(lotsTable)
    .leftJoin(inventoryItemsTable, eq(lotsTable.inventoryItemId, inventoryItemsTable.id))
    .where(and(
      eq(lotsTable.status, "Active"),
      or(ne(lotsTable.origin, "produced"), eq(lotsTable.availableAsIngredient, true)),
    ))
    .orderBy(lotsTable.itemName);
  return rows;
}
