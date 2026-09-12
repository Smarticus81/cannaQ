-- Session 34 (Tier 2 #10) — CAPA initial Risk classification + revision tracking.
--
-- Adds eleven columns to `capas`. None are NOT NULL so existing rows (which
-- pre-date the requirement) don't fail the migration. The server enforces
-- risk_level + risk_rationale on every NEW CAPA, and requires a revision
-- reason whenever risk_level is changed on an existing CAPA. Legacy rows are
-- grandfathered until the next operator touches them.
--
-- Five boolean prompts correspond to the QMS review's guiding questions:
--   • risk_released         — was the affected lot released to customers?
--   • risk_customer_affected — has a customer been impacted?
--   • risk_labeling_impact  — is product labeling implicated?
--   • risk_in_house_only    — confined to internal use, no external exposure?
--   • risk_pre_bulk         — caught pre-bulk (i.e. before the material was committed)?
--
-- None of these auto-compute risk_level; they're stored for the Track C Risk
-- Memory agent (Tier 6) to learn from over time.
--
-- The four risk_revised_* columns mirror the most recent revision for display;
-- the full revision history lives in audit_log under operation = RISK_REVISED.

ALTER TABLE capas
  ADD COLUMN IF NOT EXISTS risk_level text,
  ADD COLUMN IF NOT EXISTS risk_rationale text,
  ADD COLUMN IF NOT EXISTS risk_released boolean,
  ADD COLUMN IF NOT EXISTS risk_customer_affected boolean,
  ADD COLUMN IF NOT EXISTS risk_labeling_impact boolean,
  ADD COLUMN IF NOT EXISTS risk_in_house_only boolean,
  ADD COLUMN IF NOT EXISTS risk_pre_bulk boolean,
  ADD COLUMN IF NOT EXISTS risk_revised_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_revised_by_name text,
  ADD COLUMN IF NOT EXISTS risk_revised_reason text,
  ADD COLUMN IF NOT EXISTS risk_revised_from text;
