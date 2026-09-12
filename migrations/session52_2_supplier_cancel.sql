-- Session 52.2 — soft Cancel (Part 11) for suppliers.
--
-- Replaces the old hard DELETE on suppliers (the last top-level regulated-record
-- hard delete; see Session52_MTR.md Track C). QMS records are never hard-deleted.
-- Cancel retains the row, is recoverable (Re-open / uncancel, Admin-only), and
-- requires a Part 11 e-signature (initials + meaning) from a Manager/Quality/Admin
-- plus a rationale. Cancelled suppliers leave the Active list but remain queryable
-- in the Cancelled view. Distinct from the supplier status lifecycle
-- (Active / Deactivated / reopen).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason      text,
  ADD COLUMN IF NOT EXISTS cancelled_by_name     text,
  ADD COLUMN IF NOT EXISTS cancelled_by_initials text,
  ADD COLUMN IF NOT EXISTS cancelled_meaning     text;
