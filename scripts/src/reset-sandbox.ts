import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Wipes all transactional data while keeping users, recipes, and label
// templates/blocks intact so the sandbox can be re-walked end-to-end.
const TABLES_TO_TRUNCATE = [
  "audit_log",
  "attachments",
  "lot_events",
  "lots",
  "batch_labeling",
  "batch_testing",
  "batch_ingredients",
  "checklist_responses",
  "checklist_items",
  "document_sections",
  "documents",
  "training_assignments",
  "training_acknowledgments",
  "corrective_actions",
  "corrective_action_items",
  "nc_corrections",
  "non_conformances",
  "complaints",
  "field_actions",
  "incoming_inspection_items",
  "incoming_inspections",
  "supplier_attachments",
  "supplier_qualifications",
  "suppliers",
  "inventory_items",
  "batch_records",
];

async function run() {
  // Hard guard: never run against production.
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1") {
    console.error("✗ REFUSED: reset-sandbox cannot run in production (NODE_ENV=production or REPLIT_DEPLOYMENT=1).");
    process.exit(2);
  }
  if (process.env.RESET_SANDBOX_CONFIRM !== "yes-wipe-sandbox") {
    console.error('✗ REFUSED: set RESET_SANDBOX_CONFIRM="yes-wipe-sandbox" to confirm this destructive operation.');
    console.error('  e.g. RESET_SANDBOX_CONFIRM=yes-wipe-sandbox pnpm --filter @workspace/scripts run reset-sandbox');
    process.exit(2);
  }
  const client = await pool.connect();
  try {
    console.log("\n⚠️  Resetting sandbox database…\n");
    console.log("KEEPING: users, recipes, recipe_items, label_templates, label_static_blocks");
    console.log("WIPING: " + TABLES_TO_TRUNCATE.join(", ") + "\n");

    // Probe which target tables actually exist (some optional ones may not).
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [TABLES_TO_TRUNCATE],
    );
    const present = existing.rows.map((r: { table_name: string }) => r.table_name);
    if (present.length === 0) { console.log("Nothing to wipe."); return; }
    const sql = `TRUNCATE TABLE ${present.join(", ")} RESTART IDENTITY CASCADE`;
    await client.query(sql);
    console.log(`✓ Truncated ${present.length} table(s).\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
