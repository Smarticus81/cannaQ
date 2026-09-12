/** Also used by the SQL-backed onboarding tests. Additive; never touches records. */
export const ONBOARDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id integer PRIMARY KEY REFERENCES users(id),
  revision integer NOT NULL DEFAULT 0,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  completed_revision integer,
  deferred_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS completed_revision integer;
`;
