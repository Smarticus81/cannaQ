-- Session 38 (Tier 4 polish batch — items #19 + #20).
--
-- Two schema deltas:
--
--   1) batch_records.scheduled_output_quantity — operator-captured planned
--      output at batch open. Pairs with the existing output_quantity (actual)
--      so the Production Output dashboard chart can render planned-vs-actual
--      bars and BatchDetail can show a variance % per batch. Nullable so
--      legacy batches (no planned figure on record) render with just the
--      actual bar and skip the variance line.
--
--   2) complaints — MVP expansion per the Tier 4 #20 ask. Adds reporter
--      contact fields (name / email / phone), an operator-entered lot_number
--      string, a severity_rationale free-text column, and three regulatory
--      notification booleans (MDR / MDARD / FDA). The full FDA × ISO 13485
--      × food-reg cross-walk is the Tier 5 research effort and will land
--      as a separate later expansion. Booleans default false so legacy
--      rows read as "no reportable obligation noted at intake."
--
-- All new columns are nullable (or boolean NOT NULL DEFAULT false) so the
-- migration is non-destructive and idempotent (ADD COLUMN IF NOT EXISTS).
-- Wrapped in a transaction so the two ALTERs land together.

BEGIN;

-- (Tier 4 #19) Scheduled output quantity on batch_records.
ALTER TABLE batch_records
  ADD COLUMN IF NOT EXISTS scheduled_output_quantity real;

-- (Tier 4 #20) Expanded complaint intake.
ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS reporter_name text,
  ADD COLUMN IF NOT EXISTS reporter_email text,
  ADD COLUMN IF NOT EXISTS reporter_phone text,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS severity_rationale text,
  ADD COLUMN IF NOT EXISTS mdr_reportable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mdard_reportable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fda_reportable boolean NOT NULL DEFAULT false;

COMMIT;
