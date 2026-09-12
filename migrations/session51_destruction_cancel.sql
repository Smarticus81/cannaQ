-- Session 51 — soft Cancel (Part 11) for destruction records.
--
-- QMS records are never hard-deleted. Cancel retains the row, is recoverable
-- (Uncancel), and requires a Part 11 e-signature (initials + meaning) from a
-- Manager/Quality/Admin plus a rationale. Cancelled records leave the Active
-- list but remain queryable in the Cancelled view.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE destruction_records
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;
