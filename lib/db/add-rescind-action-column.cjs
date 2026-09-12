// One-off DDL for the 2026-08-27 "Obsolete -> Draft" build: one nullable column that
// records WHICH administrative move produced the notice on a document.
// Run BEFORE deploying the code that reads it. Safe to run more than once.
const { Client } = require("pg");
(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_action text;`);
    const { rows } = await c.query(
      `select column_name from information_schema.columns
        where table_name = 'documents' and column_name = 'rescinded_action'`);
    console.log(rows.length ? "documents.rescinded_action is in place." : "*** column missing ***");
  } finally { await c.end(); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
