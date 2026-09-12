// CannaQMS Starter Inventory Catalog — the common non-cannabis items each
// segment stocks (edible ingredients, vape/pre-roll hardware, cultivation
// inputs), so a new facility's item list isn't empty on day one. Seeded into
// inventory_items with quantity 0 and NO reorder point (the facility sets those
// to their own volumes), and flagged is_starter_default = true so the whole set
// is identifiable and REMOVABLE if the facility brings its own.
//
// Seeding/removal are Admin-only and idempotent (see routes/admin.ts).
import { db } from "@workspace/db";
import { inventoryItemsTable, auditLogTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export interface Actor {
  id: number;
  fullName: string;
}

export interface StarterItem {
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
}

const SEED_NOTE = "CannaQMS starter catalog item — edit or remove to fit your facility.";

// Item types here must match ITEM_TYPES in cannaqms/src/lib/units.ts:
// "Ingredient", "Component", "Nutrient", "Medium".
export const STARTER_INVENTORY: StarterItem[] = [
  // Ingredient — edibles (cookies, brownies, rice crispy squares, chocolates)
  { itemName: "Flour", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Granulated sugar", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Brown sugar", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Powdered sugar", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Unsalted butter", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Eggs", itemType: "Ingredient", unitOfMeasure: "each" },
  { itemName: "Milk / cream", itemType: "Ingredient", unitOfMeasure: "gal" },
  { itemName: "Vegetable oil", itemType: "Ingredient", unitOfMeasure: "gal" },
  { itemName: "Cocoa powder", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Chocolate (dark couverture)", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Chocolate (milk)", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Vanilla extract", itemType: "Ingredient", unitOfMeasure: "fl oz" },
  { itemName: "Salt", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Baking soda", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Baking powder", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Crisped rice cereal", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Marshmallow / creme", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Corn syrup / glucose", itemType: "Ingredient", unitOfMeasure: "lb" },
  { itemName: "Soy / sunflower lecithin", itemType: "Ingredient", unitOfMeasure: "g" },

  // Component — vape & pre-roll (processing)
  { itemName: "Mouthpieces", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Pre-roll cones - 84mm", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Pre-roll cones - 98mm", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Pre-roll cones - 109mm", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Cartridges - 1g", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Cartridges - 2g", itemType: "Component", unitOfMeasure: "each" },
  { itemName: "Batteries - 510 thread", itemType: "Component", unitOfMeasure: "each" },

  // Nutrient / Medium — grow inputs (generic categories, not brands)
  { itemName: "Base nutrient - Grow / Veg", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "Base nutrient - Bloom / Flower", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "Cal-Mag supplement", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "Silica supplement", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "Bloom booster / PK", itemType: "Nutrient", unitOfMeasure: "lb" },
  { itemName: "Root stimulant / beneficial microbes", itemType: "Nutrient", unitOfMeasure: "each" },
  { itemName: "pH Up", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "pH Down", itemType: "Nutrient", unitOfMeasure: "gal" },
  { itemName: "Growing media - coco / rockwool / soil", itemType: "Medium", unitOfMeasure: "each" },
];

// Idempotent by (item_name, is_starter_default). Re-running only inserts the
// starter items that are missing; anything already seeded is skipped.
export async function seedStarterInventory(actor: Actor) {
  return await db.transaction(async (tx) => {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const si of STARTER_INVENTORY) {
      const [exists] = await tx
        .select({ id: inventoryItemsTable.id })
        .from(inventoryItemsTable)
        .where(and(eq(inventoryItemsTable.itemName, si.itemName), eq(inventoryItemsTable.isStarterDefault, true)))
        .limit(1);
      if (exists) { skipped.push(si.itemName); continue; }
      const [item] = await tx
        .insert(inventoryItemsTable)
        .values({
          itemName: si.itemName,
          itemType: si.itemType,
          unitOfMeasure: si.unitOfMeasure,
          quantity: 0,
          notes: SEED_NOTE,
          isStarterDefault: true,
        })
        .returning({ id: inventoryItemsTable.id });
      await tx.insert(auditLogTable).values({
        tableName: "inventory_items",
        rowId: item.id,
        operation: "SEED_STARTER",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: null as never,
        afterState: { itemName: si.itemName, itemType: si.itemType } as never,
      });
      created.push(si.itemName);
    }
    return { created, skipped };
  });
}

// Removes the starter set. Only PRISTINE starter items are deleted — anything the
// facility has adopted (stocked a quantity, set a reorder point, assigned a
// supplier) is left alone and reported as skipped. Each delete is isolated so an
// item referenced elsewhere is skipped rather than aborting the whole batch.
export async function removeStarterInventory(actor: Actor) {
  const rows = await db.select().from(inventoryItemsTable).where(eq(inventoryItemsTable.isStarterDefault, true));
  const removed: string[] = [];
  const skipped: { itemName: string; reason: string }[] = [];
  for (const it of rows) {
    const touched =
      (it.quantity ?? 0) !== 0 ||
      it.reorderPoint != null ||
      it.reorderQuantity != null ||
      it.supplierId != null;
    if (touched) {
      skipped.push({ itemName: it.itemName, reason: "in use or configured" });
      continue;
    }
    try {
      await db.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, it.id));
      await db.insert(auditLogTable).values({
        tableName: "inventory_items",
        rowId: it.id,
        operation: "REMOVE_STARTER",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: { itemName: it.itemName } as never,
        afterState: { removed: true } as never,
      });
      removed.push(it.itemName);
    } catch {
      skipped.push({ itemName: it.itemName, reason: "referenced by other records" });
    }
  }
  return { removed, skipped };
}
