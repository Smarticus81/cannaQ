// ---------------------------------------------------------------------------
// Safety panels — WHICH contaminant tests a state requires
// ---------------------------------------------------------------------------
//
// Phase 5 Slice 3, step 1 (2026-08-30). The panel list and its rule citations
// used to be typed into BatchDetail.tsx, with "Michigan CRA R 420.305" as a
// literal heading. That made the SCREEN the source of truth for what a state
// requires, so a second state meant editing the screen. The list now comes from
// the state's own rule set (regulatory_config.additional_config.safetyPanels),
// resolved for the facility, and adding a state is a data change.
//
// ⛔ THE FALLBACK IS NOT OPTIONAL. If the rule set has no panels — an older
// database, a state nobody has configured, a failed load — this returns
// Michigan's original hardcoded list rather than an empty tab. An empty safety
// panel section would read as "no tests required", which is the most dangerous
// thing this screen could say.
// ---------------------------------------------------------------------------

/**
 * How a panel is gated by product form.
 *
 * Michigan needed only "all", "concentrate" and "vape". New York requires water
 * activity on flower AND solid edibles, and residual solvents on concentrates
 * AND edibles, so a panel may name SEVERAL forms — hence the array. A single
 * string still works and means the same thing.
 */
export type PanelForm = "all" | "concentrate" | "vape" | "edible" | "flower";
export type PanelAppliesTo = PanelForm | PanelForm[];

export type SafetyPanel = {
  /** Column on batch_testing (microbialsPass, ...). Also the form-state key. */
  key: string;
  /** Name in the results TABLE. */
  label: string;
  /** Name in the ENTRY dialog, when it differs (MCT Oil vs "MCT Oil (vape)"). */
  formLabel?: string;
  /** Per-panel rule citation shown beside the result. */
  citation?: string;
  appliesTo?: PanelAppliesTo;
};

export type SafetyPanelSet = {
  /** Heading citation above the entry dialog's panel grid. */
  heading?: string;
  panels: SafetyPanel[];
};

/**
 * Michigan, exactly as the screen hardcoded it before this change.
 * ⛔ Do NOT extend this for a new state — that is what the rule set is for.
 * It exists only so the tab can never render empty.
 */
export const MICHIGAN_FALLBACK_PANELS: SafetyPanelSet = {
  heading: "Michigan CRA R 420.305",
  panels: [
    { key: "microbialsPass", label: "Microbials", citation: "R 420.305(3)(c)", appliesTo: "all" },
    { key: "pesticidesPass", label: "Pesticides", citation: "R 420.305(3)(d)", appliesTo: "all" },
    { key: "heavyMetalsPass", label: "Heavy Metals", citation: "R 420.305(3)(e)", appliesTo: "all" },
    { key: "residualSolventsPass", label: "Residual Solvents", citation: "R 420.305(3)(f)", appliesTo: "concentrate" },
    { key: "mctOilPass", label: "MCT Oil", formLabel: "MCT Oil (vape)", citation: "CRA Best Practices — MCT (vape)", appliesTo: "vape" },
  ],
};

/** Shape of GET /api/regulatory-config/resolved, as far as this file cares. */
export type ResolvedRules = {
  configured?: boolean;
  additionalConfig?: { safetyPanels?: SafetyPanelSet } | null;
} | null | undefined;

/** The state's panel set, or Michigan's original list when none is configured. */
export function panelSetFor(resolved: ResolvedRules): SafetyPanelSet {
  const fromState = resolved?.additionalConfig?.safetyPanels;
  if (fromState && Array.isArray(fromState.panels) && fromState.panels.length > 0) return fromState;
  return MICHIGAN_FALLBACK_PANELS;
}

/**
 * The panels that apply to THIS product.
 *
 * Preserves the Session 82 gate exactly: microbials / pesticides / heavy metals
 * on every form; residual solvents only on solvent-processed forms; the MCT-oil
 * check only on vapes. Collecting a test the product form does not require was
 * both confusing and a compliance-accuracy problem, so a panel with no
 * appliesTo is treated as "all" rather than silently dropped.
 */
export function panelsForProduct(
  set: SafetyPanelSet,
  opts: { isConcentrate: boolean; isVape: boolean; isEdible?: boolean; isFlower?: boolean },
): SafetyPanel[] {
  const matches = (form: PanelForm): boolean => {
    switch (form) {
      case "concentrate": return opts.isConcentrate;
      case "vape":        return opts.isVape;
      case "edible":      return !!opts.isEdible;
      case "flower":      return !!opts.isFlower;
      default:            return true;   // "all", and anything unrecognised
    }
  };
  return set.panels.filter((p) => {
    const applies = p.appliesTo ?? "all";
    // A panel naming several forms applies if the product is ANY of them.
    return Array.isArray(applies) ? applies.some(matches) : matches(applies);
  });
}

/**
 * The key a panel's value is stored under inside result_values.
 *
 * The legacy columns are camelCase (microbialsPass) while result_values has
 * always been snake_case (microbials_pass) — see the Session 36 writes. Panels
 * with no legacy column live ONLY in result_values, so every caller has to
 * agree on the spelling; this is the one place that decides it.
 */
export function resultValueKey(panelKey: string): string {
  return panelKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Read a panel's pass/fail off a test row.
 *
 * ⛔ Checks the legacy COLUMN first, then result_values. Michigan's five have
 * had real columns since before Session 36 and rows exist with values in them;
 * a new panel (mycotoxins, water activity) has no column and can only ever be
 * in result_values. Reading one and not the other loses half the data.
 */
export function panelPass(
  test: unknown,
  panelKey: string,
): boolean | null | undefined {
  const row = test as Record<string, unknown> | null | undefined;
  if (!row) return undefined;
  const legacy = row[panelKey];
  if (legacy === true || legacy === false) return legacy;
  const rv = row["resultValues"] as Record<string, unknown> | null | undefined;
  const fromRv = rv?.[resultValueKey(panelKey)];
  if (fromRv === true || fromRv === false) return fromRv;
  return legacy === null ? null : undefined;
}
