import { Router } from "express";
import { db } from "@workspace/db";
import { productTypeSettingsTable, auditLogTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";

const router = Router();

// The canonical product types + the shelf-life defaults that used to be hardcoded
// in routes/batches.ts (LABEL_SHELF_LIFE_DAYS). Seeded on first read so Product
// Setup always shows a row per type and expiration keeps computing as before.
const PRODUCT_TYPE_SEED: { productType: string; shelfLifeDays: number }[] = [
  { productType: "Flower", shelfLifeDays: 365 },
  { productType: "Pre-Roll", shelfLifeDays: 365 },
  { productType: "Infused Pre-Roll", shelfLifeDays: 365 },
  { productType: "Vape Cartridge", shelfLifeDays: 365 },
  { productType: "Dual Chamber Vape Cartridge", shelfLifeDays: 365 },
  { productType: "Concentrate", shelfLifeDays: 365 },
  { productType: "Edible", shelfLifeDays: 180 },
  { productType: "Tincture", shelfLifeDays: 365 },
  { productType: "Topical", shelfLifeDays: 365 },
  { productType: "Capsule", shelfLifeDays: 180 },
];

// Legacy short name -> canonical descriptive name (preserve the row settings).
const PRODUCT_TYPE_RENAMES: Record<string, string> = { "Vape": "Vape Cartridge" };

async function listSeeded() {
  const existing = await db.select().from(productTypeSettingsTable);
  const names = new Set(existing.map((r) => r.productType));
  let changed = false;
  for (const [oldName, newName] of Object.entries(PRODUCT_TYPE_RENAMES)) {
    if (names.has(oldName) && !names.has(newName)) {
      await db.update(productTypeSettingsTable).set({ productType: newName }).where(eq(productTypeSettingsTable.productType, oldName));
      names.delete(oldName); names.add(newName); changed = true;
    }
  }
  const missing = PRODUCT_TYPE_SEED.filter((s) => !names.has(s.productType));
  if (missing.length) { await db.insert(productTypeSettingsTable).values(missing).onConflictDoNothing(); changed = true; }
  return changed ? db.select().from(productTypeSettingsTable) : existing;
}

const TEXT_FIELDS = ["defaultNetWeightUnit", "servingSize", "activationTime"] as const;
const INT_FIELDS = ["shelfLifeDays", "servingsPerPackage"] as const;
const REAL_FIELDS = ["defaultNetWeight"] as const;

// Only accept known fields, and coerce numeric inputs (which arrive as strings
// from the form) into numbers or null so drizzle doesn't choke on "".
function coerce(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) {
    if (k in body) {
      const v = body[k];
      out[k] = v == null || String(v).trim() === "" ? null : String(v).trim();
    }
  }
  for (const k of INT_FIELDS) {
    if (k in body) {
      const v = body[k];
      const n = v == null || v === "" ? null : Number.parseInt(String(v), 10);
      out[k] = n == null || Number.isNaN(n) ? null : n;
    }
  }
  for (const k of REAL_FIELDS) {
    if (k in body) {
      const v = body[k];
      const n = v == null || v === "" ? null : Number(v);
      out[k] = n == null || Number.isNaN(n) ? null : n;
    }
  }
  return out;
}

router.get("/product-type-settings", async (req, res) => {
  try {
    const rows = await listSeeded();
    rows.sort((a, b) => a.productType.localeCompare(b.productType));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list product type settings");
    res.status(500).json({ error: "Failed to list product type settings" });
  }
});

router.patch("/product-type-settings/:productType", async (req, res) => {
  try {
    const productType = req.params.productType;
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const patch = coerce((req.body ?? {}) as Record<string, unknown>);
    patch.updatedByName = actor?.fullName ?? null;

    const [before] = await db
      .select()
      .from(productTypeSettingsTable)
      .where(eq(productTypeSettingsTable.productType, productType));

    // Upsert: update an existing product type, or create the row if this is a
    // product type not seeded yet.
    const [updated] = before
      ? await db
          .update(productTypeSettingsTable)
          .set(patch as Partial<typeof productTypeSettingsTable.$inferInsert>)
          .where(eq(productTypeSettingsTable.productType, productType))
          .returning()
      : await db
          .insert(productTypeSettingsTable)
          .values({ productType, ...patch } as typeof productTypeSettingsTable.$inferInsert)
          .returning();

    void db
      .insert(auditLogTable)
      .values({
        tableName: "product_type_settings",
        rowId: updated.id,
        operation: before ? "UPDATE" : "INSERT",
        changedBy: actor?.id ?? null,
        changedByName: actor?.fullName ?? null,
        beforeState: (before ?? null) as unknown as Record<string, unknown> | null,
        afterState: updated as unknown as Record<string, unknown>,
      })
      .catch(() => {});

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update product type settings");
    res.status(500).json({ error: "Failed to update product type settings" });
  }
});

export default router;
