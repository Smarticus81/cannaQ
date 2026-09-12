import { db, recipesTable, documentsTable } from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull } from "drizzle-orm";

/**
 * RECIPE RELEASE CONTROL — his rulings, 2026-09-07.
 *
 * A batch may only link a RELEASED recipe: *"The in-process (and new) batches
 * cannot link to a recipe until the recipe has been released / made effective."*
 * A recipe is released when its linked work instruction is Effective —
 * *"in reality, the WI and recipe will release together"* — so a recipe can be
 * drafted alongside its WI (the Corporate-recipe case) and neither is usable
 * until the document comes into force.
 *
 * ⛔ Release is DERIVED from the document, never mirrored onto the recipe. A
 * document reaches Effective by four separate paths (the approver's manual mark,
 * the scheduled release on its declared date, training completion, and the
 * training route's own mark); a copy on the recipe would drift the first time
 * one of them changed. Deriving cannot drift.
 *
 * The single stored exception is `recipes.grandfathered_at`, stamped once by the
 * ensureSchema backfill on the deploy that introduced this rule — those recipes
 * predate the linked-WI requirement and blocking them would have taken the app
 * offline. His call: "Yes, grandfather everything in."
 */

/** A document in one of these states puts its recipe into force. */
const RELEASING_DOC_STATUSES = ["Effective"];

export type RecipeRelease = {
  released: boolean;
  /** Why a recipe is not usable — shown to the operator, not swallowed. */
  reason: string | null;
  /** True when release comes from the pre-rule backfill rather than a live WI. */
  grandfathered: boolean;
};

const NOT_RELEASED =
  "This recipe has not been released. A recipe comes into force when its linked work instruction becomes Effective — approve and release the work instruction, then start the batch.";
const NO_DOCUMENT =
  "This recipe has no linked work instruction. Every recipe must link to a controlled document, and the recipe is released when that document becomes Effective.";

/**
 * Resolve release state for a set of recipe ids in two queries, so a list
 * endpoint never fans out one query per row.
 */
export async function resolveRecipeRelease(recipeIds: number[]): Promise<Map<number, RecipeRelease>> {
  const out = new Map<number, RecipeRelease>();
  const ids = Array.from(new Set(recipeIds.filter((n) => Number.isFinite(n))));
  if (ids.length === 0) return out;

  const recipes = await db
    .select({ id: recipesTable.id, grandfatheredAt: recipesTable.grandfatheredAt })
    .from(recipesTable)
    .where(inArray(recipesTable.id, ids));

  const linked = await db
    .select({ recipeId: documentsTable.recipeId, status: documentsTable.status })
    .from(documentsTable)
    .where(and(
      inArray(documentsTable.recipeId, ids),
      isNull(documentsTable.cancelledAt),
    ));

  const hasAnyDoc = new Set<number>();
  const hasEffectiveDoc = new Set<number>();
  for (const d of linked) {
    if (d.recipeId == null) continue;
    hasAnyDoc.add(d.recipeId);
    if (RELEASING_DOC_STATUSES.includes(d.status)) hasEffectiveDoc.add(d.recipeId);
  }

  for (const r of recipes) {
    const grandfathered = r.grandfatheredAt != null;
    const released = grandfathered || hasEffectiveDoc.has(r.id);
    out.set(r.id, {
      released,
      grandfathered,
      reason: released ? null : hasAnyDoc.has(r.id) ? NOT_RELEASED : NO_DOCUMENT,
    });
  }
  return out;
}

/** Single-recipe convenience. Unknown ids come back not-released, not thrown. */
export async function getRecipeRelease(recipeId: number): Promise<RecipeRelease> {
  const map = await resolveRecipeRelease([recipeId]);
  return map.get(recipeId) ?? { released: false, reason: NOT_RELEASED, grandfathered: false };
}

/** Ids of every recipe currently released. Used where the whole list is needed. */
export async function releasedRecipeIdSet(): Promise<Set<number>> {
  const grandfathered = await db
    .select({ id: recipesTable.id })
    .from(recipesTable)
    .where(isNotNull(recipesTable.grandfatheredAt));
  const effective = await db
    .select({ recipeId: documentsTable.recipeId })
    .from(documentsTable)
    .where(and(
      eq(documentsTable.status, "Effective"),
      isNull(documentsTable.cancelledAt),
      isNotNull(documentsTable.recipeId),
    ));
  const set = new Set<number>(grandfathered.map((r) => r.id));
  for (const d of effective) if (d.recipeId != null) set.add(d.recipeId);
  return set;
}
