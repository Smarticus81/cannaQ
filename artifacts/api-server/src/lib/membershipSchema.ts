/** Preserve existing single-site access once, when upgrading a database that
 * predates explicit membership. Subsequent boots never restore revoked access. */
export const MEMBERSHIP_SCHEMA_SQL = `
DO $membership$
BEGIN
  IF to_regclass('public.user_facilities') IS NULL THEN
    CREATE TABLE user_facilities (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      role_at_facility TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    IF (SELECT count(*) FROM facilities WHERE is_active) = 1 THEN
      INSERT INTO user_facilities(user_id, facility_id)
      SELECT u.id, f.id FROM users u CROSS JOIN facilities f WHERE u.active AND f.is_active;
    END IF;
  END IF;
END $membership$;
CREATE UNIQUE INDEX IF NOT EXISTS user_facilities_user_facility_key ON user_facilities(user_id, facility_id);
`;
