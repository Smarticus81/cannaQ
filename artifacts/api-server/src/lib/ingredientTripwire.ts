// ---------------------------------------------------------------------------
// The ingredient tripwire — 2026-09-02
// ---------------------------------------------------------------------------
//
// The problem, in one line: artwork that prints the ingredients is RECIPE-DERIVED,
// so changing the recipe makes already-approved artwork wrong, and nothing said so.
//
// A pouch printing "Ingredients: flour, butter, sugar, cannabis distillate" was
// verified against the recipe as it stood the day two people signed it. Take the
// butter out of the recipe the following week and that pouch is now a false
// statement on a package — but it is still Approved, still subtracting the
// ingredients requirement from every print, and nothing in the record has moved.
//
// ⛔ HIS RULING 2026-09-02, option (a) of the two I put to him:
//   the recipe edit GOES THROUGH — a label must never stop production changing a
//   recipe — and the approved artwork that prints ingredients is flagged and
//   cannot be PRINTED until somebody re-approves it.
// ⛔ NOT option (b). This is deliberately NOT the recipe→WI rule of
//   [[recipe-wi-change-control]], which blocks the recipe edit itself. A work
//   instruction is the procedure; a pouch is downstream of it.
//
// DERIVED, NEVER STORED. Staleness is "this artwork was approved before the
// recipe's contents last changed", computed from two timestamps that already
// exist: recipes.contentRevisedAt (stamped by every recipe item/step mutation —
// built 08-25) and the artwork's own approval timestamp. Nothing to backfill,
// nothing to keep in sync, and re-approving clears it by definition because the
// new signature is later than the change.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import { recipesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getApplicablePackagingDesigns } from "./packagingCoverage";
import { getApplicableLabelTemplates } from "./labelTemplateCoverage";

/**
 * The requirement keys that make artwork recipe-derived.
 *
 * Both are Michigan R 420.403 and both are "Packaging" control, so both can be
 * claimed by a pouch or by a sticker. If a state rule set adds another key whose
 * text comes out of the recipe, it belongs here.
 */
export const INGREDIENT_KEYS: readonly string[] = ["ingredients", "inactive-ingredients"];

export interface StaleArtwork {
  kind: "packaging" | "label";
  id: number;
  name: string;
  version: string;
  /** The ingredient keys this artwork claims to carry. */
  keys: string[];
  approvedAt: string | null;
  recipeChangedAt: string;
  /** Plain words for the person who has to fix it. */
  howToClear: string;
}

/** The later of two possible signing moments; null only if both are missing. */
function latest(...dates: Array<Date | null | undefined>): Date | null {
  const real = dates.filter((d): d is Date => d instanceof Date);
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * Approved artwork for this batch that prints ingredients and predates the last
 * change to its recipe's contents.
 *
 * Empty is the normal answer, and empty is what a caller must treat as "fine" —
 * a batch with no recipe, a recipe never edited since approval, or artwork that
 * claims no ingredient key all return nothing.
 *
 * ⛔ The artwork is resolved through the SAME two helpers that decide coverage,
 * so what the tripwire checks is exactly what the checklist subtracts. Resolving
 * it separately is how the two would come to disagree.
 */
export async function getStaleIngredientArtwork(
  batch: { recipeId: number | null; productType: string | null },
  state: string | null | undefined,
): Promise<StaleArtwork[]> {
  if (batch.recipeId == null) return [];
  const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, batch.recipeId));
  // No recipe, or a recipe whose contents have never been edited since the
  // column existed, means there is nothing for artwork to be out of date with.
  if (!recipe?.contentRevisedAt) return [];
  const changedAt = recipe.contentRevisedAt;

  const stale: StaleArtwork[] = [];

  for (const d of await getApplicablePackagingDesigns(batch.productType, state, batch)) {
    const claimed = Object.entries(d.requirementTargets ?? {})
      .filter(([k, t]) => t === "Packaging" && INGREDIENT_KEYS.includes(k))
      .map(([k]) => k);
    if (claimed.length === 0) continue;
    // Both signatures make the approval, so the approval happened at the later
    // of the two. approvalDate covers the legacy single-signature rows.
    const approvedAt = latest(d.qualityApprovedAt, d.managerApprovedAt, d.approvalDate);
    if (approvedAt && approvedAt.getTime() >= changedAt.getTime()) continue;
    stale.push({
      kind: "packaging",
      id: d.id,
      name: d.designName,
      version: d.version,
      keys: claimed,
      approvedAt: approvedAt ? approvedAt.toISOString() : null,
      recipeChangedAt: changedAt.toISOString(),
      // ⛔ An approved design cannot be edited back into draft, so the only way
      // out is a new version — which is the same answer its product list gives.
      howToClear: "Check the artwork against the recipe as it now stands, then raise a new version of this design and have it signed again.",
    });
  }

  for (const t of await getApplicableLabelTemplates(batch)) {
    const claimed = (t.coverageKeys ?? []).filter((k) => INGREDIENT_KEYS.includes(k));
    if (claimed.length === 0) continue;
    const approvedAt = latest(t.approvalDate, t.regulatoryApprovedAt);
    if (approvedAt && approvedAt.getTime() >= changedAt.getTime()) continue;
    stale.push({
      kind: "label",
      id: t.id,
      name: t.name,
      version: String(t.version),
      keys: claimed,
      approvedAt: approvedAt ? approvedAt.toISOString() : null,
      recipeChangedAt: changedAt.toISOString(),
      howToClear: "Check the printed ingredients against the recipe as it now stands, upload the corrected proof under Edit, and sign Meets Requirements again.",
    });
  }

  return stale;
}

/** One plain sentence naming what is stale, for a 409 body or a red band. */
export function staleArtworkMessage(stale: StaleArtwork[]): string {
  const names = stale.map((x) => `${x.name} v${x.version}`).join(" and ");
  return `This product's recipe changed after ${names} was approved, and that artwork prints the ingredients. Check it against the recipe as it now stands and have it approved again before printing.`;
}
