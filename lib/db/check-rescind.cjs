// Read-only check of the 2026-08-27 administrative rescind. Nothing is written.
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const doc = (await c.query(
      `select doc_number, revision, status, approved_by_name, approval_date,
              approver_signed_at, approver_signed_initials,
              reviewer_signed_name, reviewer_signed_at,
              rescinded_at, rescinded_by_name, rescinded_to_status, rescinded_reason
         from documents where id = 52`)).rows[0];
    console.log("DOCUMENT");
    console.log("  status              :", doc.status);
    console.log("  approver signature  :", doc.approver_signed_at ? `KEPT (${doc.approved_by_name} ${doc.approver_signed_initials})` : "*** CLEARED ***");
    console.log("  reviewer signature  :", doc.reviewer_signed_at ? `KEPT (${doc.reviewer_signed_name})` : "*** CLEARED ***");
    console.log("  rescinded           :", doc.rescinded_at ? `${doc.rescinded_by_name} -> ${doc.rescinded_to_status}` : "not rescinded");
    console.log("  reason              :", doc.rescinded_reason ?? "-");

    const revs = (await c.query(
      `select revision, status, admin_action, admin_by_name, admin_by_initials, admin_reason, created_at
         from document_revisions where document_id = 52 order by created_at desc limit 5`)).rows;
    console.log("\nREVISION HISTORY (newest first)");
    for (const r of revs) {
      console.log(`  rev ${r.revision} | ${r.status}` + (r.admin_action ? ` | ${r.admin_action} by ${r.admin_by_name} (${r.admin_by_initials}) — ${r.admin_reason}` : ""));
    }

    const tr = (await c.query(
      `select record_number, employee_name, status, due_date
         from training_records where document_id = 52 order by record_number`)).rows;
    console.log("\nTRAINING ON THIS DOCUMENT");
    for (const t of tr) console.log(`  ${t.record_number} | ${t.employee_name} | ${t.status} | due ${t.due_date ?? "-"}`);

    const audit = (await c.query(
      `select operation, changed_by_name, changed_at from audit_log
        where table_name = 'documents' and row_id = 52 order by changed_at desc limit 4`)).rows;
    console.log("\nAUDIT (newest first)");
    for (const a of audit) console.log(`  ${a.operation} by ${a.changed_by_name}`);
  } finally { await c.end(); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
