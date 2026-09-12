-- Session 48 (2026-05-28) — NC detail polish columns.
--
-- Adds four new columns to non_conformances. Three are simple metadata
-- fields the operator captures; the fourth (skip_capa_rationale) is gated
-- on the server at closure when severity is Major/Critical and no CAPA is
-- linked.
--
-- All ADDs are guarded with IF NOT EXISTS so this migration is idempotent
-- and can re-run safely on environments where some columns already exist
-- (per the project's standing Railway/Postgres migration discipline).
--
-- Ship instructions (from Replit/Railway shell):
--   psql $DATABASE_URL -f migrations/session48_nc_columns.sql
-- Or via Railway Database tab → Run SQL.

ALTER TABLE non_conformances
  ADD COLUMN IF NOT EXISTS identified_at         date,
  ADD COLUMN IF NOT EXISTS severity_rationale    text,
  ADD COLUMN IF NOT EXISTS reported_by_name      text,
  ADD COLUMN IF NOT EXISTS skip_capa_rationale   text;

-- No backfill needed. Legacy NCs have NULL for these fields, which is fine —
-- the closure-gate only applies to NCs being closed AFTER this migration
-- (existing closed NCs are untouched).
