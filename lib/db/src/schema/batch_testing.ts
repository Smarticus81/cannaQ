import { pgTable, serial, text, integer, real, boolean, date, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { suppliersTable } from "./suppliers";

// Session 36 (Tier 3 #14) — Testing tab redesign. The row now has a `phase`
// lifecycle: starts at "pre_test" when the operator pulls a sample (carrying
// sample weight + uom + pulled-at + by-name + testing-agency selection), and
// advances to "result" when the lab returns the CoA (carrying the analyte
// values in the state-variable `resultValues` jsonb + the CoA attachment).
//
// Legacy columns (testingAgency text, thcPct, cbdPct, totalCannabinoids,
// vitaminEAcetate, the four pass/fail flags, coaUrl) are kept for back-compat
// display — existing rows migrate to phase="result" and keep their values in
// place. New writes populate resultValues plus the agency FK; the UI reads
// resultValues with fallback to the legacy columns.
export const BATCH_TESTING_PHASES = ["pre_test", "result"] as const;
export type BatchTestingPhase = (typeof BATCH_TESTING_PHASES)[number];

export const batchTestingTable = pgTable("batch_testing", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull().default(1),

  // Dual Chamber Vape Cartridge (CRA MI_IB_0114) — which chamber/test-group this
  // sample covers: "A" (Chamber A oil), "B" (Chamber B oil), or "C" (the combined
  // A+B draw). Null on every non-dual-chamber product. Drives per-chamber gating.
  chamber: text("chamber"),

  // Session 36 — phase lifecycle. Existing rows default to "result" via the
  // migration; new pre-test pulls insert with phase="pre_test" and PATCH to
  // "result" when the CoA arrives.
  phase: text("phase").notNull().default("result"),

  // Pre-test fields (Session 36) — set when the operator pulls the sample.
  sampleWeight: real("sample_weight"),
  sampleUom: text("sample_uom"),
  samplePulledAt: date("sample_pulled_at"),
  samplePulledByName: text("sample_pulled_by_name"),

  // Testing agency (Session 36) — FK to suppliers, restricted server-side to
  // supplier_type='Testing Laboratory' AND status='Approved'. The legacy
  // free-text testingAgency column survives for back-compat display on rows
  // that pre-date the FK.
  testingAgencyId: integer("testing_agency_id").references(() => suppliersTable.id),
  testingAgency: text("testing_agency").notNull(),

  submittedDate: date("submitted_date"),
  resultDate: date("result_date"),
  testResult: text("test_result").notNull().default("Pending"),

  // Session 36 — state-variable analyte storage. Keyed by analyte name (e.g.
  // { thc_pct: 18.4, cbd_pct: 0.5, ... }). The valid analyte set per state
  // comes from regulatory_config.additionalConfig.requiredAnalytes; the UI
  // renders the inputs accordingly. Numeric values stored directly; pass/fail
  // analytes (microbials etc.) stored as booleans here too if Test config
  // wants them. The legacy thcPct / cbdPct columns remain for back-compat
  // display until a follow-up backfill migration moves them into this column.
  resultValues: jsonb("result_values"),

  // Legacy hardcoded-analyte columns (pre-Session 36). New code writes
  // resultValues instead; these are read-only fallbacks for display until
  // a future backfill consolidates.
  thcPct: real("thc_pct"),
  cbdPct: real("cbd_pct"),
  totalCannabinoids: real("total_cannabinoids"),
  microbialsPass: boolean("microbials_pass"),
  pesticidesPass: boolean("pesticides_pass"),
  heavyMetalsPass: boolean("heavy_metals_pass"),
  residualSolventsPass: boolean("residual_solvents_pass"),
  vitaminEAcetate: real("vitamin_e_acetate"),
  mctOilPass: boolean("mct_oil_pass"),
  coaUrl: text("coa_url"),
  notes: text("notes"),

  // ── Session 101 (#A) — lab-results pull (Metrc now / BioTrack later) ────────
  // The test-sample package tag is the KEY: the lab posts results to the state
  // system against this tag, and we GET them back by it.
  sampleMetrcTag: text("sample_metrc_tag"),
  // Edibles — per-serving / per-package potency (mg). What the consumer label states.
  thcMgPerServing: real("thc_mg_per_serving"),
  cbdMgPerServing: real("cbd_mg_per_serving"),
  thcMgPerPackage: real("thc_mg_per_package"),
  cbdMgPerPackage: real("cbd_mg_per_package"),
  // In-app potency acceptance (Metrc does NOT fail on THC variance). The label
  // claim is compared to the measured value against a configurable tolerance
  // (regulatory_config.potency_tolerance_pct). Contaminant pass/fail stays the
  // lab's call (the boolean columns above).
  labClaimThc: real("label_claim_thc"),
  labClaimCbd: real("label_claim_cbd"),
  potencyWithinTolerance: boolean("potency_within_tolerance"),
  // Provenance of the result + raw provider payload (audit / debug).
  pullSource: text("pull_source"), // "metrc" | "biotrack" | "manual"
  pulledAt: timestamp("pulled_at", { withTimezone: true }),
  labResultRaw: jsonb("lab_result_raw"),
  // Part 11 verification — a qualified user reviews the pulled result and signs
  // before it may drive a printed compliance label.
  verifiedByName: text("verified_by_name"),
  verifiedByInitials: text("verified_by_initials"),
  verifiedMeaning: text("verified_meaning"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),

  // ---- Lab sample collection (R 420.304(2), 2026-09-08) --------------------
  // Michigan makes the COLLECTION a recorded event, not just a note:
  //  (j) the marihuana business enters the test sample in METRC including the
  //      DATE AND TIME it was collected and transferred;
  //  (g) one of OUR employees must be physically present to observe;
  //  (h) that employee may not assist or touch the product or the equipment;
  //  (i) both employees sign and date a chain-of-custody form attesting to the
  //      product name, its weight, and that everything is correctly identified
  //      in METRC;
  //  (k) the product under test is QUARANTINED — no packaging, transfer or sale
  //      until passing results are in METRC.
  // The pre-existing sample_pulled_at/by columns stay for the rows written
  // before this; these carry the record the rule actually asks for.
  sampleCollectedAt: timestamp("sample_collected_at", { withTimezone: true }),
  sampleTransferredAt: timestamp("sample_transferred_at", { withTimezone: true }),
  /** The METRC package the sample came off — our bulk, not the sample itself. */
  sourcePackageTag: text("source_package_tag"),
  /** What is left in that package after the lab took its sample. */
  sourceRemainingQty: real("source_remaining_qty"),
  sourceRemainingUom: text("source_remaining_uom"),
  /** The laboratory employee who physically collected it (they sign too). */
  labCollectorName: text("lab_collector_name"),
  /** OUR employee who stood there and watched — rule (g). */
  observerName: text("observer_name"),
  // Chain-of-custody attestations — rule (i), plus (g) and (h).
  cocMetrcIdentified: boolean("coc_metrc_identified").notNull().default(false),
  cocObservedThroughout: boolean("coc_observed_throughout").notNull().default(false),
  cocNoAssist: boolean("coc_no_assist").notNull().default(false),
  /** Only asked on a retest — rule (i)(iv). */
  cocRetestConfirmed: boolean("coc_retest_confirmed"),
  cocSignedByName: text("coc_signed_by_name"),
  cocSignedByInitials: text("coc_signed_by_initials"),
  cocSignedMeaning: text("coc_signed_meaning"),
  cocSignedAt: timestamp("coc_signed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchTestingSchema = createInsertSchema(batchTestingTable).omit({ id: true, sequenceNumber: true, createdAt: true, updatedAt: true });
export type InsertBatchTesting = z.infer<typeof insertBatchTestingSchema>;
export type BatchTesting = typeof batchTestingTable.$inferSelect;
