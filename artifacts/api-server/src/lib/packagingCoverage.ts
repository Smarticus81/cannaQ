// ---------------------------------------------------------------------------
// What the approved PACKAGING already carries — label-control step 2
// ---------------------------------------------------------------------------
//
// The model, in one line:
//
//   requirements for the batch's state
//     − what the approved packaging design for its PRODUCT TYPE carries
//     − what its label template carries   (step 4; not yet)
//     = what is verified before this print
//
// Nothing links a batch to a design by hand. Coverage is DERIVED: an Edible
// batch picks up whatever the approved Edible designs say the pouch carries.
// The operator is never asked to choose one.
//
// ⛔ 2026-09-02 — a design can now name the PRODUCTS it is for, so the derivation
// runs at two levels, exactly as the label's does:
//   1. the approved designs LINKED to this batch's product (the cookie pouch);
//   2. failing that, the approved GENERIC designs of its type (the cartridge
//      pouch, and every design written before the links existed).
// A product-specific pouch therefore REPLACES the generic one rather than
// intersecting with it — otherwise a generic Edible design would keep dragging
// the cookie pouch's answers back onto the per-print check.
//
// ⛔ INTERSECTION, NOT UNION. With several approved designs for one product
// type, a requirement is discharged only when EVERY one of them carries it.
// Jonathan's case: the Apple pouch is being fixed while Cherry and Lime are
// fine — edibles go back to checking that requirement on every print until
// Apple's replacement is approved. It degrades safely and needs no decision up
// front.
//
// ⛔ Only "Packaging" coverage discharges. A requirement whose value changes
// with the batch is refused that target when it is set (routes/packaging.ts),
// so nothing here can subtract a THC number, a METRC tag or a harvest date —
// which is why the per-print checklist can never end up empty.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import { packagingDesignsTable, recipesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { normalizeState } from "./regulatoryRules";

export interface PackagingCoverage {
  /** Requirement keys every approved design for this product type CARRIES. */
  carried: Set<string>;
  /**
   * Keys every approved design marked NOT APPLICABLE to this product — no health
   * claim is made, or it is the age statement this product does not use.
   * Kept apart from `carried` because the reason a question is absent is part of
   * the record: one says the pouch prints it, the other says nobody needs it.
   */
  notApplicable: Set<string>;
  /** Everything dropped from the per-print check, either way. */
  keys: Set<string>;
  /** The designs the answer was computed from — for showing WHY a check is absent. */
  designs: Array<{ id: number; designName: string; version: string }>;
}

const EMPTY: PackagingCoverage = { carried: new Set(), notApplicable: new Set(), keys: new Set(), designs: [] };

/**
 * Coverage for one product type in one state.
 *
 * A design counts only when it is APPROVED and approved FOR THIS STATE. Approval
 * is what makes the claim trustworthy: the sign route refuses both signatures
 * until every requirement the design claims has been verified on its Packaging
 * Compliance tab, so an Approved design is a verified one.
 */
/**
 * The approved designs that apply to one batch, in one state.
 *
 * ⛔ EXPORTED ON PURPOSE. The ingredient tripwire has to ask exactly the same
 * question — "which approved artwork covers this print?" — and if it resolved
 * that its own way the two would drift, so a design could be subtracting a
 * requirement while the tripwire never checked it. One resolution, two callers.
 */
export async function getApplicablePackagingDesigns(
  productType: string | null | undefined,
  state: string | null | undefined,
  batch?: { recipeId: number | null } | null,
): Promise<Array<typeof packagingDesignsTable.$inferSelect>> {
  const wanted = (productType ?? "").trim().toLowerCase();
  const stateKey = normalizeState(state);
  if (!wanted || !stateKey) return [];

  const rows = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.status, "Approved"));
  const forType = rows.filter((d) => {
    if ((d.productType ?? "").trim().toLowerCase() !== wanted) return false;
    const states = (d.approvedStates ?? []).map((s) => normalizeState(s));
    return states.includes(stateKey);
  });
  if (forType.length === 0) return [];

  // ⛔ A PRODUCT IS A RECIPE LINEAGE. Rows that predate lineage are backfilled to
  // their own id, so fall back the same way rather than dropping the product.
  let lineageId: number | null = null;
  if (batch?.recipeId != null) {
    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, batch.recipeId));
    if (recipe) lineageId = recipe.lineageId ?? recipe.id;
  }

  const linked = lineageId == null
    ? []
    : forType.filter((d) => (d.productLineageIds ?? []).includes(lineageId as number));
  return linked.length > 0
    ? linked
    : forType.filter((d) => (d.productLineageIds ?? []).length === 0);
}

export async function getPackagingCoverage(
  productType: string | null | undefined,
  state: string | null | undefined,
  batch?: { recipeId: number | null } | null,
): Promise<PackagingCoverage> {
  const designs = await getApplicablePackagingDesigns(productType, state, batch);
  // No approved design for this product in this state means the pouch carries
  // nothing as far as the record is concerned, so nothing is subtracted.
  // ⛔ Silence means "ask", never "covered".
  if (designs.length === 0) return EMPTY;

  // Intersect each answer separately. A requirement one design carries and
  // another calls not applicable is neither, by both counts — so it goes back on
  // the per-print check, which is the safe way for a disagreement to land.
  const intersect = (acc: Set<string> | null, next: Set<string>): Set<string> => {
    if (acc === null) return next;
    for (const k of [...acc]) if (!next.has(k)) acc.delete(k);
    return acc;
  };
  let carried: Set<string> | null = null;
  let notApplicable: Set<string> | null = null;
  for (const d of designs) {
    const entries = Object.entries(d.requirementTargets ?? {});
    carried = intersect(carried, new Set(entries.filter(([, t]) => t === "Packaging").map(([k]) => k)));
    notApplicable = intersect(notApplicable, new Set(entries.filter(([, t]) => t === "NotApplicable").map(([k]) => k)));
  }
  const carriedSet = carried ?? new Set<string>();
  const naSet = notApplicable ?? new Set<string>();

  return {
    carried: carriedSet,
    notApplicable: naSet,
    keys: new Set<string>([...carriedSet, ...naSet]),
    designs: designs.map((d) => ({ id: d.id, designName: d.designName, version: d.version })),
  };
}
