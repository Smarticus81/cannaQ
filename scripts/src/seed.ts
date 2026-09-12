import pg from "pg";

const { Pool } = pg;

if (process.env.NODE_ENV === "production" || process.env.SEED_CONFIRM !== "yes-replace-test-data") {
  throw new Error("This seed replaces database records. Use a disposable test database, NODE_ENV=development, and SEED_CONFIRM=yes-replace-test-data.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Relative-date helper ──────────────────────────────────────────────────────
// All date-sensitive rows are computed relative to TODAY so the app always shows
// a realistic mix of "coming due", "overdue", and "recent" no matter when the
// seed is run. `d(-30)` = 30 days ago, `d(20)` = 20 days out. Returns YYYY-MM-DD.
const NOW = new Date();
const d = (offsetDays: number): string => {
  const t = new Date(NOW);
  t.setDate(t.getDate() + offsetDays);
  return t.toISOString().slice(0, 10);
};

async function seed() {
  const client = await pool.connect();
  try {
    console.log("🌱 Seeding CannaQMS database with Michigan cannabis processor data...\n");

    // ── Cleanup (truncate; CASCADE handles dependents, RESTART resets ids) ─────
    console.log("→ Clearing existing seed data...");
    await client.query(`
      TRUNCATE TABLE
        capa_action_items,
        capas,
        corrective_actions,
        non_conformances,
        complaints,
        field_actions,
        packaging_designs,
        batch_labeling,
        batch_testing,
        batch_ingredients,
        batch_records,
        lot_events,
        lots,
        incoming_inspections,
        inventory_items,
        supplier_qualifications,
        supplier_attachments,
        suppliers
      RESTART IDENTITY CASCADE
    `);
    console.log("   ✓ Tables cleared\n");

    // ── Suppliers ─────────────────────────────────────────────────────────────
    console.log("→ Suppliers...");
    const supplierRows = await client.query(`
      INSERT INTO suppliers (supplier_name, contact_person, email, phone, address, license_number, supplier_type, status, quality_rating, notes)
      VALUES
        ('Great Lakes Cannabis Cultivators', 'Mike Terpstra', 'mike@glcc.com', '(616) 555-0101', '4820 Lakeshore Dr, Grand Rapids, MI 49504', 'MICL-100234', 'Cannabis Cultivator', 'Approved', 'A', 'Primary flower supplier. Annual QA audit.'),
        ('Northern Lights Extract Co.', 'Sarah Johansson', 'sarah@nlec.com', '(231) 555-0202', '912 Pine Ridge Rd, Traverse City, MI 49686', 'MICP-200876', 'Cannabis Processor', 'Approved', 'A', 'CO2 and BHO concentrate supplier.'),
        ('Superior Packaging Solutions', 'Dave Kramer', 'dave@superiorpkg.com', '(248) 555-0303', '7300 Industrial Pkwy, Auburn Hills, MI 48326', NULL, 'Packaging Supplier', 'Approved', 'B', 'Child-resistant packaging, cones, and tubes.'),
        ('Pure Michigan Labs', 'Dr. Emily Chen', 'echen@puremilabs.com', '(517) 555-0404', '2100 Science Park Dr, East Lansing, MI 48823', 'MICL-TEST-089', 'Testing Laboratory', 'Approved', 'A+', 'Accredited ISO 17025 cannabis testing lab.'),
        ('Midwest Terpene Supply', 'Jason Park', 'jpark@mwterpenes.com', '(734) 555-0505', '580 Commerce Blvd, Ann Arbor, MI 48108', NULL, 'Raw Material Supplier', 'Conditional', 'B', 'Botanical terpene blends. Re-qualification overdue.'),
        ('Detroit Printing & Labels', 'Rosa Martinez', 'rosa@detroitlabels.com', '(313) 555-0606', '1440 Gratiot Ave, Detroit, MI 48207', NULL, 'Packaging Supplier', 'Pending Review', NULL, 'New supplier under qualification review.')
      RETURNING id, supplier_name
    `);
    const suppliers = supplierRows.rows;
    const supId = (name: string) => suppliers.find(s => s.supplier_name === name)!.id;
    const glccId = supId('Great Lakes Cannabis Cultivators');
    const nlecId = supId('Northern Lights Extract Co.');
    const superiorId = supId('Superior Packaging Solutions');
    const pmlId = supId('Pure Michigan Labs');
    const mwtId = supId('Midwest Terpene Supply');
    console.log(`   ✓ ${suppliers.length} suppliers`);

    // ── Supplier Qualifications / Certificates ────────────────────────────────
    // Varied expiry dates drive the re-qual "review status" that colors the
    // Supplier list + detail (cert-expiry-driven, Session 98). Mix of overdue /
    // coming-due / current so the traffic-light has something to show.
    console.log("→ Supplier qualifications & certificates...");
    await client.query(`
      INSERT INTO supplier_qualifications
        (supplier_id, qual_number, qualification_type, risk_level, status, assessor_name, assessment_date, expiry_date, issuer, certificate_number, approved_by_name, approval_date, notes, created_by_name)
      VALUES
        ($1, 'QUAL-0001', 'Annual Quality Audit',        'High',   'Approved',  'Sarah Kim',    $6,  $7,  'Great Lakes Cannabis Cultivators', 'AUD-2025-GLCC-01', 'Jennifer Wald', $6,  'Cultivation license on file; re-qual now OVERDUE (cert expired).', 'Sarah Kim'),
        ($2, 'QUAL-0002', 'Vendor Qualification',        'Medium', 'Approved',  'Sarah Kim',    $8,  $9,  'Northern Lights Extract Co.',      'ISO-2025-NLEC-22', 'Jennifer Wald', $8,  'Processor cert expiring soon — re-qual COMING DUE.', 'Sarah Kim'),
        ($3, 'QUAL-0003', 'Packaging Supplier Approval', 'Low',    'Approved',  'James Okafor', $10, $11, 'Superior Packaging Solutions',     'PKG-2025-SUP-08',  'Jennifer Wald', $10, 'CR packaging certification current.', 'James Okafor'),
        ($4, 'QUAL-0004', 'ISO 17025 Accreditation',     'Low',    'Approved',  'Jennifer Wald',$12, $13, 'A2LA',                             'ISO17025-PML-441', 'Jennifer Wald', $12, 'Lab accreditation current.', 'Jennifer Wald'),
        ($5, 'QUAL-0005', 'Raw Material Re-Qualification','High',   'Scheduled', 'Sarah Kim',    $14, $15, 'Midwest Terpene Supply',           'RM-2024-MWT-03',   NULL,            NULL,'Conditional supplier; re-qual OVERDUE.', 'Sarah Kim')
    `, [
      glccId, nlecId, superiorId, pmlId, mwtId,
      d(-365), d(-20),   // $6/$7   GLCC assessed 1y ago, expired 20d ago → OVERDUE
      d(-330), d(18),    // $8/$9   NLEC expires in 18d → COMING DUE
      d(-120), d(240),   // $10/$11 Superior current
      d(-90),  d(430),   // $12/$13 PML current
      d(-400), d(-8),    // $14/$15 MWT overdue
    ]);
    console.log("   ✓ 5 qualifications (2 overdue, 1 coming due, 2 current)");

    // ── Inventory catalog (legacy item catalog) ───────────────────────────────
    console.log("→ Inventory items...");
    await client.query(`
      INSERT INTO inventory_items (item_name, item_type, supplier_id, lot_number, quantity, unit_of_measure, reorder_point, reorder_quantity, notes)
      VALUES
        ('CO2 Cannabis Extract — Blue Dream', 'Cannabis Extract', $1, 'NLEC-2025-BD-041', 2850.5, 'g', 500, 2000, 'Stored at 4°C. THC ~82%.'),
        ('Blue Dream Flower — Ground (Pre-roll)', 'Cannabis Flower', $2, 'GLCC-2025-BD-GR-201', 8000.0, 'g', 1000, 4000, 'Ground flower for pre-roll production.'),
        ('Pre-Roll Cones 84mm (1g)', 'Pre-roll Cone', $3, 'SP-2025-CONE84-045', 12000.0, 'units', 3000, 15000, 'RAW-style 84mm cones, 1g fill.'),
        ('Pop-Top Tubes 90mm CR', 'Packaging Material', $3, 'SP-2025-TUBE90-046', 12000.0, 'units', 3000, 15000, 'Child-resistant pop-top tubes.'),
        ('Pre-Roll Compliance Label — MI 1g v3.2', 'Label', $3, 'SP-2025-PRL32-077', 12000.0, 'units', 3000, 15000, 'MI CRA-compliant pre-roll label w/ METRC QR field.'),
        ('Terpene Blend — Blue Dream #7', 'Terpene', $4, 'MWTS-25-BD7-009', 145.0, 'mL', 50, 200, 'Botanical terpene blend.'),
        ('510-Thread CCELL Cartridge 1g', 'Packaging Material', $3, 'SP-2025-CC1G-014', 4200.0, 'units', 1000, 5000, 'CCELL TH2 ceramic core.')
    `, [nlecId, glccId, superiorId, mwtId]);
    console.log("   ✓ 7 inventory items");

    // ── Lots (the on-hand ledger the ingredient picker reads) ─────────────────
    // These are what let you BUILD A BATCH and see inventory deducted. Every
    // received, Active lot with origin<>'produced' is selectable as an ingredient.
    // The four PRE-ROLL lots below are sized so you can produce a full non-infused
    // pre-roll batch (ground flower + cone + tube + label) end to end.
    console.log("→ Lots (on-hand inventory ledger)...");
    await client.query(`
      INSERT INTO lots
        (lot_number, item_name, item_type, unit_of_measure, original_quantity, current_quantity, origin, status, is_cannabis, available_as_ingredient, supplier_id, expiration_date, notes, created_by_name)
      VALUES
        ('GLCC-2025-BD-GR-201', 'Blue Dream Flower — Ground (Pre-roll)', 'Cannabis Flower',    'g',     8000.0, 8000.0, 'received', 'Active', true,  false, $1, $5,   'Ground Blue Dream for pre-rolls. Passed incoming inspection.', 'Sarah Kim'),
        ('SP-2025-CONE84-045',  'Pre-Roll Cones 84mm (1g)',              'Pre-roll Cone',       'units', 12000.0,12000.0,'received', 'Active', false, false, $2, NULL, '84mm pre-roll cones, 1g.', 'James Okafor'),
        ('SP-2025-TUBE90-046',  'Pop-Top Tubes 90mm CR',                 'Packaging Material',  'units', 12000.0,12000.0,'received', 'Active', false, false, $2, NULL, 'Child-resistant pop-top tubes.', 'James Okafor'),
        ('SP-2025-PRL32-077',   'Pre-Roll Compliance Label — MI 1g v3.2','Label',               'units', 12000.0,12000.0,'received', 'Active', false, false, $2, NULL, 'MI CRA pre-roll label.', 'James Okafor'),
        ('NLEC-2025-BD-041',    'CO2 Cannabis Extract — Blue Dream',     'Cannabis Extract',    'g',     2850.5, 2850.5, 'received', 'Active', true,  false, $3, $6,   'CO2 extract, THC ~82%.', 'Sarah Kim'),
        ('MWTS-25-BD7-009',     'Terpene Blend — Blue Dream #7',         'Terpene',             'mL',    145.0,  145.0,  'received', 'Active', false, false, $4, $7,   'Botanical terpene blend.', 'Sarah Kim'),
        ('SP-2025-CC1G-014',    '510-Thread CCELL Cartridge 1g',         'Packaging Material',  'units', 4200.0, 4200.0, 'received', 'Active', false, false, $2, NULL, 'CCELL 1g cartridges.', 'James Okafor'),
        ('MWTS-25-BD7-LOW',     'Terpene Blend — Blue Dream #7 (low)',   'Terpene',             'mL',    12.0,   12.0,   'received', 'Active', false, false, $4, $8,   'Nearly depleted lot — shows a low-stock example.', 'Sarah Kim')
    `, [glccId, superiorId, nlecId, mwtId, d(180), d(120), d(60), d(30)]);
    console.log("   ✓ 8 lots (4 pre-roll materials + 4 other)");

    // ── Incoming Inspections (recent; mix of results) ─────────────────────────
    console.log("→ Incoming inspections...");
    await client.query(`
      INSERT INTO incoming_inspections (inspection_number, supplier_id, supplier_name, po_manifest_number, inspection_date, inspected_by_name, result, inspection_notes)
      VALUES
        ('INS-0001', $1, 'Great Lakes Cannabis Cultivators', 'MAN-2025-GLCC-201', $5, 'Sarah Kim',   'Pass',        'Ground flower for pre-rolls received. Moisture 9.1% (spec <12%). Microbial screen pass. Accepted to inventory.'),
        ('INS-0002', $2, 'Northern Lights Extract Co.',      'MAN-2025-NLEC-041', $6, 'Sarah Kim',   'Pass',        'CO2 extract received. CoA reviewed — all cannabinoids within spec. Residual solvents ND.'),
        ('INS-0003', $3, 'Superior Packaging Solutions',     'PO-2025-SP-045',    $7, 'James Okafor', 'Pass',       'Pre-roll cones + tubes received. Random sample of 50 inspected, no defects.'),
        ('INS-0004', $4, 'Midwest Terpene Supply',           'PO-2025-MWT-009',   $8, 'Sarah Kim',   'Conditional', 'Terpene blend received. beta-caryophyllene slightly below spec (2.8% vs 3.0% min). Accepted conditionally pending internal confirmation.'),
        ('INS-0005', $3, 'Superior Packaging Solutions',     'PO-2025-SP-046',    $9, 'James Okafor', 'Fail',       'CR pop-top torque test failed: avg 0.38 N·m vs 0.45 N·m spec. Lot quarantined, NC opened, returned to supplier.')
      RETURNING id
    `, [glccId, nlecId, superiorId, mwtId, d(-3), d(-6), d(-11), d(-18), d(-2)]);
    console.log("   ✓ 5 inspections (3 Pass, 1 Conditional, 1 Fail)");

    // ── Batch Records (full status spread for the traffic-light) ──────────────
    console.log("→ Batch records...");
    const batchRows = await client.query(`
      INSERT INTO batch_records (batch_number, batch_type, process_type, product_type, strain_name, product_name, status, output_quantity, unit_of_measure, production_date, notes)
      VALUES
        ('BTH-25-0001', 'Production', 'Inhalants', 'Vape Cartridge', 'Blue Dream',   'Blue Dream 1g Vape Cartridge',           'released_to_inventory',    1200, 'units', $1, 'Full panel testing passed. Released to finished goods.'),
        ('BTH-25-0002', 'Production', 'Pre-roll',  'Pre-Roll',       'Blue Dream',   'Blue Dream 1g Pre-Roll (10pk)',          'finished_goods',            600, 'units', $2, 'Non-infused pre-rolls. QC approved, packaged.'),
        ('BTH-25-0003', 'Production', 'Inhalants', 'Concentrate',    'Blue Dream',   'Blue Dream Live Resin — 1g',             'passed_awaiting_packaging', 480, 'units', $3, 'Live resin run. Full panel passed. Awaiting final packaging.'),
        ('BTH-25-0004', 'Production', 'Inhalants', 'Vape Cartridge', 'Blue Dream',   'Blue Dream 0.5g Vape Cartridge',         'testing_in_progress',      2400, 'units', $4, 'Sample submitted to Pure Michigan Labs. Results pending.'),
        ('BTH-25-0005', 'Production', 'Kitchen',   'Edible',         NULL,           'Mixed Berry Cannabis Gummies 10mg',      'in_production',            5000, 'units', $5, 'Gummy production in progress. Infusion complete, setting phase.'),
        ('BTH-25-0006', 'Remediation','Inhalants', 'Concentrate',    'Wedding Cake', 'Wedding Cake Distillate — Remediation',  'on_hold',                   320, 'g',     $6, 'On QA hold pending remediation approval (see NC-25-0002).'),
        ('BTH-25-0007', 'Production', 'Pre-roll',  'Pre-Roll',       'Blue Dream',   'Blue Dream 1g Pre-Roll (single)',        'in_production',            1000, 'units', $7, 'Pre-roll batch in early production.'),
        ('BTH-25-0008', 'Production', 'Inhalants', 'Vape Cartridge', 'Wedding Cake', 'Wedding Cake 1g Vape Cartridge — Lot 2', 'failed',                    880, 'units', $8, 'FAILED — pesticide exceedance (bifenazate). See NC-25-0001 and FA-25-0001.')
      RETURNING id, batch_number
    `, [d(-95), d(-70), d(-40), d(-14), d(-6), d(-16), d(-2), d(-60)]);
    const batches = batchRows.rows;
    const batchByNum: Record<string, number> = Object.fromEntries(batches.map(b => [b.batch_number, b.id]));
    console.log(`   ✓ ${batches.length} batches (spread across every status)`);

    // ── Batch Labeling ────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO batch_labeling (batch_id, product_type, label_version, label_notes, checklist_complete_pct)
      VALUES
        ($1, 'Vape Cartridge', 'v3.2', 'MI compliance label — METRC package tag attached.', 100),
        ($2, 'Pre-Roll',       'v3.2', 'Pre-roll compliance label applied.', 100)
    `, [batchByNum['BTH-25-0001'], batchByNum['BTH-25-0002']]);

    // ── Batch Ingredients (historical display; consumption is per-lot on new batches) ──
    console.log("→ Batch ingredients...");
    await client.query(`
      INSERT INTO batch_ingredients (batch_id, ingredient_name, lot_number, planned_quantity, actual_quantity, unit_of_measure, kind)
      VALUES
        ($1, 'CO2 Cannabis Extract — Blue Dream', 'NLEC-2025-BD-041', 950.0, 942.5, 'g', 'Ingredient'),
        ($1, 'Terpene Blend — Blue Dream #7', 'MWTS-25-BD7-009', 28.5, 28.2, 'mL', 'Ingredient'),
        ($1, '510-Thread CCELL Cartridge 1g', 'SP-2025-CC1G-014', 1200.0, 1200.0, 'units', 'Material'),
        ($2, 'Blue Dream Flower — Ground (Pre-roll)', 'GLCC-2025-BD-GR-201', 600.0, 601.5, 'g', 'Ingredient'),
        ($2, 'Pre-Roll Cones 84mm (1g)', 'SP-2025-CONE84-045', 600.0, 600.0, 'units', 'Material'),
        ($2, 'Pop-Top Tubes 90mm CR', 'SP-2025-TUBE90-046', 600.0, 600.0, 'units', 'Material'),
        ($2, 'Pre-Roll Compliance Label — MI 1g v3.2', 'SP-2025-PRL32-077', 600.0, 600.0, 'units', 'Material')
    `, [batchByNum['BTH-25-0001'], batchByNum['BTH-25-0002']]);
    console.log("   ✓ 7 batch ingredients");

    // ── Batch Test Results (pass + fail + pending) ────────────────────────────
    console.log("→ Batch test results...");
    await client.query(`
      INSERT INTO batch_testing (batch_id, testing_agency, submitted_date, result_date, test_result,
        thc_pct, cbd_pct, total_cannabinoids,
        microbials_pass, pesticides_pass, heavy_metals_pass, residual_solvents_pass, notes)
      VALUES
        ($1, 'Pure Michigan Labs', $6, $7, 'Pass',
         84.2, 0.3, 87.1, true, true, true, true, 'Full panel pass. COA on file.'),
        ($2, 'Pure Michigan Labs', $8, $9, 'Pass',
         21.4, 0.4, 24.8, true, true, true, true, 'Pre-roll flower potency + contaminants pass.'),
        ($3, 'Pure Michigan Labs', $10, $11, 'Pass',
         76.4, 0.8, 82.3, true, true, true, true, 'Live resin — water activity 0.42 (spec ≤0.65).'),
        ($4, 'Pure Michigan Labs', $12, NULL, 'Pending',
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Sample submitted. Results expected shortly.'),
        ($5, 'Pure Michigan Labs', $13, $14, 'Fail',
         79.8, 0.2, 82.3, true, false, true, true, 'FAIL — bifenazate 0.18 ppm (MI CRA limit 0.10 ppm). Batch quarantined, CRA notified.')
    `, [
      batchByNum['BTH-25-0001'], batchByNum['BTH-25-0002'], batchByNum['BTH-25-0003'],
      batchByNum['BTH-25-0004'], batchByNum['BTH-25-0008'],
      d(-90), d(-83), d(-66), d(-60), d(-37), d(-30), d(-12), d(-58), d(-51),
    ]);
    console.log("   ✓ 5 test results (3 Pass, 1 Pending, 1 Fail)");

    // ── Non-Conformances ──────────────────────────────────────────────────────
    console.log("→ Non-conformances...");
    const ncRows = await client.query(`
      INSERT INTO non_conformances (nc_number, title, description, severity, status, source, batch_id, disposition, root_cause)
      VALUES
        ('NC-25-0001', 'Pesticide exceedance — bifenazate in Wedding Cake vape lot BTH-25-0008',
         'Third-party testing (PML-2025-0342) found bifenazate at 0.18 ppm, exceeding Michigan CRA action limit of 0.10 ppm. Lot of 880 cartridges placed on QA hold.',
         'Critical', 'In Progress', 'Testing', $1, 'Destroy',
         'Preliminary findings suggest contaminated flower from supplier lot. Supplier notified and placed on conditional hold.'),
        ('NC-25-0002', 'Out-of-spec moisture in Wedding Cake Distillate remediation lot',
         'In-process moisture check on BTH-25-0006 showed 1.8% vs spec ≤0.5%. Batch placed on hold.',
         'Major', 'Open', 'In-Process', $2, 'Rework', NULL),
        ('NC-25-0003', 'Child-resistant closure torque below spec on pop-top tubes',
         'Incoming inspection torque test averaged 0.38 N·m vs spec minimum 0.45 N·m. Lot quarantined pending supplier response.',
         'Minor', 'Closed', 'Incoming Inspection', NULL, 'Return to Supplier',
         'Manufacturing defect at supplier. Corrective action report issued; replacement lot passed.')
      RETURNING id, nc_number
    `, [batchByNum['BTH-25-0008'], batchByNum['BTH-25-0006']]);
    const ncs = ncRows.rows;
    const ncId = (n: string) => ncs.find(x => x.nc_number === n)!.id;
    console.log(`   ✓ ${ncs.length} non-conformances`);

    // ── Corrective Actions (on-NC; mix overdue / coming due) ──────────────────
    await client.query(`
      INSERT INTO corrective_actions (nc_id, action_description, assigned_to_name, due_date, status)
      VALUES
        ($1, 'Complete root cause analysis — trace bifenazate source. Pull retention samples for retest.', 'Sarah Kim',  $3, 'Open'),
        ($1, 'Supplier re-qualification audit of Great Lakes Cannabis Cultivators.', 'James Okafor', $4, 'Open'),
        ($1, 'Destroy 880 failed cartridges per SOP-DISP-002 with witnessed METRC transfer.', 'James Okafor', $5, 'Open'),
        ($2, 'Complete moisture reduction remediation per SOP-REM-001; re-test before releasing.', 'Sarah Kim', $6, 'Open')
    `, [ncId('NC-25-0001'), ncId('NC-25-0002'), d(-5), d(9), d(3), d(14)]);

    // ── CAPAs (separate workflow; drives the CAPA list traffic-light) ─────────
    // `status` (legacy) is what the CAPA list renders + colors. effectiveness_check_due
    // in the past on a non-closed CAPA reads OVERDUE (urgent).
    console.log("→ CAPAs...");
    await client.query(`
      INSERT INTO capas
        (capa_number, type, title, description, source_nc_id, stage, status,
         originator_name, opened_by_name, effectiveness_owner_name,
         effectiveness_criteria, effectiveness_check_due, product_name,
         closed_by_name, closure_notes, closed_at)
      VALUES
        ('CAPA-25-0001', 'Corrective', 'Eliminate pesticide contamination path (bifenazate)',
         'Corrective + preventive actions following NC-25-0001. Supplier controls + incoming pesticide screen.',
         $1, 'EC Execution', 'Effectiveness Check', 'Sarah Kim', 'Sarah Kim', 'Jennifer Wald',
         'No pesticide failures across next 5 incoming flower lots.', $3, 'Wedding Cake 1g Vape Cartridge',
         NULL, NULL, NULL),
        ('CAPA-25-0002', 'Corrective', 'Moisture control at remediation step',
         'From NC-25-0002. Add in-line moisture verification + operator retraining.',
         $2, 'Action Execution', 'Implementation', 'Sarah Kim', 'Sarah Kim', 'James Okafor',
         'Three consecutive remediation lots meet ≤0.5% moisture.', $4, 'Wedding Cake Distillate',
         NULL, NULL, NULL),
        ('CAPA-25-0003', 'Preventive', 'Preventive pre-roll weight-check calibration',
         'Preventive: schedule scale calibration + pre-roll fill-weight SPC to avoid underfill NCs.',
         NULL, 'Planning', 'Action Planning', 'James Okafor', 'James Okafor', NULL,
         'Fill-weight Cpk ≥ 1.33 over one month.', $5, 'Blue Dream 1g Pre-Roll',
         NULL, NULL, NULL),
        ('CAPA-25-0004', 'Corrective', 'CR packaging torque supplier control',
         'From NC-25-0003 (closed). Supplier torque AQL added to incoming inspection.',
         NULL, 'Closed', 'Closed', 'James Okafor', 'James Okafor', 'Sarah Kim',
         'Two consecutive packaging lots pass torque AQL.', $6, 'Pop-Top Tubes 90mm CR',
         'Jennifer Wald', 'Effectiveness verified; supplier AQL in place. Closed.', NOW()),
        ('CAPA-25-0005', 'Corrective', 'Label reconciliation process gap',
         'Newly opened CAPA: label issuance vs. units produced reconciliation gap found during audit.',
         NULL, 'Initiation', 'Open', 'Jennifer Wald', 'Jennifer Wald', NULL,
         NULL, NULL, 'Blue Dream 1g Pre-Roll',
         NULL, NULL, NULL)
    `, [ncId('NC-25-0001'), ncId('NC-25-0002'), d(-9), d(14), d(25), d(-40)]);
    console.log("   ✓ 5 CAPAs (1 overdue EC, 1 in-implementation, 1 planning, 1 closed, 1 new)");

    // ── Complaints ────────────────────────────────────────────────────────────
    console.log("→ Complaints...");
    await client.query(`
      INSERT INTO complaints (complaint_number, received_date, customer_name, product_name, batch_id, complaint_type, description, severity, status, investigation)
      VALUES
        ('CMP-25-0001', $3, 'Greenleaf Dispensary — Detroit', 'Blue Dream 1g Vape Cartridge', $1,
         'Product Quality', '3 of 12 cartridges failed to produce vapor after ~50% consumed. Hardware suspected.',
         'Medium', 'Under Investigation',
         'Returned cartridges quarantined and submitted to engineering review. Suspected CCELL element failure in a subset of the cartridge lot.'),
        ('CMP-25-0002', $4, 'Zen Garden Provisioning — Lansing', 'Blue Dream 1g Pre-Roll (10pk)', $2,
         'Adverse Event', 'Patient reports dizziness after consuming ~0.3g. No prior adverse events.',
         'High', 'Closed',
         'Retained samples re-tested — all analytes within spec, no pesticides. Concurrent medication interaction suspected. No product defect. Closed, no regulatory report required.')
    `, [batchByNum['BTH-25-0001'], batchByNum['BTH-25-0002'], d(-8), d(-24)]);
    console.log("   ✓ 2 complaints");

    // ── Field Actions ─────────────────────────────────────────────────────────
    console.log("→ Field actions...");
    await client.query(`
      INSERT INTO field_actions (fa_number, action_type, status, title, initiation_reason, affected_batches, scope_description, response_actions)
      VALUES
        ('FA-25-0001', 'Voluntary Recall', 'Response Active',
         'Voluntary Recall — Wedding Cake 1g Vape Cartridge BTH-25-0008 — Pesticide Exceedance',
         'Bifenazate at 0.18 ppm in BTH-25-0008 exceeded MI CRA limit (0.10 ppm). Voluntary recall per CRA 24h rule.',
         'BTH-25-0008',
         '880 units distributed to 4 provisioning centers. ~340 est. unsold.',
         'CRA notified. Dispensaries contacted, inventory holds placed. 220 units returned to date. METRC recall transfer initiated; destruction scheduled.')
    `);
    console.log("   ✓ 1 field action (active recall)");

    // ── Packaging Designs ─────────────────────────────────────────────────────
    console.log("→ Packaging designs...");
    await client.query(`
      INSERT INTO packaging_designs (design_name, product_type, version, status, checklist_complete_pct, notes)
      VALUES
        ('Blue Dream 1g Vape Cartridge — Label', 'Vape Cartridge', '3.2', 'Approved', 100, 'CRA-compliant per R 420.701.'),
        ('Blue Dream 1g Pre-Roll — Tube Label',  'Pre-Roll',       '3.2', 'Approved', 100, 'Pre-roll tube label, CRA-compliant.'),
        ('Mixed Berry Gummies 10mg — Outer Pkg', 'Edible',         '1.0', 'In Review', 65, 'Edible line CRA checklist in progress.'),
        ('Full Spectrum Tincture 1:1 — Bottle',  'Tincture',       '1.0', 'Draft', 30, 'Awaiting legal review of claims.')
    `);
    console.log("   ✓ 4 packaging designs");

    // ── Company Profile ───────────────────────────────────────────────────────
    const existing = await client.query('SELECT id FROM company_profile LIMIT 1');
    if (existing.rowCount === 0) {
      await client.query(`
        INSERT INTO company_profile (company_name, license_number, address, city, state, zip, phone, email, contact_person)
        VALUES ('Great Lakes Processing LLC', 'MICR-P-2021-000148', '3300 Broadmoor Ave SE', 'Grand Rapids', 'MI', '49512', '(616) 555-0100', 'compliance@greatlakesprocessing.com', 'Jennifer Wald')
      `);
      console.log("   ✓ Company profile");
    } else {
      console.log("   · Company profile already exists, skipping.");
    }

    // ── Regulatory Config ─────────────────────────────────────────────────────
    const regExisting = await client.query("SELECT id FROM regulatory_config WHERE state = 'MI' LIMIT 1");
    if (regExisting.rowCount === 0) {
      await client.query(`
        INSERT INTO regulatory_config (state, max_thc_per_serving, max_thc_per_container, potency_tolerance_pct, retention_years, tracing_system)
        VALUES ('MI', 10, 200, 10, 5, 'METRC')
      `);
      console.log("   ✓ Regulatory config (MI)");
    } else {
      console.log("   · Regulatory config already exists, skipping.");
    }

    console.log("\n✅ Seed complete!");
    console.log("   Summary:");
    console.log("   • 6 suppliers + 5 qualifications (2 overdue, 1 coming due)");
    console.log("   • 7 inventory items + 8 lots (incl. a full pre-roll material set)");
    console.log("   • 5 incoming inspections (Pass/Conditional/Fail)");
    console.log("   • 8 batch records (every status) + 5 test results");
    console.log("   • 3 NCs + 4 corrective actions + 5 CAPAs (1 overdue EC)");
    console.log("   • 2 complaints + 1 active field-action recall + 4 packaging designs");
    console.log("\n   ▶ To exercise inventory deduction: create a new Pre-Roll batch and add");
    console.log("     ingredients from lots GLCC-2025-BD-GR-201 (flower), SP-2025-CONE84-045");
    console.log("     (cones), SP-2025-TUBE90-046 (tubes), SP-2025-PRL32-077 (labels), then");
    console.log("     sign the ingredient commit — the lot on-hand quantities will draw down.");

  } catch (err) {
    console.error("❌ Seed failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
