-- Session 50 — soft-archive support for destruction records.
--
-- Adds a nullable archived_at timestamp. Archived records (archived_at IS NOT
-- NULL) drop out of the default list and the NC link-selector dropdown but
-- remain queryable for the archived view.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE destruction_records
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
