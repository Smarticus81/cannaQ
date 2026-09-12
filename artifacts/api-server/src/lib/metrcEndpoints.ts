// redeploy: re-trigger Railway build (snapshot timeout 2026-08-07)
// ---------------------------------------------------------------------------
// Metrc v2 endpoint paths + vocabulary constants
// ---------------------------------------------------------------------------
//
// Every Metrc quirk we verified live in the Michigan sandbox (06-29 → 07-01) is
// encoded here ONCE, so no caller re-guesses a path or a magic string and no one
// rediscovers these the hard way. Notably:
//
//  - The transfer-template LIST endpoint is `/transfers/v2/templates/outgoing`.
//    The `/transfers/v2/templates` path that Metrc ships in their own Postman
//    collection (request "GetTemplates") returns 404. Use the `/outgoing` form.
//  - External-incoming transfers require the transfer type "External
//    Cannabinoids" at the TOP level of each payload object (see metrcTransfers).
//  - The PUT id field names differ by entity: `TransferId` for external
//    incoming, `TransferTemplateId` for templates. Wrong name → 400
//    "…Id was not specified" / "…Id not found".
//
// Paths are functions where an id is interpolated, plain strings otherwise.
// None of them include the query string; callers pass licenseNumber via `query`.
// ---------------------------------------------------------------------------

export const MetrcPaths = {
  facilities: "/facilities/v2",

  // Strains / Items / Packages (catalog)
  strainById: (id: number | string) => `/strains/v2/${id}`,
  itemById: (id: number | string) => `/items/v2/${id}`,
  itemsActive: "/items/v2/active",
  packageByLabel: (label: string) => `/packages/v2/${encodeURIComponent(label)}`,
  /** All ACTIVE packages for the license — the facility's on-hand inventory
   *  (finished goods + intermediates) per Metrc. Read-only; used to reconcile
   *  against physical counts. Paged: Metrc returns `Data` + paging metadata. */
  packagesActive: "/packages/v2/active",
  // FG-3 — finished-goods write-back.
  /** POST — create one or more packages (array body). Finished-goods create.
   *  VERIFIED 2026-07-06: a create succeeded against the MI sandbox, so this
   *  path AND the metrcPackages.ts payload keys are confirmed correct. */
  packagesCreate: "/packages/v2",
  /** PUT — adjust package quantities (array body). Destruction/waste path:
   *  send a NEGATIVE Quantity + an AdjustmentReason (MI: "Waste" | "Spoilage").
   *  Confirmed by the Metrc UI guide (Adjust/Discontinue) + MI supplemental. */
  /** Lab TEST SAMPLE packages — a child package flagged as a testing sample.
   *  Michigan R 420.304(2)(j) makes the licensee (us) enter it, not the lab. */
  packagesTesting: "/packages/v2/testing",
  packagesAdjust: "/packages/v2/adjust",
  /** PUT — finish packages (array body). Only valid once a package is at 0 and
   *  not on state hold. Used after an adjust-to-0 to close the tag out. */
  packagesFinish: "/packages/v2/finish",
  /** GET — the facility's available (unused) PACKAGE tags, to validate scans.
   *  NOT yet confirmed: the MI sandbox returned no tags (UI shows a soft
   *  "couldn't verify" note). Confirm this path when a tag-loaded facility is
   *  available; the create flow does not depend on it. */
  packageTagsAvailable: "/tags/v2/package/available",

  // Transfers — reads
  transfersIncoming: "/transfers/v2/incoming",
  transfersOutgoing: "/transfers/v2/outgoing",
  transfersRejected: "/transfers/v2/rejected",
  transferTypes: "/transfers/v2/types",
  /** OUTGOING-ONLY per Metrc — returns nothing for an incoming transfer id. */
  transferDeliveries: (transferId: number | string) => `/transfers/v2/${transferId}/deliveries`,
  manifestPdf: (manifestNumber: number | string) => `/transfers/v2/manifest/${manifestNumber}/pdf`,
  deliveryPackages: (deliveryId: number | string) => `/transfers/v2/deliveries/${deliveryId}/packages`,
  deliveryPackagesWholesale: (deliveryId: number | string) =>
    `/transfers/v2/deliveries/${deliveryId}/packages/wholesale`,

  // Transfers — external incoming (write)
  externalIncoming: "/transfers/v2/external/incoming",
  externalIncomingById: (transferId: number | string) => `/transfers/v2/external/incoming/${transferId}`,

  // Transfer templates (outgoing)
  /** The working LIST path. `/transfers/v2/templates` (no /outgoing) 404s. */
  templatesOutgoing: "/transfers/v2/templates/outgoing",
  templateDeliveries: (templateId: number | string) => `/transfers/v2/templates/${templateId}/deliveries`,

  // Lab tests — READ ONLY (a licensed LAB posts results; a processor only reads
  // the results attached to its test-sample packages). Results are keyed by the
  // test-sample package Id; resolve a tag→Id first via packageByLabel.
  /** Lab results for a package. Query: `packageId={id}&licenseNumber={x}`. Paged. */
  labTestResults: "/labtests/v2/results",
  /** The analyte / test-type catalog for the facility's state. Names are state-specific. */
  labTestTypes: "/labtests/v2/types",
  /** GET — the lab test BATCHES this state defines (the panel a sample is
   *  tested under, e.g. an inhalable-concentrate panel). 2026-09-11: METRC
   *  refuses to create a testing SAMPLE for an item that names none —
   *  "At least one Lab Test Batch is required for Item X" — so an item created
   *  without them cannot be sampled, and the operator only finds out at the
   *  lab. Verified present in Metrc's own v2 documentation index. */
  labTestBatches: "/labtests/v2/batches",
  /** Lab-testing lifecycle states (NotSubmitted / SubmittedForTesting / TestPassed / TestFailed). */
  labTestStates: "/labtests/v2/states",
  /** WRITE — a licensed LAB files results here. We only use it from the sandbox helper. */
  labTestRecord: "/labtests/v2/record",
} as const;

/**
 * Transfer type NAMES. The value must match a `Name` returned by
 * GET /transfers/v2/types for the facility. Which types exist is state-specific,
 * so treat these as the MI-sandbox-verified defaults and prefer discovering the
 * live list at runtime (getTransferTypes) when possible.
 */
export const MetrcTransferTypes = {
  /** The only type with ForExternalIncomingShipments:true in MI. ExternalId must be null for it. */
  externalIncoming: "External Cannabinoids",
  /** A licensed (ForLicensedShipments:true) type usable for outgoing templates. */
  outgoingLicensedDefault: "AU Affiliated Transfer",
} as const;

/** PUT identifier field names — differ by entity; wrong one → 400. */
export const MetrcPutIdField = {
  externalIncoming: "TransferId",
  template: "TransferTemplateId",
} as const;

/**
 * Metrc caps the lastModified search window on transfer GETs at ~24h. Build a
 * clamped [start,end] window (ISO-Z strings) ending at `end` (default now).
 */
export function transferWindow(end: Date = new Date(), hours = 24): { lastModifiedStart: string; lastModifiedEnd: string } {
  const clampedHours = Math.min(Math.max(hours, 1), 24);
  const start = new Date(end.getTime() - clampedHours * 60 * 60 * 1000);
  return { lastModifiedStart: start.toISOString(), lastModifiedEnd: end.toISOString() };
}
