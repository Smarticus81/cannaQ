-- Session 35 (Tier 3 #13) — CAPA timeline restructure with Gate 0.
--
-- Two coupled changes that land together:
--   1) Six new columns on `capas` for Gate 0 (Manager/Quality acceptance at
--      Initiation → Investigation). All nullable so existing rows are
--      grandfathered.
--   2) Stage consolidation: the prior "Action Planning" and "EC Planning"
--      stages collapse into a single "Planning" stage. Every existing CAPA
--      row carrying one of those values gets remapped to "Planning". After
--      this migration the server-side CAPA_STAGES enum no longer accepts
--      "Action Planning" or "EC Planning" — any inserts attempting those
--      values will be rejected by the route layer's validation.
--
-- Per project convention, drizzle-kit push doesn't reliably handle the
-- combination of ADD COLUMN + data UPDATE on Replit Postgres, so this SQL
-- ships inline alongside the schema change. Wrapped in a transaction so the
-- migration is all-or-nothing.

BEGIN;

ALTER TABLE capas
  ADD COLUMN IF NOT EXISTS gate0_approver_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS gate0_approver_name text,
  ADD COLUMN IF NOT EXISTS gate0_approver_initials text,
  ADD COLUMN IF NOT EXISTS gate0_approver_at timestamptz,
  ADD COLUMN IF NOT EXISTS gate0_approver_meaning text,
  ADD COLUMN IF NOT EXISTS gate0_approved_at timestamptz;

-- Consolidate the two former planning stages into a single "Planning" stage.
-- Both old values map to the same target; no information is lost (the
-- per-phase due-date columns investigation_due_date / action_planning_due_date
-- / ec_planning_due_date all survive untouched).
UPDATE capas SET stage = 'Planning' WHERE stage IN ('Action Planning', 'EC Planning');

-- Last_rejection_target similarly used the old "Action Planning" value when a
-- gate rolled the CAPA back to plan-revision. Normalize the historical record
-- so the audit trail reads cleanly against the new vocabulary.
UPDATE capas SET last_rejection_target = 'Planning' WHERE last_rejection_target = 'Action Planning';

COMMIT;
