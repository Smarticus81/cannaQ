// One-off DDL for the 2026-08-27 administrative-rescind columns.
// Run with DATABASE_URL (use Railway's DATABASE_PUBLIC_URL when running from a laptop).
// Safe to run more than once: every statement is ADD COLUMN IF NOT EXISTS.
const { Client } = require("pg");

const SQL = `
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS rescinded_at        timestamptz,
  ADD COLUMN IF NOT EXISTS rescinded_reason    text,
  ADD COLUMN IF NOT EXISTS rescinded_by_name   text,
  ADD COLUMN IF NOT EXISTS rescinded_to_status text;

ALTER TABLE document_revisions
  ADD COLUMN IF NOT EXISTS admin_action      text,
  ADD COLUMN IF NOT EXISTS admin_reason      text,
  ADD COLUMN IF NOT EXISTS admin_by_name     text,
  ADD COLUMN IF NOT EXISTS admin_by_initials text,
  ADD COLUMN IF NOT EXISTS admin_meaning     text;
`;

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Set it first, then run this again.");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(SQL);
    const { rows } = await client.query(`
      select table_name, column_name
      from information_schema.columns
      where (table_name = 'documents' and column_name like 'rescinded_%')
         or (table_name = 'document_revisions' and column_name like 'admin_%')
      order by table_name, column_name
    `);
    console.log("Columns now present:");
    for (const r of rows) console.log("  " + r.table_name + "." + r.column_name);
    console.log(rows.length === 9 ? "\nAll 9 columns are in place." : "\nExpected 9 columns, found " + rows.length);
  } finally {
    await client.end();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
