// Single source of truth for CannaQMS product types (frontend). The 10 canonical
// categories drive labeling, testing, process routing, and shelf-life. Keep this
// list in sync with the backend (routes/product_settings.ts + routes/batches.ts).
// "Other" is offered only as a catch-all on quality-event and product forms.
export const PRODUCT_TYPES = [
  "Flower",
  "Pre-Roll",
  "Infused Pre-Roll",
  "Vape Cartridge",
  // CRA new item category effective 2026-07-28: two concentrate chambers from
  // two different production batches, optionally with a combined draw. Kept as a
  // distinct type (not a Vape Cartridge subtype) because it carries its own
  // final-form testing regime (per-chamber + combined) and Metrc item category.
  "Dual Chamber Vape Cartridge",
  "Concentrate",
  "Edible",
  "Tincture",
  "Topical",
  "Capsule",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_TYPES_WITH_OTHER: readonly string[] = [...PRODUCT_TYPES, "Other"];
