-- Session 52 — app-wide soft Cancel (Part 11) rollout.
--
-- Extends the Session 51 destruction-records Cancel pattern to the core QMS
-- entities. QMS records are never hard-deleted (21 CFR Part 11). Cancel retains
-- the row, is recoverable (Re-open / uncancel, Admin-only), and requires a
-- Part 11 e-signature (initials + meaning) from a Manager/Quality/Admin plus a
-- rationale. Cancel is permitted ONLY while the record is In-Process; a
-- Closed / Effective / terminal record cannot be cancelled (server blocks 409).
-- Cancelled records leave the Active list but remain queryable in a Cancelled
-- view.
--
-- Five columns per table, matching destruction_records (Session 51):
--   cancelled_at, cancelled_reason, cancelled_by_name,
--   cancelled_by_initials, cancelled_meaning
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.

ALTER TABLE non_conformances
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;

ALTER TABLE capas
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;

ALTER TABLE incoming_inspections
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;
