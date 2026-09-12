// ---------------------------------------------------------------------------
// Lab-results provider abstraction (Metrc now, BioTrack later)
// ---------------------------------------------------------------------------
//
// The Testing tab pulls a batch's lab results through THIS interface, never a
// state-tracking API directly — so adding BioTrack (or another state system) is
// a new adapter, not a rewrite. The provider is chosen per facility by
// `regulatory_config.tracing_system` ("METRC" | "BIOTRACK").
//
// Division of responsibility:
//   - The provider NORMALIZES what the lab reported (analyte values + the lab's
//     own contaminant pass/fail).
//   - Potency ACCEPTANCE (measured THC vs label claim, within a configurable
//     tolerance) is decided IN THE APP, not here — Metrc does not fail a product
//     on THC variance, and the allowed variance differs by company/state.
// ---------------------------------------------------------------------------

import { getPackage } from "./metrcCatalog";
import { getLabResults, type MetrcLabResult } from "./metrcLabTests";

/** Provider-agnostic lab result for one test sample. Potency acceptance is NOT decided here. */
export type NormalizedLabResult = {
  provider: "metrc" | "biotrack";
  sampleTag: string;
  labFacilityName: string | null;
  resultDate: string | null;
  released: boolean;
  /** State system's lifecycle state, if known (e.g. Metrc "TestPassed"/"TestFailed"). Informational. */
  testingState: string | null;
  // Potency (percentages)
  thcPct: number | null;
  cbdPct: number | null;
  totalCannabinoids: number | null;
  // Edibles — per serving / per package (mg). What the consumer label states.
  thcMgPerServing: number | null;
  cbdMgPerServing: number | null;
  thcMgPerPackage: number | null;
  cbdMgPerPackage: number | null;
  // Contaminant panels — the lab's pass/fail IS the source of truth here.
  microbialsPass: boolean | null;
  pesticidesPass: boolean | null;
  heavyMetalsPass: boolean | null;
  residualSolventsPass: boolean | null;
  /** CoA document reference from the state system, if attached. */
  coaDocumentFileId: number | null;
  /** Every analyte row, for audit + display of anything the derived fields missed. */
  analytes: Array<{ name: string; level: number | null; passed: boolean }>;
  /** Raw provider payload, retained for traceability. */
  raw: unknown;
};

export interface LabResultsProvider {
  readonly name: "metrc" | "biotrack";
  /**
   * Fetch + normalize the lab results for a test-sample tag. Returns null when
   * no released results exist yet (sample still out for testing) or the sample
   * can't be resolved. Throws only on a hard provider/config error.
   */
  getResultsBySampleTag(sampleTag: string, licenseNumber?: string): Promise<NormalizedLabResult | null>;
}

// ── analyte name matching (state-specific names → normalized fields) ─────────
const norm = (s: string) => s.toLowerCase();
const isServing = (n: string) => n.includes("serving");
const isPerPackage = (n: string) => n.includes("package") || n.includes("container") || n.includes("unit");

/** Aggregate a contaminant panel: passes only if EVERY matching analyte passed; null if none present. */
function panelPass(rows: MetrcLabResult[], match: (n: string) => boolean): boolean | null {
  const hits = rows.filter((r) => match(norm(r.TestTypeName)));
  if (hits.length === 0) return null;
  return hits.every((r) => r.TestPassed === true);
}

/** First matching analyte's measured level, or null. */
function levelOf(rows: MetrcLabResult[], match: (n: string) => boolean): number | null {
  const hit = rows.find((r) => match(norm(r.TestTypeName)));
  return hit ? hit.TestResultLevel ?? null : null;
}

export function normalizeMetrcResults(sampleTag: string, rows: MetrcLabResult[], testingState: string | null): NormalizedLabResult {
  // Only released analyte rows are trustworthy for labeling.
  const released = rows.filter((r) => r.ResultReleased === true);
  const use = released.length > 0 ? released : rows;

  const thcPct = levelOf(use, (n) => n.includes("thc") && !n.includes("cbd") && !n.includes("mg") && !isServing(n) && !isPerPackage(n));
  const cbdPct = levelOf(use, (n) => n.includes("cbd") && !n.includes("thc") && !n.includes("mg") && !isServing(n) && !isPerPackage(n));
  const totalCannabinoids = levelOf(use, (n) => n.includes("total cannabinoid"));

  const thcMgPerServing = levelOf(use, (n) => n.includes("thc") && isServing(n));
  const cbdMgPerServing = levelOf(use, (n) => n.includes("cbd") && isServing(n));
  const thcMgPerPackage = levelOf(use, (n) => n.includes("thc") && isPerPackage(n));
  const cbdMgPerPackage = levelOf(use, (n) => n.includes("cbd") && isPerPackage(n));

  const coa = use.find((r) => r.LabTestResultDocumentFileId != null)?.LabTestResultDocumentFileId ?? null;
  const labName = use.find((r) => r.LabFacilityName)?.LabFacilityName ?? null;
  const resultDate = use.map((r) => r.TestPerformedDate).filter(Boolean).sort().pop() ?? null;

  return {
    provider: "metrc",
    sampleTag,
    labFacilityName: labName,
    resultDate,
    released: released.length > 0,
    testingState,
    thcPct, cbdPct, totalCannabinoids,
    thcMgPerServing, cbdMgPerServing, thcMgPerPackage, cbdMgPerPackage,
    microbialsPass: panelPass(use, (n) => n.includes("microbial") || n.includes("micro")),
    pesticidesPass: panelPass(use, (n) => n.includes("pesticide")),
    heavyMetalsPass: panelPass(use, (n) => n.includes("heavy metal") || n.includes("metal")),
    residualSolventsPass: panelPass(use, (n) => n.includes("residual solvent") || n.includes("solvent")),
    coaDocumentFileId: coa,
    analytes: use.map((r) => ({ name: r.TestTypeName, level: r.TestResultLevel ?? null, passed: r.TestPassed === true })),
    raw: rows,
  };
}

export class MetrcLabResultsProvider implements LabResultsProvider {
  readonly name = "metrc" as const;

  async getResultsBySampleTag(sampleTag: string, licenseNumber?: string): Promise<NormalizedLabResult | null> {
    const tag = sampleTag.trim();
    if (!tag) return null;
    // 1) Resolve tag → package (gives Id + LabTestingState).
    const pkg = await getPackage(tag, licenseNumber);
    if (!pkg.ok) {
      if (pkg.status === 404) return null; // unknown tag → treat as "no results yet"
      throw new Error(`Metrc package lookup failed (${pkg.status}): ${pkg.error}`);
    }
    const packageId = pkg.data.Id;
    const testingState = (pkg.data as { LabTestingState?: string | null }).LabTestingState ?? null;

    // 2) Pull the results for that package.
    const res = await getLabResults(packageId, licenseNumber);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Metrc lab results fetch failed (${res.status}): ${res.error}`);
    }
    const rows = res.data.Data ?? [];
    if (rows.length === 0) return null; // sample still out for testing

    return normalizeMetrcResults(tag, rows, testingState);
  }
}

export class BioTrackLabResultsProvider implements LabResultsProvider {
  readonly name = "biotrack" as const;
  async getResultsBySampleTag(): Promise<NormalizedLabResult | null> {
    throw new Error("BioTrack lab-results provider is not configured yet. Set tracing_system to METRC, or implement the BioTrack adapter.");
  }
}

/** Choose the provider by facility tracing system (`regulatory_config.tracing_system`). */
export function getLabResultsProvider(tracingSystem?: string | null): LabResultsProvider {
  const sys = (tracingSystem ?? "METRC").trim().toUpperCase();
  if (sys === "BIOTRACK") return new BioTrackLabResultsProvider();
  return new MetrcLabResultsProvider();
}
