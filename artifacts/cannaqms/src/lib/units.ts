// ─────────────────────────────────────────────────────────────────────────────
// Unit conversion — canonical base-unit engine.
//
// Every quantity in CannaQMS carries a free-text unit label ("g", "lb", "units",
// "mL", …). To do correct stock math — e.g. draw a recipe measured in GRAMS down
// from an inventory lot received in POUNDS — we convert both sides to a canonical
// BASE unit per DIMENSION, do the arithmetic there, then convert back to whatever
// unit the ledger stores.
//
//   mass   → base gram        (g)
//   volume → base milliliter  (mL)
//   count  → base each        (unit)
//
// Conversion only makes sense WITHIN a dimension. Pounds↔grams is exact; a COUNT
// ("12 pre-rolls") cannot become grams without a per-unit weight, and mass↔volume
// needs a density. Cross-dimension requests are REFUSED, never guessed — the
// caller decides what to do (flag it, block a sign-off, etc.).
//
// Backward compatibility: if the two unit labels are byte-for-byte the same after
// normalization — even a custom label we don't recognize like "bag" or "case" —
// we treat the conversion as 1:1, which matches the app's historical behavior of
// subtracting raw numbers. So nothing that worked before breaks; we only ADD the
// ability to reconcile genuinely different units.
// ─────────────────────────────────────────────────────────────────────────────

export type Dimension = "mass" | "volume" | "count";

interface UnitDef {
  dim: Dimension;
  /** Multiply a quantity in this unit by `toBase` to get the dimension's base unit. */
  toBase: number;
}

// Alias table. Keys are the normalized (lowercased, single-spaced) unit labels.
// Factors use exact NIST definitions where they exist (avoirdupois pound/ounce,
// US liquid gallon and its subdivisions).
const UNIT_TABLE: Record<string, UnitDef> = {
  // ── mass (base = gram) ──
  g: { dim: "mass", toBase: 1 },
  gram: { dim: "mass", toBase: 1 },
  grams: { dim: "mass", toBase: 1 },
  mg: { dim: "mass", toBase: 0.001 },
  milligram: { dim: "mass", toBase: 0.001 },
  milligrams: { dim: "mass", toBase: 0.001 },
  kg: { dim: "mass", toBase: 1000 },
  kilogram: { dim: "mass", toBase: 1000 },
  kilograms: { dim: "mass", toBase: 1000 },
  lb: { dim: "mass", toBase: 453.59237 },
  lbs: { dim: "mass", toBase: 453.59237 },
  pound: { dim: "mass", toBase: 453.59237 },
  pounds: { dim: "mass", toBase: 453.59237 },
  oz: { dim: "mass", toBase: 28.349523125 },
  ounce: { dim: "mass", toBase: 28.349523125 },
  ounces: { dim: "mass", toBase: 28.349523125 },

  // ── volume (base = milliliter) ──
  ml: { dim: "volume", toBase: 1 },
  milliliter: { dim: "volume", toBase: 1 },
  milliliters: { dim: "volume", toBase: 1 },
  cc: { dim: "volume", toBase: 1 },
  l: { dim: "volume", toBase: 1000 },
  liter: { dim: "volume", toBase: 1000 },
  liters: { dim: "volume", toBase: 1000 },
  litre: { dim: "volume", toBase: 1000 },
  litres: { dim: "volume", toBase: 1000 },
  gal: { dim: "volume", toBase: 3785.411784 },
  gallon: { dim: "volume", toBase: 3785.411784 },
  gallons: { dim: "volume", toBase: 3785.411784 },
  qt: { dim: "volume", toBase: 946.352946 },
  quart: { dim: "volume", toBase: 946.352946 },
  quarts: { dim: "volume", toBase: 946.352946 },
  pt: { dim: "volume", toBase: 473.176473 },
  pint: { dim: "volume", toBase: 473.176473 },
  pints: { dim: "volume", toBase: 473.176473 },
  "fl oz": { dim: "volume", toBase: 29.5735295625 },
  floz: { dim: "volume", toBase: 29.5735295625 },
  "fluid ounce": { dim: "volume", toBase: 29.5735295625 },
  "fluid ounces": { dim: "volume", toBase: 29.5735295625 },
  tbsp: { dim: "volume", toBase: 14.78676478125 },
  tablespoon: { dim: "volume", toBase: 14.78676478125 },
  tablespoons: { dim: "volume", toBase: 14.78676478125 },
  tsp: { dim: "volume", toBase: 4.92892159375 },
  teaspoon: { dim: "volume", toBase: 4.92892159375 },
  teaspoons: { dim: "volume", toBase: 4.92892159375 },

  // ── count (base = each) ──
  unit: { dim: "count", toBase: 1 },
  units: { dim: "count", toBase: 1 },
  each: { dim: "count", toBase: 1 },
  eaches: { dim: "count", toBase: 1 },
  ea: { dim: "count", toBase: 1 },
  count: { dim: "count", toBase: 1 },
  ct: { dim: "count", toBase: 1 },
  pc: { dim: "count", toBase: 1 },
  pcs: { dim: "count", toBase: 1 },
  piece: { dim: "count", toBase: 1 },
  pieces: { dim: "count", toBase: 1 },
};

/** Lowercase, trim, and collapse internal whitespace so "  Fl  Oz " → "fl oz". */
export function normalizeUnit(u: string | null | undefined): string {
  return (u ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** The unit's definition, or null if we don't recognize the label. */
function unitDef(u: string | null | undefined): UnitDef | null {
  return UNIT_TABLE[normalizeUnit(u)] ?? null;
}

/** The unit's dimension ("mass" | "volume" | "count"), or null if unknown. */
export function dimensionOf(u: string | null | undefined): Dimension | null {
  return unitDef(u)?.dim ?? null;
}

/** True if we recognize this unit label. */
export function isKnownUnit(u: string | null | undefined): boolean {
  return unitDef(u) !== null;
}

/** True if the two units can be converted into one another (same dimension, or identical labels). */
export function areCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (normalizeUnit(a) === normalizeUnit(b)) return true;
  const da = dimensionOf(a);
  const db = dimensionOf(b);
  return da !== null && da === db;
}

export type ConvertResult =
  | { ok: true; value: number; sameUnit: boolean }
  | { ok: false; reason: "unknown-from" | "unknown-to" | "incompatible"; fromDim: Dimension | null; toDim: Dimension | null };

/**
 * Convert `qty` from `fromUnit` into `toUnit`.
 *  - Identical labels (after normalization) → 1:1, always ok (preserves legacy behavior for custom units).
 *  - Same dimension → exact conversion via the base unit.
 *  - Different dimensions, or an unrecognized label on either side → { ok:false } with a reason.
 * `qty` may be negative (refunds); conversion is linear so the sign is preserved.
 */
export function convertQuantity(
  qty: number,
  fromUnit: string | null | undefined,
  toUnit: string | null | undefined,
): ConvertResult {
  const fromN = normalizeUnit(fromUnit);
  const toN = normalizeUnit(toUnit);
  if (fromN === toN) return { ok: true, value: qty, sameUnit: true };

  const from = unitDef(fromUnit);
  const to = unitDef(toUnit);
  if (!from) return { ok: false, reason: "unknown-from", fromDim: null, toDim: to?.dim ?? null };
  if (!to) return { ok: false, reason: "unknown-to", fromDim: from.dim, toDim: null };
  if (from.dim !== to.dim) return { ok: false, reason: "incompatible", fromDim: from.dim, toDim: to.dim };

  return { ok: true, value: (qty * from.toBase) / to.toBase, sameUnit: false };
}

/** Round to a sensible number of decimals for display (trims float noise). */
export function roundQty(value: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session 111 — default unit by item / material type.
//
// Cannabis is WEIGHED, not measured by volume: an operator puts a jar on a
// scale, and Michigan METRC's plant/flower/concentrate categories are
// weight-based. A cannabis lot that lands in mL is nearly always a data-entry
// slip (or a METRC item defined in Milliliters), and it doesn't surface until a
// batch tries to draw from it — at which point the conversion is REFUSED,
// because mass↔volume needs a density this app deliberately won't guess.
//
// So: anywhere a cannabis item or lot is created in-app, default its unit to
// grams. This is a DEFAULT, never a lock — a real mL cannabis item (some
// beverages, tinctures by volume) is still selectable, and this never overwrites
// a unit the operator has already chosen.
//
// The cannabis test matches the convention already used across the app
// (InspectionDetail's METRC-tag and strain-type gating): the type label starts
// with "cannabis". Legacy rows still carry the older vocabularies — "Cannabis
// Flower" / "Cannabis Extract" (inventory) and "Cannabis – Concentrate/
// Distillate" (receiving) — and the prefix test covers those too.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single source of truth for item / material type.
 *
 * The inventory catalog (CreateInventoryItemDialog) and the incoming-inspection
 * screen (InspectionDetail) BOTH render this list. They used to keep separate
 * hardcoded copies, which drifted — "Packaging Material" vs "Packaging",
 * "Hardware/Component" vs no equivalent at all — so a type chosen at receiving
 * did not match the catalog and cross-screen lookups silently failed.
 *
 * Every cannabis type carries the "Cannabis – " prefix, which is load-bearing:
 * isCannabisItemType() below keys off it to demand a METRC package tag on
 * receiving and to default the unit to grams.
 *
 * "Consumable" is for things used up IN PRODUCTION — gloves, filters,
 * parchment, screens — where running out stops a run. It is deliberately
 * NOT general supplies (paper goods, office, breakroom); those stay out of
 * the QMS entirely. It gets no default unit below: consumables are bought
 * by the box, the sheet and the each, so the operator picks.
 *
 * Rows saved under the previous vocabularies are left as they are — nothing
 * here migrates existing data.
 */
export const ITEM_TYPES = [
  "Cannabis – Flower",
  "Cannabis – Extract",
  "Cannabis – Clones",
  "Cannabis – Other",
  "Ingredient",
  "Component",
  "Consumable",
  "Packaging",
  "Label",
  "Solvent",
  "Terpene",
  "Nutrient",
  "Medium",
  "Other",
] as const;

/**
 * BOM line KINDS — how a bill-of-materials line behaves on a batch.
 *
 * ⛔ ONE list. The recipe BOM editor, the batch ingredient dialog and the
 * inline-BOM path on Create Batch all read from here; do not add a second copy
 * (the item-type vocabulary drifted exactly that way once).
 *
 * "Ingredient" and "Material" are consumed in PRODUCTION and are drawn from
 * inventory before the batch can be released. "Packaging" and "Labeling" are
 * consumed at the PACKAGING stage, after testing — the compliance label carries
 * the test results, so it cannot be applied any earlier. That is the whole
 * reason the two groups are distinguished: see isPackagingStageKind() below,
 * which is what keeps the pre-release draw-down gate off them.
 * (2026-09-07, Jonathan: "let's add Packaging and Labeling as options to the
 * Recipes. Not just Ingredient and Material.")
 */
export const BOM_KINDS = ["Ingredient", "Material", "Packaging", "Labeling"] as const;
export type BomKind = (typeof BOM_KINDS)[number];

/** Display text for each BOM kind — the picker label, not the stored value. */
export const BOM_KIND_LABELS: Record<BomKind, string> = {
  Ingredient: "Ingredient (food)",
  Material: "Material",
  Packaging: "Packaging",
  Labeling: "Labeling",
};

/**
 * True for lines consumed at the packaging stage rather than in production:
 * tubes, cartons, boxes, compliance labels. These are NOT required to be drawn
 * from inventory before release — they have not been used yet at that point.
 */
export function isPackagingStageKind(kind: string | null | undefined): boolean {
  const k = (kind ?? "").trim();
  return k === "Packaging" || k === "Labeling";
}

/** True when an item/material type label denotes cannabis material. */
export function isCannabisItemType(type: string | null | undefined): boolean {
  return (type ?? "").trim().toLowerCase().startsWith("cannabis");
}

/**
 * True for clone types. Clones are COUNTED, not weighed, so they need a
 * carve-out from the cannabis→grams rule below and drive the unit warning
 * shown on both the catalog and receiving forms.
 */
export function isCloneItemType(type: string | null | undefined): boolean {
  return (type ?? "").trim().toLowerCase().includes("clone");
}

/**
 * The unit a newly created item/lot of this type should default to, or null
 * when there's no sensible default (non-cannabis types vary too much — a label
 * is counted, a solvent is volume, an ingredient is mass).
 */
export function defaultUnitForItemType(type: string | null | undefined): string | null {
  // Checked BEFORE the cannabis rule — "Cannabis – Clones" matches both tests,
  // and counted beats weighed.
  if (isCloneItemType(type)) return "each";
  return isCannabisItemType(type) ? "g" : null;
}

/**
 * The single source of truth for the unit dropdowns.
 *
 * The inventory catalog dialog and the receiving screen BOTH render this list.
 * They used to keep separate hardcoded copies kept in step by hand — receiving
 * even carried a comment saying it "mirrors the inventory dialog's unit set",
 * which is precisely how ITEM_TYPES drifted before it was unified.
 */
export const UNIT_OPTIONS = ["g", "kg", "mg", "mL", "L", "units", "each", "oz"] as const;

/**
 * A stored unit resolved to one the DROPDOWNS can actually display, or null.
 *
 * NOT to be confused with normalizeUnit() above, which lowercases a label for
 * the conversion table and answers for units like "pounds" that no dropdown
 * offers. This one answers a narrower question: is this exactly one of the
 * options a Select is allowed to hold?
 *
 * Returning null matters for the same reason normalizeItemType does it: a
 * Select handed a value outside its option list renders BLANK. Catalog rows
 * really do hold "Pounds", "Kilograms", "Grams" and friends — imported from
 * METRC, which spells units its own way — and filling one of those would wipe
 * the field instead of helping.
 *
 * Matching is exact (case-insensitive) ON PURPOSE. No "Grams" → "g" style map:
 * that is a guess about what someone meant, and the whole point of filling from
 * the catalog is that the value is one the facility actually recorded.
 */
export function toUnitOption(unit: string | null | undefined): (typeof UNIT_OPTIONS)[number] | null {
  const raw = (unit ?? "").trim();
  if (!raw) return null;
  return UNIT_OPTIONS.find((u) => u.toLowerCase() === raw.toLowerCase()) ?? null;
}

/**
 * Older vocabularies, mapped onto the current ITEM_TYPES.
 *
 * Existing catalog and receiving rows still hold these strings — nothing was
 * migrated. This map exists ONLY so a stored value can be offered back as a
 * suggestion in a dropdown that no longer lists it. It never rewrites stored
 * data; the old row keeps its old string until someone edits and saves it.
 *
 * DELIBERATELY ABSENT: "Received Material". That string is not a type anyone
 * chose — the receiving route writes it as a fallback when a line was saved
 * with no material type at all (`materialType || "Received Material"`), so it
 * means "nobody recorded one". Mapping it would be a guess, which is exactly
 * what this feature is built to avoid; those rows want a real type set on the
 * item instead.
 */
const LEGACY_ITEM_TYPES: Record<string, (typeof ITEM_TYPES)[number]> = {
  "cannabis flower": "Cannabis – Flower",
  "cannabis extract": "Cannabis – Extract",
  "cannabis concentrate": "Cannabis – Extract",
  "cannabis – concentrate/distillate": "Cannabis – Extract",
  "packaging material": "Packaging",
  excipient: "Ingredient",
  "food ingredient": "Ingredient",
  "ingredient / other": "Ingredient",
  "hardware/component": "Component",
  "material / component": "Component",
  "pre-roll cone": "Component",
  "cultivation input": "Nutrient",
};

/**
 * A stored item type resolved to a value the current dropdowns can actually
 * display, or null when it can't be resolved.
 *
 * Returning null matters: a Select handed a value outside its option list
 * renders BLANK, so an unrecognized legacy string must not be auto-filled —
 * better to leave the field untouched and let the operator choose.
 */
export function normalizeItemType(type: string | null | undefined): (typeof ITEM_TYPES)[number] | null {
  const raw = (type ?? "").trim();
  if (!raw) return null;
  const exact = ITEM_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  return LEGACY_ITEM_TYPES[raw.toLowerCase()] ?? null;
}

/**
 * Parse GET /incoming-inspections/item-name-options into the name list the
 * autocomplete needs, plus name→type and name→unit lookups for the auto-fill.
 *
 * Accepts BOTH shapes — the current [{itemName, itemType}] and the older bare
 * string[] — because the API and the web app deploy as separate services, so
 * for a few seconds during a rollout one can be ahead of the other. On the old
 * shape the names still work and the type map is simply empty, which degrades
 * to exactly the behavior that existed before the auto-fill.
 */
export function parseItemNameOptions(payload: unknown): {
  names: string[];
  typeByName: Map<string, (typeof ITEM_TYPES)[number]>;
  uomByName: Map<string, (typeof UNIT_OPTIONS)[number]>;
} {
  const names: string[] = [];
  const typeByName = new Map<string, (typeof ITEM_TYPES)[number]>();
  const uomByName = new Map<string, (typeof UNIT_OPTIONS)[number]>();
  if (!Array.isArray(payload)) return { names, typeByName, uomByName };
  for (const entry of payload) {
    if (typeof entry === "string") {
      const n = entry.trim();
      if (n) names.push(n);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { itemName?: unknown; itemType?: unknown; unitOfMeasure?: unknown };
    const n = typeof row.itemName === "string" ? row.itemName.trim() : "";
    if (!n) continue;
    names.push(n);
    const t = normalizeItemType(typeof row.itemType === "string" ? row.itemType : null);
    if (t) typeByName.set(n.toLowerCase(), t);
    const u = toUnitOption(typeof row.unitOfMeasure === "string" ? row.unitOfMeasure : null);
    if (u) uomByName.set(n.toLowerCase(), u);
  }
  return { names, typeByName, uomByName };
}
