// ---------------------------------------------------------------------------
// Metrc v2 — Lab test reads (READ ONLY)
// ---------------------------------------------------------------------------
//
// A licensed LABORATORY posts results into Metrc (POST /labtests/v2/record); a
// PROCESSOR only READS the results attached to its test-sample packages. Results
// are keyed by the test-sample package **Id** (resolve a tag → Id via
// getPackage(label) first), and each result row is ONE analyte / test type.
//
// Test-type NAMES are state-specific (MI differs from CA, etc.), so callers must
// match on them loosely (see labResultsProvider normalization) rather than hard-
// coding exact strings; discover the live list via getLabTestTypes when needed.
// ---------------------------------------------------------------------------

import { metrcGet, metrcPost, type MetrcResult } from "./metrcClient";
import { MetrcPaths } from "./metrcEndpoints";
import type { MetrcPaged } from "./metrcTransfers";

/** One analyte's result for a package, as returned by GET /labtests/v2/results. */
export type MetrcLabResult = {
  PackageId: number;
  /** File id of the CoA document, if attached. */
  LabTestResultDocumentFileId: number | null;
  /** Metrc releases results to the license; unreleased results should be ignored. */
  ResultReleased: boolean;
  ResultReleaseDateTime: string | null;
  TestComment: string | null;
  /** e.g. "Total THC (%)", "CBD (%)", "Pesticides", "Microbials", "THC per serving (mg)". */
  TestTypeName: string;
  /** Contaminant panels carry a real pass/fail here. Metrc does NOT fail on THC variance. */
  TestPassed: boolean;
  /** The measured value for this analyte (percentage, mg, cfu/g, etc. per TestTypeName). */
  TestResultLevel: number | null;
  TestPerformedDate: string | null;
  LabFacilityLicenseNumber: string | null;
  LabFacilityName: string | null;
  [k: string]: unknown;
};

export type MetrcLabTestType = {
  Id: number;
  Name: string;
  [k: string]: unknown;
};

/**
 * Lab results for a test-sample package, by its Metrc package **Id** (not the
 * tag/label — resolve that first via getPackage). Returns one row per analyte.
 */
export function getLabResults(
  packageId: number | string,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcPaged<MetrcLabResult>>> {
  return metrcGet(MetrcPaths.labTestResults, {
    query: { packageId: String(packageId), licenseNumber },
  });
}

/** The analyte / test-type catalog for the facility's state (names are state-specific). */
export function getLabTestTypes(licenseNumber?: string): Promise<MetrcResult<MetrcPaged<MetrcLabTestType>>> {
  return metrcGet(MetrcPaths.labTestTypes, { query: { licenseNumber } });
}

// ---------------------------------------------------------------------------
// SANDBOX ONLY — filing results AS THE LAB (2026-09-08)
// ---------------------------------------------------------------------------
//
// In production this is not ours to call: a licensed laboratory files results
// against the test-sample package it holds, and a processor only reads them.
// The sandbox is different — every facility on the demo licence set shares one
// key pair, so we can act as the lab facility by passing its licenceNumber.
//
// Why we need it: Metrc will not let a retailer RECEIVE a package whose lab
// state is NotSubmitted ("The destination Facility cannot receive Packages with
// the NotSubmitted Lab Testing State"). Nothing in the sandbox ever files
// results, so every package we build is permanently unshippable until we file
// them ourselves. This is demo plumbing, not a product feature.
export type LabResultLine = {
  labTestTypeName: string;
  quantity: number;
  passed: boolean;
  notes?: string;
};

export type RecordLabTestInput = {
  /** The package TAG (not the Id) the results belong to. */
  label: string;
  /** yyyy-mm-dd in the facility's zone — never build this from toISOString(). */
  resultDate: string;
  results: LabResultLine[];
  documentFileName?: string | null;
  documentFileBase64?: string | null;
};

export function buildLabTestRecordPayload(inputs: RecordLabTestInput[]): Record<string, unknown>[] {
  return inputs.map((i) => {
    const row: Record<string, unknown> = {
      Label: i.label,
      ResultDate: i.resultDate,
      Results: i.results.map((r) => ({
        LabTestTypeName: r.labTestTypeName,
        Quantity: r.quantity,
        Passed: r.passed,
        Notes: r.notes ?? "",
      })),
    };
    if (i.documentFileName) {
      row["DocumentFileName"] = i.documentFileName;
      row["DocumentFileBase64"] = i.documentFileBase64 ?? "";
    }
    return row;
  });
}

/** SANDBOX ONLY. Files lab results as `licenseNumber` (must be the LAB facility). */
export function recordLabTests(
  inputs: RecordLabTestInput[],
  licenseNumber?: string,
): Promise<MetrcResult<unknown>> {
  return metrcPost(MetrcPaths.labTestRecord, {
    query: { licenseNumber },
    body: buildLabTestRecordPayload(inputs),
  });
}
