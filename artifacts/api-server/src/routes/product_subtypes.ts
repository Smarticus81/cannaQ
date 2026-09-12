import { Router } from "express";
import { db } from "@workspace/db";
import { productSubtypesTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

const router = Router();

// Facility-managed product subtypes (Settings → Product Setup). A subtype is an
// operational sub-form within a product type; it does NOT drive labeling or
// regulatory routing. Size-style subtypes may carry an optional default net
// weight + unit that pre-fills a recipe's net weight when the subtype is picked.

// Coerce the optional net-weight default (arrives as a string from the form) to a
// number or null so drizzle doesn't choke on "".
function coerceNetWeight(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// GET /product-subtypes            → all subtypes (any type)
// GET /product-subtypes?productType=Concentrate → just that type's subtypes
router.get("/product-subtypes", async (req, res) => {
  try {
    const productType = typeof req.query.productType === "string" ? req.query.productType.trim() : null;
    const rows = productType
      ? await db
          .select()
          .from(productSubtypesTable)
          .where(eq(productSubtypesTable.productType, productType))
          .orderBy(asc(productSubtypesTable.sortOrder), asc(productSubtypesTable.name))
      : await db
          .select()
          .from(productSubtypesTable)
          .orderBy(asc(productSubtypesTable.productType), asc(productSubtypesTable.sortOrder), asc(productSubtypesTable.name));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list product subtypes");
    res.status(500).json({ error: "Failed to list product subtypes" });
  }
});

router.post("/product-subtypes", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.productType?.trim() || !body.name?.trim()) {
      res.status(400).json({ error: "productType and name are required" });
      return;
    }
    const productType = String(body.productType).trim();
    const name = String(body.name).trim();

    // Case-insensitive duplicate guard (the DB unique index is case-sensitive; we
    // don't want "Live Resin" and "live resin" both under Concentrate).
    const siblings = await db
      .select({ name: productSubtypesTable.name })
      .from(productSubtypesTable)
      .where(eq(productSubtypesTable.productType, productType));
    if (siblings.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `"${name}" already exists under ${productType}` });
      return;
    }

    const [row] = await db
      .insert(productSubtypesTable)
      .values({
        productType,
        name,
        defaultNetWeight: coerceNetWeight(body.defaultNetWeight),
        defaultNetWeightUnit: body.defaultNetWeightUnit?.trim() || null,
        sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
        active: body.active ?? true,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create product subtype");
    res.status(500).json({ error: "Failed to create product subtype" });
  }
});

router.patch("/product-subtypes/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if ("name" in body && String(body.name ?? "").trim()) patch.name = String(body.name).trim();
    if ("defaultNetWeight" in body) patch.defaultNetWeight = coerceNetWeight(body.defaultNetWeight);
    if ("defaultNetWeightUnit" in body) {
      const u = body.defaultNetWeightUnit;
      patch.defaultNetWeightUnit = u == null || String(u).trim() === "" ? null : String(u).trim();
    }
    if ("sortOrder" in body && typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
    if ("active" in body) patch.active = Boolean(body.active);

    const [row] = await db
      .update(productSubtypesTable)
      .set(patch as never)
      .where(eq(productSubtypesTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "Subtype not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update product subtype");
    res.status(500).json({ error: "Failed to update product subtype" });
  }
});

router.delete("/product-subtypes/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.delete(productSubtypesTable).where(eq(productSubtypesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Subtype not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product subtype");
    res.status(500).json({ error: "Failed to delete product subtype" });
  }
});

export default router;
