-- Session 39 (Tier 3 #12a) — Label template lifecycle columns.
--
-- Three coupled additions land together so the new two-signer approval flow
-- has the columns it needs and legacy rows are back-filled into the new
-- vocabulary:
--   1) `status` column (text, default 'draft') driving the lifecycle
--      Draft → Regulatory Approved → Marketing Approved → Approved → Retired.
--   2) Originator (`created_by_id` / `created_by_name`) + the two per-signer
--      column bundles (regulatory_* and marketing_*) so segregation-of-duties
--      checks (originator ≠ signer, signer1 ≠ signer2) can reference the
--      audit trail directly.
--   3) Retirement columns (retired_by_*, retire_reason) so retired rows
--      stay queryable rather than being hard-deleted (auditability of any
--      historical label PDF that referenced the template).
--
-- Per project convention, drizzle-kit push is unreliable for ADD COLUMN +
-- data UPDATE combinations on Replit Postgres, so this SQL ships inline
-- alongside the schema change. Wrapped in a transaction so the migration
-- is all-or-nothing.

BEGIN;

ALTER TABLE label_templates
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS created_by_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_by_name text,
  ADD COLUMN IF NOT EXISTS regulatory_approver_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS regulatory_approver_name text,
  ADD COLUMN IF NOT EXISTS regulatory_approver_initials text,
  ADD COLUMN IF NOT EXISTS regulatory_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS regulatory_approver_meaning text,
  ADD COLUMN IF NOT EXISTS marketing_approver_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS marketing_approver_name text,
  ADD COLUMN IF NOT EXISTS marketing_approver_initials text,
  ADD COLUMN IF NOT EXISTS marketing_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_approver_meaning text,
  ADD COLUMN IF NOT EXISTS retired_by_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS retired_by_name text,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retire_reason text;

-- Back-fill: legacy rows with a stamped `approval_date` predate the
-- two-signer flow. We can't reconstruct which signer was Regulatory vs
-- Marketing, so we land them in the terminal "approved" state with the
-- legacy summary columns intact (those drive the renderer's draft-watermark
-- check). Future edits will reset them to "draft" via the PATCH handler,
-- forcing a fresh two-signer cycle. Unapproved legacy rows stay at the
-- default "draft".
UPDATE label_templates
   SET status = 'approved'
 WHERE status = 'draft'
   AND approval_date IS NOT NULL;

COMMIT;
