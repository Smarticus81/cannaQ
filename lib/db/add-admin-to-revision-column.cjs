// One-off DDL: records where an administrative move LEFT the document, so revision
// history can read "Rev 1.0 -> 1.1". Run BEFORE deploying. Safe to re-run.
//
// Usage (paste the Railway DATABASE_PUBLIC_URL as an argument, in quotes):
//   node add-admin-to-revision-column.cjs "postgresql://user:pass@host:port/railway"
const { Client } = require("pg");

function cleanUrl(raw) {
  if (!raw) return "";
  let u = String(raw).trim();
  u = u.replace(/^[<"\'\s]+/, "").replace(/[>"\'\s]+$/, "");
  return u;
}

(async () => {
  const url = cleanUrl(process.argv[2] || process.env.DATABASE_URL);
  if (!url) {
    console.error("No connection string. Pass it as an argument, in quotes:");
    console.error('  node add-admin-to-revision-column.cjs "postgresql://...rlwy.net:PORT/railway"');
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.error("That does not look like a Postgres URL - it should start with postgresql://");
    console.error("  got: " + url.slice(0, 40));
    process.exit(1);
  }
  let host = "(unparsed)";
  try { host = new URL(url).hostname; } catch (e) { }
  if (host.endsWith(".railway.internal")) {
    console.error("That is the INTERNAL url (" + host + ") - it only resolves inside Railway.");
    console.error("Use DATABASE_PUBLIC_URL, the one containing proxy.rlwy.net");
    process.exit(1);
  }
  console.log("Connecting to " + host + " ...");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_to_revision text;");
    const r = await c.query("select column_name from information_schema.columns where table_name = 'document_revisions' and column_name = 'admin_to_revision'");
    console.log(r.rows.length ? "document_revisions.admin_to_revision is in place." : "*** column missing ***");
  } finally { await c.end(); }
})().catch(function (e) { console.error("FAILED:", e.message); process.exit(1); });
