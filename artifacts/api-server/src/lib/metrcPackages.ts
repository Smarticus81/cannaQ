// ---------------------------------------------------------------------------
// Metrc v2 — Packages (finished-goods create + available tags)  · FG-3
// ---------------------------------------------------------------------------
//
// Typed helpers over the core client for creating finished-goods packages from
// a batch's source package, plus reading the facility's available package tags
// to validate scans. Mirrors the metrcTransfers.ts pattern.
//
// SANDBOX-VERIFY (proven live 2026-07-18): the create payload reaches Metrc's own
// validation. Two field requirements Metrc enforced and are now baked in below:
//   - Unit of Measure must be the SPELLED-OUT Metrc name ("Grams"/"Ounces"/...),
//     NOT an abbreviation ("g"/"oz") — see normalizeMetrcUom().
//   - Every new package needs a Location (a room/area defined in the facility).
// If a create 400s with "<Field> was not specified", fix the key HERE — callers
// never re-guess.
// ---------------------------------------------------------------------------

import { getMetrcConfig, metrcGet, metrcGetAllPages, metrcPost, metrcPut, type MetrcResult } from "./metrcClient";
import { MetrcPaths } from "./metrcEndpoints";

function license(explicit?: string): string | undefined {
  return explicit ?? getMetrcConfig()?.licenseNumber ?? undefined;
}

/**
 * Metrc accepts only the spelled-out weight/count unit NAMES (Grams, Kilograms,
 * Milligrams, Ounces, Pounds, Each). A cannabis package quantity sent as "g" or
 * "oz" is rejected: `The Unit of Measure "g" is invalid.` This maps the common
 * abbreviations (and already-correct names) to Metrc's vocabulary; anything it
 * doesn't recognize passes through unchanged so Metrc still names the problem.
 *
 * NOTE: this is for CANNABIS/Metrc-bound quantities only. Non-cannabis food
 * ingredients (the CannaQMS batch BOM — e.g. distillate in mL) keep their own
 * units and never pass through here.
 */
export function normalizeMetrcUom(uom: string | null | undefined): string {
  const raw = (uom ?? "").trim();
  if (!raw) return raw;
  const key = raw.toLowerCase().replace(/\.$/, "");
  const map: Record<string, string> = {
    g: "Grams", gram: "Grams", grams: "Grams",
    mg: "Milligrams", milligram: "Milligrams", milligrams: "Milligrams",
    kg: "Kilograms", kilogram: "Kilograms", kilograms: "Kilograms",
    oz: "Ounces", ounce: "Ounces", ounces: "Ounces",
    lb: "Pounds", lbs: "Pounds", pound: "Pounds", pounds: "Pounds",
    ea: "Each", each: "Each", unit: "Each", units: "Each", count: "Each",
  };
  return map[key] ?? raw;
}

/** One new sellable unit: its own scanned tag + the quantity it holds. */
export interface NewPackageLine {
  /** The new (unused) Metrc package tag scanned for this unit. */
  tag: string;
  /** Quantity this package holds (defaults applied by the caller). */
  quantity: number;
  /**
   * Quantity pulled from the SOURCE package for this unit — SINGLE-SOURCE only.
   * When `CreateFinishedGoodsInput.ingredients` is supplied this field is ignored;
   * each ingredient carries its own quantity.
   */
  sourceQuantity?: number;
}

/**
 * One source (cannabis) package drawn from when creating finished goods.
 * Corresponds to one entry in METRC's `Ingredients` array on the package create body.
 */
export interface PackageIngredient {
  /** Metrc tag of the source package. */
  packageLabel: string;
  /** Amount drawn from this source (must be > 0). */
  quantity: number;
  /** Unit of measure for this draw — normalized to Metrc's spelled-out names. */
  unitOfMeasure: string;
}

/** Create N finished-goods packages from one or more source packages (the batch's cannabis sources). */
export interface CreateFinishedGoodsInput {
  /**
   * Single-source package label (Metrc tag). Used when the batch draws from exactly
   * one METRC-tracked cannabis lot. Ignored when `ingredients` is supplied.
   */
  sourcePackageLabel?: string;
  /**
   * Multi-source ingredients — supply this instead of (or in addition to)
   * `sourcePackageLabel` when the batch draws from more than one METRC-tracked lot.
   * When present, takes precedence over `sourcePackageLabel` + `sourceUnitOfMeasure`.
   * One entry per source package; METRC's `Ingredients` array is shaped from these.
   *
   * ⛔ Every entry MUST have quantity > 0 — METRC rejects a 0-quantity ingredient.
   */
  ingredients?: PackageIngredient[];
  /** Metrc Item name (from the facility item catalog — NOT free text). */
  item: string;
  /** Unit of measure for the new packages (typically the Item's own UoM). */
  unitOfMeasure: string;
  /** Package/production date (ISO yyyy-mm-dd). */
  packagedDate: string;
  /**
   * Metrc storage location (a room/area name defined in the facility) the new
   * package is placed in. REQUIRED by Metrc on package create — a missing/blank
   * value comes back as "Location was not specified." Pick from the facility's
   * locations (GET /metrc/packages/locations).
   */
  location?: string | null;
  /** Mark each new package as a production batch (finished goods from a process run). */
  isProductionBatch?: boolean;
  /** Production batch number to stamp when isProductionBatch (usually the CannaQMS batchNumber). */
  productionBatchNumber?: string | null;
  /** UoM used when drawing from the source package — SINGLE-SOURCE only; ignored when `ingredients` is supplied. */
  sourceUnitOfMeasure?: string;
  note?: string | null;
  /** The scanned sellable units. */
  packages: NewPackageLine[];
}

/**
 * Build the Metrc "create packages" body — an array, one object per new package.
 * Key spellings are v2-convention (see SANDBOX-VERIFY note at top). Units are
 * normalized to Metrc's spelled-out names; Location is passed through (Metrc
 * requires it) — an empty/null Location is sent as-is so Metrc's own
 * "Location was not specified" surfaces rather than us silently dropping it.
 *
 * Multi-source: when `input.ingredients` is provided, the `Ingredients` array on
 * each package body contains ONE entry per source package. This is the path for
 * batches that draw from more than one METRC-tracked cannabis lot (e.g. an infused
 * pre-roll that uses both flower and concentrate). Single-source is a special case
 * of this (one ingredient entry), kept as `sourcePackageLabel` for backward compat.
 */
export function buildCreatePackagesPayload(input: CreateFinishedGoodsInput): Record<string, unknown>[] {
  const uom = normalizeMetrcUom(input.unitOfMeasure);
  const location = input.location?.trim() || null;
  const hasMultiSource = (input.ingredients ?? []).length > 0;

  return input.packages.map((p) => {
    // Resolve the METRC Ingredients array — one entry per cannabis source package.
    // Multi-source wins; single-source is a fallback for backward compat.
    let ingredientLines: Record<string, unknown>[];
    if (hasMultiSource) {
      ingredientLines = (input.ingredients!).map((ing) => ({
        Package: ing.packageLabel,
        Quantity: ing.quantity,
        UnitOfMeasure: normalizeMetrcUom(ing.unitOfMeasure),
      }));
    } else {
      // Single-source legacy path — one ingredient entry from sourcePackageLabel.
      const srcUom = normalizeMetrcUom(input.sourceUnitOfMeasure ?? input.unitOfMeasure);
      ingredientLines = [
        {
          Package: input.sourcePackageLabel,
          Quantity: p.sourceQuantity ?? p.quantity,
          UnitOfMeasure: srcUom,
        },
      ];
    }

    return {
      Tag: p.tag,
      Item: input.item,
      Quantity: p.quantity,
      UnitOfMeasure: uom,
      // Metrc requires a package Location (room/area) on create.
      Location: location,
      Note: input.note ?? null,
      // v2 package create uses ActualDate for the packaged date.
      ActualDate: input.packagedDate,
      IsProductionBatch: input.isProductionBatch ?? false,
      ProductionBatchNumber: input.isProductionBatch ? (input.productionBatchNumber ?? null) : null,
      IsDonation: false,
      IsTradeSample: false,
      // Chain of custody: the source package(s) + amounts pulled. The MI manual
      // stresses these pulls are NOT auto-deducted — we send them explicitly.
      Ingredients: ingredientLines,
    };
  });
}

// ---------------------------------------------------------------------------
// Lab TEST SAMPLE package (2026-09-08) — R 420.304(2)(j)
// ---------------------------------------------------------------------------
//
// The laboratory physically takes the sample, but Michigan puts the METRC entry
// on US: "A marihuana business shall enter in the statewide monitoring system
// the marihuana product test sample that is collected by a licensed laboratory,
// including the date and time the marihuana product is collected and
// transferred." This creates that child package off the source package, which
// is also what draws the sampled amount out of our bulk in METRC.
//
// — It does NOT get results back. Results are filed by the lab that HOLDS the
//   sample, so the sample still has to reach them; the tag is the key both
//   sides use afterwards.
export interface CreateTestingSampleInput {
  /** The package the lab sampled FROM — our bulk. */
  sourcePackageLabel: string;
  /** The tag going on the sample itself. Must be an unused package tag. */
  tag: string;
  /** METRC item name — resolved from the source package when not supplied. */
  item: string;
  quantity: number;
  unitOfMeasure: string;
  /** Room the sample sits in until the lab takes it. */
  location?: string | null;
  /** yyyy-mm-dd, facility zone. Never build this from toISOString(). */
  actualDate: string;
  note?: string | null;
  /**
   * A7 (2026-09-11) — the Metrc testing PANEL(s) this sample is submitted under.
   * Names must match `GET /labtests/v2/batches` exactly.
   *
   * ⛔ Metrc refuses the create without one ("At least one Lab Test Batch is
   * required for Item X"), and a WRONG one cannot be corrected afterwards — the
   * sample must be discontinued and remade (CRA Best Practices, "Incorrect Test
   * Panels Selected at Sampling", p.49). So this is resolved by
   * lib/metrcLabTestBatches.ts from the product type, or refused there. It is
   * never guessed, and there is no default.
   */
  requiredLabTestBatches?: readonly string[] | null;
}

export function buildCreateTestingPayload(input: CreateTestingSampleInput): Record<string, unknown>[] {
  const uom = normalizeMetrcUom(input.unitOfMeasure);
  const panels = (input.requiredLabTestBatches ?? []).map((s) => String(s).trim()).filter(Boolean);
  return [
    {
      Tag: input.tag,
      Item: input.item,
      Quantity: input.quantity,
      UnitOfMeasure: uom,
      Location: input.location?.trim() || null,
      Note: input.note ?? null,
      ActualDate: input.actualDate,
      IsDonation: false,
      IsTradeSample: false,
      ProductRequiresRemediation: false,
      // The pull from our bulk. Same chain-of-custody shape as a normal create;
      // METRC deducts this amount from the source package.
      Ingredients: [
        {
          Package: input.sourcePackageLabel,
          Quantity: input.quantity,
          UnitOfMeasure: uom,
        },
      ],
      // A7 — documented on this endpoint in Metrc's v2 API reference, sitting
      // immediately after Ingredients. Sent as null (not []) when absent so the
      // shape matches Metrc's own example for a package with no panel.
      RequiredLabTestBatches: panels.length > 0 ? panels : null,
    },
  ];
}

/** Create the lab test-sample package. Guarded upstream (write gates + confirm). */
export function createTestingPackage(
  input: CreateTestingSampleInput,
  licenseNumber?: string,
): Promise<MetrcResult<unknown>> {
  return metrcPost(MetrcPaths.packagesTesting, {
    query: { licenseNumber: license(licenseNumber) },
    body: buildCreateTestingPayload(input),
  });
}

export type MetrcCreateResult = { Ids: number[]; Warnings: unknown };

/** POST the finished-goods packages to Metrc. Guarded upstream (approverWriteRoute). */
export function createPackages(
  input: CreateFinishedGoodsInput,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcCreateResult>> {
  return metrcPost(MetrcPaths.packagesCreate, {
    query: { licenseNumber: license(licenseNumber) },
    body: buildCreatePackagesPayload(input),
  });
}

/** Available (unused) package tags for the facility — used to validate scans. */
export function getAvailablePackageTags(licenseNumber?: string): Promise<MetrcResult<unknown>> {
  // Paged at 20 like every Metrc list — walk all pages so a facility with a full
  // roll of tags validates a scan against the WHOLE available set, not just page 1.
  return metrcGetAllPages(MetrcPaths.packageTagsAvailable, {
    query: { licenseNumber: license(licenseNumber) },
  });
}

/**
 * Active storage locations for the facility — backs the Location picker on the
 * create-package dialog so a supervisor CHOOSES a real facility room instead of
 * typing one Metrc might reject (API-first: a text-box fallback is a bug).
 *
 * Two things learned in the MI sandbox are handled here:
 *  - The list is PAGED at 20 → walk all pages (metrcGetAllPages).
 *  - `/locations/v2/active` returns 404 in the MI sandbox → fall back to the v1
 *    path. We try v2 first (correct where it exists) and only drop to v1 on a
 *    404, preferring a working v1 result but surfacing the original v2 error if
 *    v1 also fails, so the message stays truthful.
 */
/**
 * The location TYPES this facility supports (e.g. "Default Location"). Needed
 * before a location can be created, because Metrc validates LocationTypeName
 * against the facility's own list rather than a global vocabulary.
 */
export function getLocationTypes(licenseNumber?: string): Promise<MetrcResult<unknown>> {
  return metrcGet("/locations/v2/types", { query: { licenseNumber: license(licenseNumber) } });
}

/**
 * Create facility locations (rooms/areas). Every package create needs one, so a
 * facility with zero locations cannot package anything at all — which is exactly
 * the state the MI sandbox starts in.
 */
export function createLocations(
  names: string[],
  locationTypeName: string,
  licenseNumber?: string,
): Promise<MetrcResult<unknown>> {
  return metrcPost("/locations/v2", {
    query: { licenseNumber: license(licenseNumber) },
    body: names.map((Name) => ({ Name, LocationTypeName: locationTypeName })),
  });
}

export async function getActiveLocations(licenseNumber?: string): Promise<MetrcResult<unknown>> {
  const ln = license(licenseNumber);
  const v2 = await metrcGetAllPages("/locations/v2/active", { query: { licenseNumber: ln } });
  if (v2.ok) return v2;
  if (v2.status === 404) {
    const v1 = await metrcGetAllPages("/locations/v1/active", { query: { licenseNumber: ln } });
    return v1.ok ? v1 : v2;
  }
  return v2;
}

// ---------------------------------------------------------------------------
// Destruction write-back (Session 52 / Phase 2) — adjust-to-0 + finish
// ---------------------------------------------------------------------------
// Michigan destroys a PACKAGE by adjusting its quantity down (reason "Waste" or
// "Spoilage") and then finishing the tag once it hits 0. We read the package
// first so we adjust by the REAL on-hand quantity and send the package's OWN
// unit (a unit mismatch is exactly what Metrc rejects). See metrcEndpoints
// packagesAdjust / packagesFinish and the MI supplemental adjustment reasons.

export type MetrcPackageRead = {
  Label?: string;
  Quantity?: number | null;
  UnitOfMeasureName?: string | null;
  Item?: { Name?: string | null } | null;
  FinishedDate?: string | null;
  PackageState?: string | null;
};

/** Read ONE package by its Metrc tag — current on-hand quantity + unit. */
export function getPackageByLabel(label: string, licenseNumber?: string): Promise<MetrcResult<MetrcPackageRead>> {
  return metrcGet<MetrcPackageRead>(MetrcPaths.packageByLabel(label), {
    query: { licenseNumber: license(licenseNumber) },
  });
}

export interface AdjustPackageInput {
  /** Metrc package tag. */
  label: string;
  /** Signed quantity delta. NEGATIVE to reduce (destruction adjusts DOWN). */
  quantity: number;
  /** Unit of measure — normalized to Metrc's spelled-out name. */
  unitOfMeasure: string;
  /** Metrc AdjustmentReason (MI destruction: "Waste" or "Spoilage"). */
  reason: string;
  /** Adjustment date, ISO yyyy-mm-dd. */
  date: string;
  /** Optional note (Metrc caps at 250 chars); our granular reason goes here. */
  note?: string | null;
}

export function buildAdjustPayload(inputs: AdjustPackageInput[]): Record<string, unknown>[] {
  return inputs.map((a) => ({
    Label: a.label,
    Quantity: a.quantity,
    UnitOfMeasure: normalizeMetrcUom(a.unitOfMeasure),
    AdjustmentReason: a.reason,
    AdjustmentDate: a.date,
    ReasonNote: a.note ? a.note.slice(0, 250) : null,
  }));
}

/** PUT package adjustment(s) to Metrc. Write-back must be guarded by the caller. */
export function adjustPackages(inputs: AdjustPackageInput[], licenseNumber?: string): Promise<MetrcResult<unknown>> {
  return metrcPut(MetrcPaths.packagesAdjust, {
    query: { licenseNumber: license(licenseNumber) },
    body: buildAdjustPayload(inputs),
  });
}

/** PUT package finish(es) to Metrc — valid only once a package is at 0. */
export function finishPackages(items: { label: string; date: string }[], licenseNumber?: string): Promise<MetrcResult<unknown>> {
  return metrcPut(MetrcPaths.packagesFinish, {
    query: { licenseNumber: license(licenseNumber) },
    body: items.map((i) => ({ Label: i.label, ActualDate: i.date })),
  });
}
