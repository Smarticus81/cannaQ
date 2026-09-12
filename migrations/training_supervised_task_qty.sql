-- Training records gain an open "supervised task quantity" count (2026-07-29).
--
-- When a training's delivery type includes "Direct / Indirect Supervision", the
-- supervisor observes the operator perform some number of tasks before signing
-- off. The number of tasks that warrants sign-off is left to the facility, so
-- this is an open, nullable integer with no default and no backfill.
--
-- Nullable, no new validation. Not gate-critical today (no Part 11 check reads
-- it yet); it exists so a future batch-step gate can require it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the standing Railway/Postgres
-- migration discipline — safe to re-run.
--
-- Ship order (run this BEFORE deploying the new code, so the app's SELECTs find
-- the column): from the Railway shell, or the Railway Database tab -> Run SQL:
--   psql $DATABASE_URL -f migrations/training_supervised_task_qty.sql

ALTER TABLE training_records
  ADD COLUMN IF NOT EXISTS supervised_task_qty integer;

-- No backfill. Existing training records keep supervised_task_qty = NULL.
