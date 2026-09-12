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
