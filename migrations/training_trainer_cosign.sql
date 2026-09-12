-- Training records gain a trainer competency co-sign (2026-07-29).
--
-- For "Direct / Indirect Supervision" training, the operator performs tasks under
-- a trainer, then the TRAINER attests (Part 11) that the operator is competent.
-- Such a record only reaches "Completed" once BOTH the operator's acknowledgment
-- (the existing signed_* columns) and this trainer co-sign are present, and the
-- two signers must be different people. Other training types are unaffected — they
-- still complete on the single acknowledgment.
--
-- All nullable, no backfill, no new validation on existing rows.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the standing Railway/Postgres
-- migration discipline — safe to re-run.
--
-- Ship order: run this BEFORE deploying the new code, so the app's SELECTs find
-- the columns. From the Railway Database tab -> Run SQL, paste the ALTER below, or:
--   psql $DATABASE_URL -f migrations/training_trainer_cosign.sql

ALTER TABLE training_records
  ADD COLUMN IF NOT EXISTS trainer_signed_initials text,
  ADD COLUMN IF NOT EXISTS trainer_signed_meaning text,
  ADD COLUMN IF NOT EXISTS trainer_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trainer_signed_by_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS trainer_signed_by_full_name text;

-- No backfill. Existing training records keep the new columns NULL.
