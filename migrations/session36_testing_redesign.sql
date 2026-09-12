-- Session 36 (Tier 3 #14 + Tier 7 C1 scoped) — Batch process_type discriminator
-- and Testing tab schema redesign.
--
-- Two coupled changes:
--
--   1) batch_records gets a `process_type` column with four valid values
--      (Cultivation | Kitchen | Inhalants | Pre-roll). Existing rows default
--      to "Kitchen" — operators can re-classify any row via the normal PATCH
--      if the legacy guess is wrong. The full cultivation field set (nutrients,
--      env time-series, lifecycle states, plant-level METRC, genealogy) is
--      deferred to Tier 7 C2/C3; this session ships only the discriminator
--      so downstream code can branch on process_type.
--
--   2) batch_testing gets a phase lifecycle plus the new pre-test, agency-FK,
--      and state-variable result columns. The existing free-text testingAgency
--      column AND the hardcoded analyte columns (thc_pct etc.) survive
--      untouched for back-compat display; the new `result_values` jsonb is
--      the canonical storage for state-variable analytes going forward.
--      Existing rows default to phase = 'result' since they predate the
--      pre-test concept — they represent completed tests, not pulls.
--
-- All ADD COLUMN IF NOT EXISTS so the migration is idempotent. The transaction
-- is all-or-nothing.

BEGIN;

-- Batch process_type discriminator (Tier 7 C1 — scoped to discriminator only).
ALTER TABLE batch_records
  ADD COLUMN IF NOT EXISTS process_type text NOT NULL DEFAULT 'Kitchen';

-- Testing schema redesign (Tier 3 #14).
ALTER TABLE batch_testing
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'result',
  ADD COLUMN IF NOT EXISTS sample_weight real,
  ADD COLUMN IF NOT EXISTS sample_uom text,
  ADD COLUMN IF NOT EXISTS sample_pulled_at date,
  ADD COLUMN IF NOT EXISTS sample_pulled_by_name text,
  ADD COLUMN IF NOT EXISTS testing_agency_id integer REFERENCES suppliers(id),
  ADD COLUMN IF NOT EXISTS result_values jsonb;

-- Seed Michigan's required-analyte list into regulatory_config so the UI can
-- render the right per-state analyte inputs out of the box. additional_config
-- is jsonb; the new key piggybacks alongside whatever else lives there.
-- Skips the upsert if a Michigan row doesn't already exist (no insertions
-- here — that's a separate seed concern).
UPDATE regulatory_config
SET additional_config = COALESCE(additional_config, '{}'::jsonb)
                      || jsonb_build_object(
                           'requiredAnalytes',
                           jsonb_build_array('thc_pct', 'cbd_pct')
                         )
WHERE state = 'Michigan'
  AND (additional_config IS NULL OR NOT (additional_config ? 'requiredAnalytes'));

COMMIT;
