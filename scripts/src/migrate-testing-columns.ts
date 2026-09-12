import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Direct, idempotent migration for the Session 101 (#A) lab-results-pull columns
// on batch_testing. All additive + nullable → safe to run any time, and a no-op
// if already applied. Use this if `drizzle-kit push` hangs on "pulling schema".
async function run() {
  const client = await pool.connect();
  try {
    console.log("→ Adding batch_testing lab-results columns (IF NOT EXISTS)…");
    await client.query(`
      ALTER TABLE batch_testing
        ADD COLUMN IF NOT EXISTS sample_metrc_tag        TEXT,
        ADD COLUMN IF NOT EXISTS thc_mg_per_serving      REAL,
        ADD COLUMN IF NOT EXISTS cbd_mg_per_serving      REAL,
        ADD COLUMN IF NOT EXISTS thc_mg_per_package      REAL,
        ADD COLUMN IF NOT EXISTS cbd_mg_per_package      REAL,
        ADD COLUMN IF NOT EXISTS label_claim_thc         REAL,
        ADD COLUMN IF NOT EXISTS label_claim_cbd         REAL,
        ADD COLUMN IF NOT EXISTS potency_within_tolerance BOOLEAN,
        ADD COLUMN IF NOT EXISTS pull_source             TEXT,
        ADD COLUMN IF NOT EXISTS pulled_at               TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS lab_result_raw          JSONB,
        ADD COLUMN IF NOT EXISTS verified_by_name        TEXT,
        ADD COLUMN IF NOT EXISTS verified_by_initials    TEXT,
        ADD COLUMN IF NOT EXISTS verified_meaning        TEXT,
        ADD COLUMN IF NOT EXISTS verified_at             TIMESTAMPTZ
    `);
    console.log("✅ Done — 15 columns ensured on batch_testing.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(() => process.exit(1));
