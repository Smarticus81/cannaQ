// ---------------------------------------------------------------------------
// What the approved LABEL carries — label-control step 4
// ---------------------------------------------------------------------------
//
// The model, complete at last:
//
//   the state's requirements for the batch's product type
//     − what the approved PACKAGING for that type carries or calls N/A  (step 2)
//     − what the approved LABEL TEMPLATE for that PRODUCT carries       (here)
//     = what is verified before this print
//
// ⛔ THE BATCH PULLS ITS TEMPLATE. His ruling 2026-08-31 — "can't the batch
// record just pull the approved label template version?" — so there is no
// picker, no default and no operator choice, exactly as with packaging. A
// product has at most ONE approved label (enforced at the approval gate in
// routes/label_templates.ts), so the pull is unambiguous.
//
// ⛔ A PRODUCT IS A RECIPE LINEAGE. Templates link to lineage ids, never to
// recipe row ids: "New Version" clones a recipe into a new row, so a link to a
// row would be orphaned by the next version of the very product it names.
//
// ⛔ Only "Packaging" coverage can be claimed on a template (the PUT route
// refuses the rest), so nothing here can subtract a THC number, a METRC tag or
// a harvest date, and the per-print checklist can never end up empty.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import { labelTemplatesTable, recipesTable, labelTemplateKeyFor } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface LabelTemplateCoverage {
  /** Requirement keys the approved label for this product carries. */
  carried: Set<string>;
  /** The template(s) the answer was computed from — for showing WHY a check is absent. */
  templates: Array<{ id: number; name: string; version: number }>;
}

const EMPTY: LabelTemplateCoverage = { carried: new Set(), templates: [] };

/**
 * Coverage for one batch.
 *
 * Resolution, in order:
 *   1. the batch's recipe → its LINEAGE → the approved template linked to it;
 *   2. failing that, the approved GENERIC templates of the same product type —
 *      a template naming no products is the label for "any Edible", which is
 *      what every template written before the product links existed is.
 *
 * A batch with no recipe, a product with no approved label, or a product type
 * Label Studio does not offer all return EMPTY, so nothing is subtracted and
 * every requirement stays on the per-print check. Silence means "ask", never
 * "covered".
 */
/**
 * The approved templates that apply to one batch.
 *
 * ⛔ EXPORTED ON PURPOSE, same reason as its packaging twin: the ingredient
 * tripwire must ask exactly the same question — "which approved artwork covers
 * this print?" — and resolving it twice is how the two come to disagree.
 */
export async function getApplicableLabelTemplates(batch: {
  recipeId: number | null;
  productType: string | null;
}): Promise<Array<typeof labelTemplatesTable.$inferSelect>> {
  const typeKey = labelTemplateKeyFor(batch.productType);
  if (!typeKey) return [];

  let lineageId: number | null = null;
  if (batch.recipeId != null) {
    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, batch.recipeId));
    if (recipe) lineageId = recipe.lineageId ?? recipe.id;
  }

  const approved = (await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.status, "approved")))
    .filter((t) => (t.productType ?? "").trim() === typeKey);
  if (approved.length === 0) return [];

  const linked = lineageId == null
    ? []
    : approved.filter((t) => (t.productLineageIds ?? []).includes(lineageId as number));
  return linked.length > 0
    ? linked
    : approved.filter((t) => (t.productLineageIds ?? []).length === 0);
}

export async function getLabelTemplateCoverage(batch: {
  recipeId: number | null;
  productType: string | null;
}): Promise<LabelTemplateCoverage> {
  // ⚠️ Label Studio stores SIX product types; a batch carries one of ten. The
  // bridge lives in getApplicableLabelTemplates above — resolving any other way
  // finds nothing for a Vape Cartridge.
  const matched = await getApplicableLabelTemplates(batch);
  if (matched.length === 0) return EMPTY;

  // One product, one approved label — so this is normally a single template and
  // `carried` is simply its list. Several can only happen on data that predates
  // the gate, or where a product falls back to more than one generic label; in
  // that case INTERSECT, the way packaging coverage does, so a disagreement
  // sends the requirement back onto the per-print check rather than dropping it.
  let carried: Set<string> | null = null;
  for (const t of matched) {
    const next = new Set(t.coverageKeys ?? []);
    if (carried === null) carried = next;
    else for (const k of [...carried]) if (!next.has(k)) carried.delete(k);
  }

  return {
    carried: carried ?? new Set<string>(),
    templates: matched.map((t) => ({ id: t.id, name: t.name, version: t.version })),
  };
}
