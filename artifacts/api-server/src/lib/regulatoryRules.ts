// ---------------------------------------------------------------------------
// Per-state regulatory rules — resolved BY THE FACILITY'S STATE
// ---------------------------------------------------------------------------
//
// `regulatory_config` has always been keyed by state, but every live reader
// fetched it with `.limit(1)` — whichever row came back first, regardless of
// which state the record belonged to. With one Michigan facility that is always
// right by accident. With a Michigan plant and an Illinois plant it silently
// applies one state's limits to the other state's batches, which is a
// compliance incident rather than a cosmetic bug. This module is the one place
// that resolves the right row, so no caller has to remember to.
//
// Held IN MEMORY and refreshed on save, exactly like the facility time zone
// (`facilityDate.ts`) and the METRC connection (`metrcClient.ts`): the callers
// are synchronous and there are dozens of them.
//
// ⚠️ STATE IS STORED IN TWO SHAPES. `facilities.state` carries a short code
// ("MI"), while `regulatory_config.state` carries the full name — the Session 36
// migration seeds analytes with `WHERE state = 'Michigan'`. Rather than pick a
// winner and migrate live data, every lookup here goes through `normalizeState`,
// so "MI", "mi" and "Michigan" all land on the same row. When one shape is
// eventually chosen, this stays correct.
// ---------------------------------------------------------------------------

import type { RegulatoryConfig, ChecklistTemplateItem } from "@workspace/db";

/** US state names by postal code. Used ONLY to make the two stored shapes agree. */
const STATE_NAME_BY_CODE: Record<string, string> = {
  AK: "ALASKA", AL: "ALABAMA", AR: "ARKANSAS", AZ: "ARIZONA", CA: "CALIFORNIA",
  CO: "COLORADO", CT: "CONNECTICUT", DC: "DISTRICT OF COLUMBIA", DE: "DELAWARE",
  FL: "FLORIDA", GA: "GEORGIA", HI: "HAWAII", IA: "IOWA", ID: "IDAHO",
  IL: "ILLINOIS", IN: "INDIANA", KS: "KANSAS", KY: "KENTUCKY", LA: "LOUISIANA",
  MA: "MASSACHUSETTS", MD: "MARYLAND", ME: "MAINE", MI: "MICHIGAN",
  MN: "MINNESOTA", MO: "MISSOURI", MS: "MISSISSIPPI", MT: "MONTANA",
  NC: "NORTH CAROLINA", ND: "NORTH DAKOTA", NE: "NEBRASKA", NH: "NEW HAMPSHIRE",
  NJ: "NEW JERSEY", NM: "NEW MEXICO", NV: "NEVADA", NY: "NEW YORK", OH: "OHIO",
  OK: "OKLAHOMA", OR: "OREGON", PA: "PENNSYLVANIA", RI: "RHODE ISLAND",
  SC: "SOUTH CAROLINA", SD: "SOUTH DAKOTA", TN: "TENNESSEE", TX: "TEXAS",
  UT: "UTAH", VA: "VIRGINIA", VT: "VERMONT", WA: "WASHINGTON", WI: "WISCONSIN",
  WV: "WEST VIRGINIA", WY: "WYOMING",
};

/**
 * Fold either stored shape onto ONE key: the upper-case full state name.
 * Anything unrecognised (the "TE" of a test profile, a free-typed value) is
 * upper-cased and returned as-is, so it can still match itself consistently.
 */
export function normalizeState(state: string | null | undefined): string | null {
  const raw = (state ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && STATE_NAME_BY_CODE[upper]) return STATE_NAME_BY_CODE[upper];
  return upper;
}

/**
 * The values used when no row exists for a facility's state. These are the SAME
 * numbers the old `.limit(1)` readers fell back to when the query returned
 * nothing, so a customer with no configured state behaves exactly as before.
 */
export const REGULATORY_DEFAULTS = {
  maxThcPerServing: 10,
  maxThcPerContainer: 200,
  potencyTolerancePct: 10,
  retentionYears: 4,
  tracingSystem: "METRC" as string,
} as const;

/** What a caller gets back: a real row's values, or the defaults above. */
export interface ResolvedRegulatoryRules {
  /** Normalized state this resolved for, or null when the facility has none. */
  state: string | null;
  /**
   * id of the regulatory_config ROW that matched, or null when none did.
   * ⛔ Compare against this, never against `state`: the row stores a short code
   * ("MI") while `state` here is the normalized full name ("MICHIGAN"), so a
   * string comparison between the two is always false.
   */
  configId: number | null;
  /** False when no row matched and the defaults are standing in. */
  configured: boolean;
  maxThcPerServing: number;
  maxThcPerContainer: number;
  potencyTolerancePct: number;
  retentionYears: number;
  tracingSystem: string;
  additionalConfig: unknown;
}

const configByState = new Map<string, RegulatoryConfig>();
const stateByFacilityId = new Map<number, string | null>();

/** Replace the cached rule sets. Called at boot and whenever a config is saved. */
export function setRegulatoryConfigs(rows: RegulatoryConfig[]): void {
  configByState.clear();
  for (const row of rows) {
    const key = normalizeState(row.state);
    if (key) configByState.set(key, row);
  }
}

/** Record which state a facility sits in. Called at boot and on facility save. */
export function setFacilityState(facilityId: number, state: string | null | undefined): void {
  stateByFacilityId.set(facilityId, normalizeState(state));
}

/** The state a facility sits in, normalized — null if unknown. */
export function getFacilityState(facilityId: number | null | undefined): string | null {
  if (facilityId == null) return null;
  return stateByFacilityId.get(facilityId) ?? null;
}

/** Resolve by an already-normalized-or-not state string. */
export function getRegulatoryRulesForState(state: string | null | undefined): ResolvedRegulatoryRules {
  const key = normalizeState(state);
  const row = key ? configByState.get(key) : undefined;
  if (!row) {
    return { state: key, configId: null, configured: false, additionalConfig: null, ...REGULATORY_DEFAULTS };
  }
  return {
    state: key,
    configId: row.id,
    configured: true,
    maxThcPerServing: row.maxThcPerServing ?? REGULATORY_DEFAULTS.maxThcPerServing,
    maxThcPerContainer: row.maxThcPerContainer ?? REGULATORY_DEFAULTS.maxThcPerContainer,
    potencyTolerancePct: row.potencyTolerancePct ?? REGULATORY_DEFAULTS.potencyTolerancePct,
    retentionYears: row.retentionYears ?? REGULATORY_DEFAULTS.retentionYears,
    tracingSystem: row.tracingSystem ?? REGULATORY_DEFAULTS.tracingSystem,
    additionalConfig: row.additionalConfig ?? null,
  };
}

/**
 * THE call site helper: the rules that apply to a facility's records.
 *
 * Pass the facility a record belongs to. Passing nothing resolves the facility
 * the request is acting for, which is what a single-site customer always wants.
 */
export function getRegulatoryRulesForFacility(facilityId: number | null | undefined): ResolvedRegulatoryRules {
  return getRegulatoryRulesForState(getFacilityState(facilityId));
}

/**
 * The LABEL CHECKLIST templates a facility's state requires, or null when that
 * state has none configured and the caller should fall back to the code.
 *
 * Phase 5 step 1 — the question set moved out of the constants in
 * batch_labeling.ts and onto the state, so a second state can be checked against
 * its own rules. Michigan's set is seeded from those same constants at boot, so
 * this returns byte-identical questions until somebody deliberately edits them.
 *
 * ⛔ Returns null, not an empty object, when the state has no set. An empty
 * object would resolve every product type to [] — and an empty checklist blocks
 * label approval, so a missing rule set would silently stop the line.
 */
export function getLabelChecklistsForFacility(
  facilityId: number | null | undefined,
): Record<string, ChecklistTemplateItem[]> | null {
  return getLabelChecklistsForState(getFacilityState(facilityId));
}

/**
 * The same sets, resolved by STATE rather than by facility.
 *
 * A packaging design is corporate — it is approved for a list of states and has
 * no facility of its own — so it needs the question set of each state it claims,
 * not the set of whichever site happens to be acting. Same null contract as
 * above: null means "this state has no rule set loaded", which a caller must
 * show plainly rather than treat as "no requirements".
 */
export function getLabelChecklistsForState(
  state: string | null | undefined,
): Record<string, ChecklistTemplateItem[]> | null {
  const key = normalizeState(state);
  const row = key ? configByState.get(key) : undefined;
  const cfg = row?.additionalConfig as { labelChecklists?: unknown } | null | undefined;
  const sets = cfg?.labelChecklists;
  if (!sets || typeof sets !== "object" || Array.isArray(sets)) return null;
  const out = sets as Record<string, ChecklistTemplateItem[]>;
  return Object.keys(out).length > 0 ? out : null;
}

/** Everything cached, for the Settings screen and for diagnostics. */
export function getCachedRegulatoryStates(): string[] {
  return [...configByState.keys()].sort();
}
