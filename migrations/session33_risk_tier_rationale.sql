-- Session 33 (Tier 2 #9) — Risk Tier rationale + lineage on suppliers.
--
-- Operator-set Risk Tier now requires a documented rationale on every
-- assignment. These three columns mirror the latest rationale alongside the
-- supplier row for at-a-glance display; the full history lives in audit_log
-- where each tier change writes a RISK_TIER_SET / RISK_TIER_CHANGE entry.
--
-- All three columns are nullable so existing rows (which pre-date this
-- requirement) don't fail the migration. Server-side validation requires the
-- rationale at create time and on every PATCH that changes risk_tier; legacy
-- rows are grandfathered until the next operator touches them.
--
-- drizzle-kit push doesn't work reliably on the Replit Postgres instance, so
-- this ALTER ships inline with the schema change per project convention.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS risk_tier_rationale text,
  ADD COLUMN IF NOT EXISTS risk_tier_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_tier_set_by_name text;
