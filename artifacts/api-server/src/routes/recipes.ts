import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { recipesTable, recipeItemsTable, recipeProcessStepsTable, documentsTable } from "@workspace/db";
import { eq, asc, and, inArray, isNull } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { normalizeBomKind } from "../lib/bomKinds";
import { resolveRecipeRelease } from "../lib/recipeRelease";

const router = Router();

// Activate/deactivate a recipe is limited to Admin and Manager (Jonathan, 2026-08-09).
// Creating a new version (change control) uses the same gate.
const RECIPE_TOGGLE_ROLES = new Set(["Admin", "Manager"]);

// Change-control guard: a recipe version whose supersededByRecipeId is set is
// FROZEN — a newer version replaced it, so its BOM/steps/attributes are locked.
// Returns true (and writes a 409) when the recipe is frozen; false when editable.
async function frozenBlock(recipeId: number, res: Response): Promise<boolean> {
  const [rec] = await db
    .select({ supersededBy: recipesTable.supersededByRecipeId })
    .from(recipesTable)
    .where(eq(recipesTable.id, recipeId));
  if (rec && rec.supersededBy != null) {
    res.status(409).json({ error: "This recipe version is frozen. Create a new version to make changes." });
    return true;
  }
  return false;
}

// Change-control guard against LINKED CONTROLLED DOCUMENTS (2026-08-25).
//
// A work instruction does not copy its procedure - it POINTS at this recipe, and
// the WI's printed steps are read live from recipe_process_steps. So editing a
// recipe's BOM or steps edits the work instruction, and the two must never
// diverge (Jonathan, 2026-08-25: "Process steps in the document and the steps in
// a recipe must not be different. They are both a part of document control if
// the WI is updated.").
//
// While a linked WI is Approved or Effective the recipe's CONTENT is therefore
// locked. Two deliberate, audited ways forward - both of which keep the document
// and the procedure in step:
//   1. Start a revision on the work instruction. Once it is Draft / Under Review
//      a change cycle is open, this unlocks, and the existing approval gate makes
//      the approver re-confirm the recipe before the WI can go effective again.
//   2. Create a new recipe version. The approved WI stays pinned to the now-frozen
//      version so nothing moves under it, and its "recipe updated to vN" banner
//      tells the owner to revise and re-link.
//
// NOTE this deliberately does NOT cover PATCH /recipes/:id (label attributes,
// dual-chamber config, active flag). Those are not the procedure and are not
// printed by the document.
const DOC_LOCKING_STATUSES = ["Approved", "Effective"];

async function linkedControlledDocs(recipeId: number) {
  return db
    .select({
      id: documentsTable.id,
      docNumber: documentsTable.docNumber,
      title: documentsTable.title,
      status: documentsTable.status,
      revision: documentsTable.revision,
    })
    .from(documentsTable)
    .where(and(
      eq(documentsTable.recipeId, recipeId),
      inArray(documentsTable.status, DOC_LOCKING_STATUSES),
      isNull(documentsTable.cancelledAt),
    ));
}

// Returns true (and writes a 409 naming the documents) when this recipe's content
// is locked by an approved/effective work instruction; false when editable.
async function linkedDocBlock(recipeId: number, res: Response): Promise<boolean> {
  const locking = await linkedControlledDocs(recipeId);
  if (locking.length === 0) return false;
  const names = locking.map((d) => `${d.docNumber} (Rev ${d.revision}, ${d.status})`).join(", ");
  res.status(409).json({
    error:
      `This recipe is the approved procedure for ${names}. Changing its items or process steps would change ` +
      `that document. Start a revision on the work instruction, or create a new recipe version.`,
    lockedBy: locking,
  });
  return true;
}

// Stamp the recipe as content-revised. The version number only moves on "New
// Version", so this is what lets a linked WI know its procedure changed under an
// in-place edit. Called after every successful item / process-step mutation.
async function touchRecipeContent(recipeId: number): Promise<void> {
  await db.update(recipesTable)
    .set({ contentRevisedAt: new Date(), updatedAt: new Date() })
    .where(eq(recipesTable.id, recipeId));
}

// ── Recipes ───────────────────────────────────────────────────────────────────

router.get("/recipes", async (req, res) => {
  try {
    const rows = await db.select().from(recipesTable).orderBy(asc(recipesTable.productName), asc(recipesTable.version));
    // 2026-09-07 — every row carries whether it is RELEASED and, when it is not,
    // WHY. The batch dialog shows unreleased recipes greyed out with the reason
    // rather than hiding them: a recipe that silently vanishes from the picker
    // reads as data loss, not as change control.
    const release = await resolveRecipeRelease(rows.map((r) => r.id));
    res.json(rows.map((r) => {
      const state = release.get(r.id);
      return {
        ...r,
        released: state?.released ?? false,
        releaseBlockedReason: state?.reason ?? null,
      };
    }));
  } catch (err) {
    req.log.error({ err }, "Failed to list recipes");
    res.status(500).json({ error: "Failed to list recipes" });
  }
});

router.post("/recipes", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.productName?.trim() || !body.productType?.trim()) {
      res.status(400).json({ error: "productName and productType are required" });
      return;
    }
    // Optional net-weight default, pre-filled from the chosen subtype's size on
    // the client (arrives as a number or string). Coerced to number | null.
    const netWeight =
      body.netWeight == null || body.netWeight === "" || Number.isNaN(Number(body.netWeight))
        ? null
        : Number(body.netWeight);
    const [row] = await db.insert(recipesTable).values({
      productName: String(body.productName).trim(),
      productType: String(body.productType).trim(),
      subtype: body.subtype?.trim() || null,
      version: typeof body.version === "number" ? body.version : 1,
      isActive: body.isActive ?? true,
      notes: body.notes ?? null,
      netWeight,
      netWeightUnit: body.netWeightUnit?.trim() || null,
    }).returning();
    // A brand-new recipe is its own lineage head (self-referential lineageId) so
    // the version switcher / freeze logic works without waiting for a restart-time
    // backfill. supersededByRecipeId stays null (this IS the current version).
    const [withLineage] = await db.update(recipesTable)
      .set({ lineageId: row.id })
      .where(eq(recipesTable.id, row.id))
      .returning();
    res.status(201).json(withLineage ?? row);
  } catch (err) {
    req.log.error({ err }, "Failed to create recipe");
    res.status(500).json({ error: "Failed to create recipe" });
  }
});

router.get("/recipes/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.select().from(recipesTable).where(eq(recipesTable.id, id));
    if (!row) { res.status(404).json({ error: "Recipe not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get recipe");
    res.status(500).json({ error: "Failed to get recipe" });
  }
});

// ── Version lineage (change control) ───────────────────────────────────────────

// All versions in a recipe's lineage, oldest → newest. The current ("head")
// version is the row whose supersededByRecipeId is null.
router.get("/recipes/:id/versions", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.select().from(recipesTable).where(eq(recipesTable.id, id));
    if (!row) { res.status(404).json({ error: "Recipe not found" }); return; }
    const lineage = row.lineageId ?? row.id;
    const rows = await db.select().from(recipesTable)
      .where(eq(recipesTable.lineageId, lineage))
      .orderBy(asc(recipesTable.version), asc(recipesTable.id));
    // A recipe predating the lineage backfill may still have a null lineageId;
    // fall back to this single row so the endpoint never returns empty.
    res.json(rows.length ? rows : [row]);
  } catch (err) {
    req.log.error({ err }, "Failed to list recipe versions");
    res.status(500).json({ error: "Failed to list recipe versions" });
  }
});

// Freeze the current recipe and spawn an editable v+1 clone (BOM items,
// approved process steps, and label/dual-chamber attributes copied over). The
// prior version is marked superseded (frozen, read-only) and deactivated so it
// drops out of the active list and the New Batch picker. Admin/Manager only.
router.post("/recipes/:id/new-version", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || !RECIPE_TOGGLE_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only an Admin or Manager can create a new recipe version." });
      return;
    }
    const [current] = await db.select().from(recipesTable).where(eq(recipesTable.id, id));
    if (!current) { res.status(404).json({ error: "Recipe not found" }); return; }
    if (current.supersededByRecipeId != null) {
      res.status(409).json({ error: "This version is already frozen. Open the current version to create a new one." });
      return;
    }
    const lineage = current.lineageId ?? current.id;
    const created = await db.transaction(async (tx) => {
      // 1. Clone the recipe row into a fresh, editable version.
      const [newRecipe] = await tx.insert(recipesTable).values({
        productType: current.productType,
        subtype: current.subtype,
        productName: current.productName,
        version: (current.version ?? 1) + 1,
        isActive: true,
        referenceUnitCount: current.referenceUnitCount,
        notes: current.notes,
        netWeight: current.netWeight,
        netWeightUnit: current.netWeightUnit,
        servingSize: current.servingSize,
        servingStrengthMg: current.servingStrengthMg,
        servingsPerPackage: current.servingsPerPackage,
        dualChamberTwoOils: current.dualChamberTwoOils,
        dualChamberCombinedDraw: current.dualChamberCombinedDraw,
        lineageId: lineage,
        supersededByRecipeId: null,
      }).returning();
      // 2. Copy BOM items.
      const items = await tx.select().from(recipeItemsTable).where(eq(recipeItemsTable.recipeId, id));
      if (items.length) {
        await tx.insert(recipeItemsTable).values(items.map((it) => ({
          recipeId: newRecipe.id,
          ingredientName: it.ingredientName,
          plannedQuantity: it.plannedQuantity,
          unitOfMeasure: it.unitOfMeasure,
          kind: it.kind,
          notes: it.notes,
          sortOrder: it.sortOrder,
        })));
      }
      // 3. Copy approved process steps.
      const steps = await tx.select().from(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.recipeId, id));
      if (steps.length) {
        await tx.insert(recipeProcessStepsTable).values(steps.map((s) => ({
          recipeId: newRecipe.id,
          stepNumber: s.stepNumber,
          description: s.description,
          template: s.template,
          instructions: s.instructions,
          sortOrder: s.sortOrder,
        })));
      }
      // 4. Freeze the prior version and (if needed) stamp its lineage id.
      await tx.update(recipesTable)
        .set({ supersededByRecipeId: newRecipe.id, isActive: false, lineageId: lineage, updatedAt: new Date() })
        .where(eq(recipesTable.id, id));
      return newRecipe;
    });
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to create new recipe version");
    res.status(500).json({ error: "Failed to create new recipe version" });
  }
});

// Every controlled document pinned to this recipe, whatever its status, plus
// whether they currently lock the recipe's content. Drives the change-control
// card on the recipe screen.
router.get("/recipes/:id/linked-documents", async (req, res) => {
  try {
    const recipeId = parseInt(req.params.id);
    const docs = await db
      .select({
        id: documentsTable.id,
        docNumber: documentsTable.docNumber,
        title: documentsTable.title,
        documentType: documentsTable.documentType,
        status: documentsTable.status,
        revision: documentsTable.revision,
        recipeUpdateFlagged: documentsTable.recipeUpdateFlagged,
      })
      .from(documentsTable)
      .where(and(eq(documentsTable.recipeId, recipeId), isNull(documentsTable.cancelledAt)))
      .orderBy(asc(documentsTable.docNumber));
    const locking = docs.filter((d) => DOC_LOCKING_STATUSES.includes(d.status));
    res.json({ documents: docs, locked: locking.length > 0, lockedBy: locking });
  } catch (err) {
    req.log.error({ err }, "Failed to list documents linked to recipe");
    res.status(500).json({ error: "Failed to list documents linked to recipe" });
  }
});

router.patch("/recipes/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Frozen (superseded) versions are read-only — make a new version to change them.
    if (await frozenBlock(id, res)) return;
    // Activate/deactivate is restricted to Admin and Manager. Other recipe
    // edits (label attributes, dual-chamber config, etc.) are unaffected.
    if (req.body.isActive !== undefined) {
      const actor = await getOrProvisionCurrentUser(req).catch(() => null);
      if (!actor || !RECIPE_TOGGLE_ROLES.has(actor.role)) {
        res.status(403).json({ error: "Only an Admin or Manager can activate or deactivate a recipe." });
        return;
      }
    }
    const [row] = await db.update(recipesTable)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(recipesTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "Recipe not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update recipe");
    res.status(500).json({ error: "Failed to update recipe" });
  }
});

router.delete("/recipes/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.delete(recipesTable).where(eq(recipesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Recipe not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete recipe");
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

// ── Recipe items ──────────────────────────────────────────────────────────────

router.get("/recipes/:id/items", async (req, res) => {
  try {
    const recipeId = parseInt(req.params.id);
    const rows = await db.select().from(recipeItemsTable)
      .where(eq(recipeItemsTable.recipeId, recipeId))
      .orderBy(asc(recipeItemsTable.sortOrder), asc(recipeItemsTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list recipe items");
    res.status(500).json({ error: "Failed to list recipe items" });
  }
});

router.post("/recipes/:id/items", async (req, res) => {
  try {
    const recipeId = parseInt(req.params.id);
    const [exists] = await db.select({ id: recipesTable.id }).from(recipesTable).where(eq(recipesTable.id, recipeId));
    if (!exists) { res.status(404).json({ error: "Recipe not found" }); return; }
    if (await frozenBlock(recipeId, res)) return;
    if (await linkedDocBlock(recipeId, res)) return;
    const body = req.body ?? {};
    if (!body.ingredientName?.trim()) {
      res.status(400).json({ error: "ingredientName is required" });
      return;
    }
    const [row] = await db.insert(recipeItemsTable).values({
      recipeId,
      ingredientName: String(body.ingredientName).trim(),
      plannedQuantity: body.plannedQuantity ?? null,
      unitOfMeasure: body.unitOfMeasure ?? "g",
      kind: normalizeBomKind(body.kind),
      notes: body.notes ?? null,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    }).returning();
    await touchRecipeContent(recipeId);
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add recipe item");
    res.status(500).json({ error: "Failed to add recipe item" });
  }
});

router.patch("/recipe-items/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [item] = await db.select({ recipeId: recipeItemsTable.recipeId }).from(recipeItemsTable).where(eq(recipeItemsTable.id, id));
    if (!item) { res.status(404).json({ error: "Recipe item not found" }); return; }
    if (await frozenBlock(item.recipeId, res)) return;
    if (await linkedDocBlock(item.recipeId, res)) return;
    const [row] = await db.update(recipeItemsTable)
      .set(req.body)
      .where(eq(recipeItemsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "Recipe item not found" }); return; }
    await touchRecipeContent(item.recipeId);
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update recipe item");
    res.status(500).json({ error: "Failed to update recipe item" });
  }
});

router.delete("/recipe-items/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [item] = await db.select({ recipeId: recipeItemsTable.recipeId }).from(recipeItemsTable).where(eq(recipeItemsTable.id, id));
    if (!item) { res.status(404).json({ error: "Recipe item not found" }); return; }
    if (await frozenBlock(item.recipeId, res)) return;
    if (await linkedDocBlock(item.recipeId, res)) return;
    const [row] = await db.delete(recipeItemsTable).where(eq(recipeItemsTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Recipe item not found" }); return; }
    await touchRecipeContent(item.recipeId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete recipe item");
    res.status(500).json({ error: "Failed to delete recipe item" });
  }
});

// ── Recipe process steps (Session 59 — approved FDA GMP steps) ─────────────────

router.get("/recipes/:id/process-steps", async (req, res) => {
  try {
    const recipeId = parseInt(req.params.id);
    const rows = await db.select().from(recipeProcessStepsTable)
      .where(eq(recipeProcessStepsTable.recipeId, recipeId))
      .orderBy(asc(recipeProcessStepsTable.sortOrder), asc(recipeProcessStepsTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list recipe process steps");
    res.status(500).json({ error: "Failed to list recipe process steps" });
  }
});

router.post("/recipes/:id/process-steps", async (req, res) => {
  try {
    const recipeId = parseInt(req.params.id);
    const [exists] = await db.select({ id: recipesTable.id }).from(recipesTable).where(eq(recipesTable.id, recipeId));
    if (!exists) { res.status(404).json({ error: "Recipe not found" }); return; }
    if (await frozenBlock(recipeId, res)) return;
    if (await linkedDocBlock(recipeId, res)) return;
    const body = req.body ?? {};
    if (!body.description?.trim()) {
      res.status(400).json({ error: "Step description is required" });
      return;
    }
    // Default the step number / sort to the next slot if not supplied.
    const existing = await db.select({ sortOrder: recipeProcessStepsTable.sortOrder })
      .from(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.recipeId, recipeId));
    const nextSort = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), 0) + 1;
    const [row] = await db.insert(recipeProcessStepsTable).values({
      recipeId,
      stepNumber: typeof body.stepNumber === "number" ? body.stepNumber : nextSort,
      description: String(body.description).trim(),
      template: typeof body.template === "string" ? (body.template.trim() || null) : null,
      instructions: body.instructions ?? null,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : nextSort,
    }).returning();
    await touchRecipeContent(recipeId);
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add recipe process step");
    res.status(500).json({ error: "Failed to add recipe process step" });
  }
});

router.patch("/recipe-process-steps/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [step] = await db.select({ recipeId: recipeProcessStepsTable.recipeId }).from(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.id, id));
    if (!step) { res.status(404).json({ error: "Recipe process step not found" }); return; }
    if (await frozenBlock(step.recipeId, res)) return;
    if (await linkedDocBlock(step.recipeId, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Whitelist editable columns.
    const allowed: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["stepNumber", "description", "template", "instructions", "sortOrder"]) {
      if (k in body) allowed[k] = body[k];
    }
    const [row] = await db.update(recipeProcessStepsTable)
      .set(allowed as never)
      .where(eq(recipeProcessStepsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "Recipe process step not found" }); return; }
    await touchRecipeContent(step.recipeId);
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update recipe process step");
    res.status(500).json({ error: "Failed to update recipe process step" });
  }
});

router.delete("/recipe-process-steps/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [step] = await db.select({ recipeId: recipeProcessStepsTable.recipeId }).from(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.id, id));
    if (!step) { res.status(404).json({ error: "Recipe process step not found" }); return; }
    if (await frozenBlock(step.recipeId, res)) return;
    if (await linkedDocBlock(step.recipeId, res)) return;
    const [row] = await db.delete(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Recipe process step not found" }); return; }
    await touchRecipeContent(step.recipeId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete recipe process step");
    res.status(500).json({ error: "Failed to delete recipe process step" });
  }
});

export default router;
