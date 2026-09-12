-- Session 54 (2026-06-04) — NC "Reported By" gains a user-id reference.
--
-- "Reported By" on a non-conformance is always an internal app user
-- (decision B, confirmed 2026-06-04: NCs are reported by people with system
-- access; customer names belong on Complaints, which stay free-text). This
-- adds the canonical id reference alongside the existing reported_by_name,
-- so the field can be filtered/segregated by user and the name never drifts
-- from the person.
--
-- Not gate-critical: no Part 11 segregation check reads reported_by (confirmed
-- in the Session 53 sweep). Nullable, no new validation.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the standing Railway/Postgres
-- migration discipline — safe to re-run.
--
-- Ship instructions (from the Railway shell, AFTER pushing the code):
--   psql $DATABASE_URL -f migrations/session54_nc_reported_by.sql
-- Or via the Railway Database tab -> Run SQL. Or double-click apply_session54.bat.

ALTER TABLE non_conformances
  ADD COLUMN IF NOT EXISTS reported_by_user_id integer REFERENCES users(id);

-- No backfill. Legacy NCs created before this migration keep reported_by_user_id
-- = NULL until they are re-saved through the user picker (expected, not a bug).
-- reported_by_name is retained and continues to display.
