/**
 * BOM line KINDS — the server's copy of the vocabulary the recipe BOM editor,
 * the batch ingredient dialog and the inline-BOM path all write.
 * Mirrors BOM_KINDS in cannaqms/src/lib/units.ts. Keep the two in step.
 *
 * "Ingredient" and "Material" are consumed in PRODUCTION and must be drawn from
 * inventory before a batch can be released. "Packaging" and "Labeling" are
 * consumed at the PACKAGING stage, after testing — a compliance label carries
 * the test results, so it cannot be applied before they exist. That distinction
 * is the point of the list: isPackagingStageKind() is what keeps the
 * pre-release draw-down gate off them.
 *
 * `kind` is a free-text column with a default of "Ingredient", so widening this
 * list needs no migration; rows written under the old two-value vocabulary keep
 * the value they have.
 * (2026-09-07, Jonathan: "let's add Packaging and Labeling as options to the
 * Recipes. Not just Ingredient and Material.")
 */
export const BOM_KINDS = ["Ingredient", "Material", "Packaging", "Labeling"] as const;
export type BomKind = (typeof BOM_KINDS)[number];

const KIND_SET = new Set<string>(BOM_KINDS);

/**
 * Coerce whatever arrived on the wire to a known kind, defaulting to
 * "Ingredient". Both write paths used to hard-code
 * `kind === "Material" ? "Material" : "Ingredient"`, which SILENTLY rewrote a
 * Packaging line as an Ingredient — the line would then be demanded by the
 * pre-release draw gate and would never reach the Packaging tab.
 */
export function normalizeBomKind(value: unknown): BomKind {
  const v = typeof value === "string" ? value.trim() : "";
  return (KIND_SET.has(v) ? v : "Ingredient") as BomKind;
}

/** True for lines consumed at packaging rather than in production. */
export function isPackagingStageKind(kind: string | null | undefined): boolean {
  const k = (kind ?? "").trim();
  return k === "Packaging" || k === "Labeling";
}
