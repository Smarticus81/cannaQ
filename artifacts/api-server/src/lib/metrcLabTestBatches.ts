// ---------------------------------------------------------------------------
// Metrc lab test batches ("testing panels") — which one a sample is submitted
// under, resolved from the CannaQMS product type.  · A7
// ---------------------------------------------------------------------------
//
// ⛔ WHERE THIS LIVES IN METRC — established 2026-09-11 from Metrc's own v2 API
// reference (sandbox-api-mi.metrc.com/Documentation), not from the PDF manuals.
// The field is `RequiredLabTestBatches`, an array of batch NAMES, and it sits on
// the PACKAGE:
//
//   POST /packages/v2/testing   → "RequiredLabTestBatches": ["Vape Concentrate"]
//   POST /packages/v2/          → "RequiredLabTestBatches": null
//   PUT  /packages/v2/labtests/required
//        → [{ "Label": "<tag>", "RequiredLabTestBatches": [...] }]   (repair path)
//
// Two earlier readings were WRONG and are recorded so nobody repeats them:
//   1. It is NOT a field on the ITEM. We sent `LabTestBatchNames` on item create;
//      Metrc answers 200 and silently discards it. The manual's Adding Items
//      screen (p.40-42) is Name / Category / Unit of Measure — nothing else.
//   2. It IS on the sample create. A truncated read of the documented body led
//      to the claim that it was absent there. It is not absent.
//
// The PDF manuals do not answer this at all: "Required Testing" on the Submit
// for Testing screen (p.125-126) is CBD / THC checkboxes, and the manual's whole
// Testing chapter (p.170) is one line pointing at the State Supplemental, which
// has no lab-test-batch content. Only the API reference answers it.
//
// ---------------------------------------------------------------------------
// ⛔ WHAT THE REGULATION ACTUALLY REQUIRES — R 420.305(3)
//
// The rule sets ONE list of required safety tests for every marihuana product
// that is part of a harvest or production batch — R 420.305(3)(a) to (i):
// potency, foreign matter, microbial screening, chemical residue, heavy metals,
// residual solvents, water activity, mycotoxins if requested, target analytes if
// requested. Residual solvents are required "for production batches of marihuana
// infused products and edible marihuana products" — R 420.305(3)(f).
//
// ⛔ The rule does NOT define per-product testing panels, and it does NOT split
// concentrate by extraction method. The only product-type variation it
// contemplates is delegated: "The agency may publish a guide indicating which of
// the following safety tests are required based on product type when the
// marihuana product has changed form." — R 420.305(3).
//
// So: the PANEL NAMES below are Metrc's, not the regulation's. They are the
// state's implementation of that one required test list, and the job here is
// only to name the panel matching the product's FORM. Nothing in this file may
// add, remove or condition a required safety test — R 420.305(3) does that, and
// a laboratory runs it.
//
// (CRA Best Practices is cited below only where it DEFINES a Metrc item category
// in the agency's own words. It is guidance, not the rule; where the two could
// ever disagree, the rule wins.)
// ---------------------------------------------------------------------------

/**
 * CannaQMS product type → the Metrc lab test batch the sample is submitted
 * under. Names must match `GET /labtests/v2/batches` EXACTLY (they are the
 * state's own strings, verified live against the MI sandbox on 2026-09-11).
 *
 * One panel per product type. Every product type maps — there is no product a
 * producer can make that has no panel, because R 420.303a(2) requires a product
 * in its final form to be tested, full stop.
 */
const PRODUCT_TYPE_TO_LAB_TEST_BATCH: Record<string, string> = {
  // Whole dried/cured flower — the CRA's "Buds" category (Best Practices p.51).
  "Flower": "Raw Plant Material",

  // A raw pre-roll is ground flower in a cone and nothing else — still plant
  // material. Jonathan, 2026-09-11, drawing the line explicitly: an infused
  // pre-roll "is not a raw pre-roll".
  "Pre-Roll": "Raw Plant Material",

  // ⛔ Best Practices p.52, the agency's own category definition: "Inhalable
  // Compound Concentrate – Pre-rolls with concentrate added, moon rocks, etc."
  // Jonathan's ruling, 2026-09-11: "an infused pre-roll is an inhalable compound
  // and must be tested as such. It is not a raw pre-roll."
  "Infused Pre-Roll": "Inhalable Compound Concentrate",

  // Best Practices p.52: "Vape Cart – Any vaping product". Metrc's matching
  // panel is "Vape Concentrate".
  "Vape Cartridge": "Vape Concentrate",
  // Two chambers, two production batches, one device — still a vaping product.
  // (Each chamber is sampled on its own; that per-chamber regime is enforced
  // upstream in routes/batches.ts, not here.)
  "Dual Chamber Vape Cartridge": "Vape Concentrate",

  // ⛔ ALL CONCENTRATE, ONE PANEL — Jonathan's ruling, 2026-09-11.
  // Metrc also publishes "Non-Solvent Concentrate", and an earlier version of
  // this file refused to resolve "Concentrate" until someone said which. That
  // was wrong on two counts. First, R 420.305(3) draws no solvent/solventless
  // distinction — it requires the same safety tests either way, and residual
  // solvents are required of production batches under (f) regardless of what
  // this site runs. Second, whether a facility extracts with solvent is a
  // property OF THE SITE, not a question to re-ask an operator at every sample:
  // his words, "all that 'is it solventless' will be answered by the site."
  // A solventless site overrides this per sample with labTestBatches until a
  // site-level default exists; it is not a reason to block the sample.
  "Concentrate": "Inhalable Concentrate",

  // Best Practices p.51: "Infused Edible – Gummies, chocolate bars, capsules,
  // infused pouches, etc."
  "Edible": "Infused Edible",
  // Capsules are named in that same definition — ingested, not inhaled or
  // applied, so the same panel as any other edible.
  "Capsule": "Infused Edible",

  // Best Practices p.51-52: "Infused Non-Edible Liquid – Topicals such as lotion
  // or balm" and "Infused Non-Edible Solid – Patches, tampons, suppositories".
  // Metrc carries a single "Infused Non-Edible" panel covering both.
  "Topical": "Infused Non-Edible",

  // Metrc carries a "Tinctures" panel by that exact name. (Best Practices files
  // tinctures under the Infused Liquids ITEM category, p.51 — item category and
  // testing panel are different lists and do not have to agree.)
  "Tincture": "Tinctures",
};

export type LabTestBatchResolution =
  | { ok: true; batches: string[]; source: "explicit" | "productType" }
  | { ok: false; error: string };

/**
 * Resolve the lab test batch(es) for a sample.
 *
 * `explicit` wins when supplied — a solventless site sending "Non-Solvent
 * Concentrate", a retest, or a laboratory that has told us which panel it is
 * running. Otherwise the product type decides, and every known product type
 * does decide.
 *
 * A refusal here means the product type is unknown to this map, which is a
 * configuration gap, not a judgement call. ⛔ Do not paper over it with a
 * default panel: Metrc will not let a panel be corrected after the fact — a
 * sample submitted under the wrong one has to be discontinued and remade.
 */
export function resolveLabTestBatches(
  productType: string | null | undefined,
  explicit?: readonly string[] | null,
): LabTestBatchResolution {
  const chosen = (explicit ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (chosen.length > 0) return { ok: true, batches: chosen, source: "explicit" };

  const key = (productType ?? "").trim();
  if (!key) {
    return {
      ok: false,
      error:
        "Cannot submit this sample — no product type is known, so the Metrc testing panel cannot be determined. Pass productType, or name the panel explicitly (labTestBatches).",
    };
  }

  const mapped = PRODUCT_TYPE_TO_LAB_TEST_BATCH[key];
  if (mapped) return { ok: true, batches: [mapped], source: "productType" };

  return {
    ok: false,
    error:
      `Cannot submit this sample — no Metrc testing panel is mapped for product type "${key}". ` +
      "Name the panel explicitly (labTestBatches), using a name from GET /metrc/labtest/batches, " +
      "and add the mapping in lib/metrcLabTestBatches.ts so the next sample resolves on its own.",
  };
}

/** The product type → panel map, for tests and for showing the operator. */
export function labTestBatchMap(): Record<string, string> {
  return { ...PRODUCT_TYPE_TO_LAB_TEST_BATCH };
}
