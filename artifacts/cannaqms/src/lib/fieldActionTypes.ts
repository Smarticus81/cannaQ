/**
 * The field-action vocabulary — ONE list, used by the create dialog and by
 * anything that has to reason about the type of a field action.
 *
 * Do not add a second copy of these strings anywhere. Two independent copies of
 * a vocabulary is what broke label-template lookups (batches said "Vape
 * Cartridge", Label Studio said "Vape") and what stranded inventory items on a
 * type nobody could choose. When a new type is added it goes here and the
 * screens read from here.
 *
 * Order is deliberate: most severe first, so the dropdown reads as a scale.
 * "Notification Only" sits last because the product is still good — see below.
 */
export const FIELD_ACTION_TYPES = [
  "Voluntary Recall",
  "Regulatory Recall",
  "Stop Sale",
  "Market Withdrawal",
  "Safety Alert",
  // Added 2026-08-24. The product is SAFE and stays saleable — this covers the
  // case where a downstream licensee simply has to be told something (Jonathan's
  // example: a vape carton shipped without its USB-C charger). Recipients are
  // not always retailers; stock can sit with a distributor or in transport, so
  // the copy says "downstream licensee", never "retail".
  "Notification Only",
] as const;

export type FieldActionType = (typeof FIELD_ACTION_TYPES)[number];

/**
 * Types that do NOT restrict sale or consumption of the product. Kept next to
 * the list itself so a screen never has to re-derive it from a string test.
 */
export const NON_RESTRICTING_FIELD_ACTION_TYPES: readonly string[] = ["Notification Only"];
