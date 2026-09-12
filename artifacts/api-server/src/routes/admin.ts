import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  recipesTable,
  recipeItemsTable,
  auditLogTable,
  suppliersTable,
  supplierQualificationsTable,
  inventoryItemsTable,
  lotsTable,
  lotEventsTable,
} from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { seedStarterDocuments, removeStarterDocuments } from "../lib/seedStarterDocuments";
import { seedStarterInventory, removeStarterInventory } from "../lib/seedStarterInventory";

const router = Router();

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

interface SeedItem {
  ingredientName: string;
  plannedQuantity: number;
  unitOfMeasure: string;
  kind: "Ingredient" | "Material";
  notes?: string;
}
interface SeedRecipe { productType: string; productName: string; notes: string; items: SeedItem[]; }

const RECIPES: SeedRecipe[] = [
  { productType: "Edible", productName: "Chocolate Chip Cookies — 100ct (10mg THC each)", notes: "Standard 100-count batch. Cannabutter swap for unsalted butter. Target dose: 10 mg THC / cookie.", items: [
    { ingredientName: "Cannabutter (infused, ~75 mg THC/g)", plannedQuantity: 454, unitOfMeasure: "g", kind: "Ingredient", notes: "Replaces butter; potency-validated lot required" },
    { ingredientName: "All-purpose flour", plannedQuantity: 1080, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Granulated sugar", plannedQuantity: 400, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Brown sugar (packed)", plannedQuantity: 440, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Eggs (large)", plannedQuantity: 4, unitOfMeasure: "ea", kind: "Ingredient" },
    { ingredientName: "Vanilla extract", plannedQuantity: 20, unitOfMeasure: "mL", kind: "Ingredient" },
    { ingredientName: "Baking soda", plannedQuantity: 10, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Salt (fine)", plannedQuantity: 6, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Semi-sweet chocolate chips", plannedQuantity: 680, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Child-resistant 100ct edible pouch", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Edible MI)", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
  ] },
  { productType: "Edible", productName: "Chocolate Brownies — 100ct (10mg THC each)", notes: "Cut into 100 squares from full sheet pan. Cannabutter swap for butter.", items: [
    { ingredientName: "Cannabutter (infused, ~75 mg THC/g)", plannedQuantity: 454, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Granulated sugar", plannedQuantity: 800, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Eggs (large)", plannedQuantity: 6, unitOfMeasure: "ea", kind: "Ingredient" },
    { ingredientName: "Vanilla extract", plannedQuantity: 15, unitOfMeasure: "mL", kind: "Ingredient" },
    { ingredientName: "All-purpose flour", plannedQuantity: 360, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Cocoa powder (unsweetened)", plannedQuantity: 200, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Salt (fine)", plannedQuantity: 6, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Baking powder", plannedQuantity: 6, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Child-resistant 100ct edible pouch", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Edible MI)", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
  ] },
  { productType: "Edible", productName: "Rice Crispy Squares — 100ct (10mg THC each)", notes: "Cannabutter swap for butter. ~12g per square.", items: [
    { ingredientName: "Cannabutter (infused, ~75 mg THC/g)", plannedQuantity: 454, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Mini marshmallows", plannedQuantity: 1360, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Crisp rice cereal", plannedQuantity: 900, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Vanilla extract", plannedQuantity: 10, unitOfMeasure: "mL", kind: "Ingredient" },
    { ingredientName: "Salt (fine)", plannedQuantity: 4, unitOfMeasure: "g", kind: "Ingredient" },
    { ingredientName: "Child-resistant 100ct edible pouch", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Edible MI)", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
  ] },
  { productType: "Vape Cartridge", productName: "Vape Cartridges — 1g (100ct batch)", notes: "100 carts × 1g distillate + terpene blend.", items: [
    { ingredientName: "Cannabis Distillate", plannedQuantity: 95, unitOfMeasure: "g", kind: "Ingredient", notes: "95% w/w of fill" },
    { ingredientName: "Cannabis-derived Terpenes", plannedQuantity: 5, unitOfMeasure: "g", kind: "Ingredient", notes: "5% w/w terpene blend" },
    { ingredientName: "510 Vape Cartridge (1g, ceramic core)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Vape Mouthpiece", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Vape MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
  ] },
  { productType: "Pre-Roll", productName: "Raw Pre-Rolls — 1g (100ct batch)", notes: "Ground flower only, no infusion.", items: [
    { ingredientName: "Cannabis Flower (ground)", plannedQuantity: 100, unitOfMeasure: "g", kind: "Ingredient", notes: "1g per cone" },
    { ingredientName: "Pre-Roll Cone (King-size, refined white)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Pre-Roll MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
  ] },
  { productType: "Infused Pre-Roll", productName: "Infused Pre-Rolls — 1.5g (100ct batch)", notes: "Flower core + distillate coat + THCa kief outer. MI classifies as a concentrate for testing/labeling (bulletin 9/19/2022).", items: [
    { ingredientName: "Cannabis Flower (ground)", plannedQuantity: 100, unitOfMeasure: "g", kind: "Ingredient", notes: "1g flower core per cone" },
    { ingredientName: "Cannabis Distillate", plannedQuantity: 30, unitOfMeasure: "g", kind: "Ingredient", notes: "0.3g distillate coat per cone" },
    { ingredientName: "THCa Diamonds / Kief", plannedQuantity: 20, unitOfMeasure: "g", kind: "Ingredient", notes: "0.2g outer dust per cone" },
    { ingredientName: "Pre-Roll Cone (King-size, refined white)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    { ingredientName: "Compliance label (Pre-Roll MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
  ] },
];

// ── Sample data (unified lot-ledger model) ──────────────────────────────────
// Session 79 (Step 2). Optional fresh sample data rebuilt under the unified
// model: a raw-material CATALOG (inventory_items: name/type/UoM/reorder/supplier)
// with one linked on-hand LOT each (lots.inventory_item_id), so the Inventory
// screen (reads lots) and Lot Traceability (cannabis lots) populate and agree by
// construction. Cannabis items get is_cannabis=true so they appear on Lot
// Traceability; non-cannabis (terpenes/packaging/labels/excipients) stay
// inventory-only. "Just info for practicing and validation" — Jonathan, 06-23.

// Mirrors CannaQ_OQ_Sample_Data_v2.xlsx → "Suppliers" sheet. riskTier +
// riskTierRationale are operator-set base tiers carried from the sheet's "Risk
// Tier" / "Risk Tier Rationale" columns. Row 7 (Unverified Terpene Imports) is
// intentionally NOT approved.
interface SeedSupplier {
  supplierName: string; contactPerson: string | null; email: string; phone: string;
  licenseNumber: string | null; supplierType: string;
  status: string; riskTier: string; riskTierRationale: string; notes: string;
}

const SAMPLE_SUPPLIERS: SeedSupplier[] = [
  { supplierName: "Green Valley Cultivation LLC", contactPerson: "Dana Green", email: "dana@greenvalley.test", phone: "(231) 555-0142", licenseNumber: "AU-C-000123", supplierType: "Cannabis Cultivator", status: "Approved", riskTier: "Critical", riskTierRationale: "Direct cannabis input (flower) consumed in batches.", notes: "Supplies: Flower (Blue Dream, Northern Lights, Sour Diesel)." },
  { supplierName: "PureExtract Processors LLC", contactPerson: "Raj Patel", email: "qa@pureextract.test", phone: "(616) 555-0177", licenseNumber: "PR-000456", supplierType: "Cannabis Processor", status: "Approved", riskTier: "Critical", riskTierRationale: "Supplies THC distillate used in edibles + vapes; direct potency-bearing input.", notes: "Supplies: THC distillate." },
  { supplierName: "VapeTech Hardware Supply", contactPerson: "Lily Chen", email: "sales@vapetech.test", phone: "(248) 555-0190", licenseNumber: null, supplierType: "Equipment Supplier", status: "Approved", riskTier: "Medium", riskTierRationale: "Standard hardware vendor, established history.", notes: "Supplies: CCELL TH2 cartridges." },
  { supplierName: "ClearPack Solutions", contactPerson: "Tom Hale", email: "orders@clearpack.test", phone: "(313) 555-0123", licenseNumber: null, supplierType: "Packaging Supplier", status: "Approved", riskTier: "Medium", riskTierRationale: "Food/cannabis-contact packaging; standard vendor.", notes: "Supplies: Mylar pouches, glass jars, cart boxes." },
  { supplierName: "GreenLeaf Analytics", contactPerson: "Dr. Amy Cole", email: "results@greenleaflab.test", phone: "(517) 555-0166", licenseNumber: "SL-000789", supplierType: "Testing Laboratory", status: "Approved", riskTier: "Low", riskTierRationale: "State-licensed lab, long track record; COA source.", notes: "Supplies: COAs (potency, pesticides, micro, metals)." },
  { supplierName: "Sweet Source Foods", contactPerson: "Bea Fields", email: "sales@sweetsource.test", phone: "(269) 555-0181", licenseNumber: null, supplierType: "Raw Material Supplier", status: "Approved", riskTier: "Medium", riskTierRationale: "FDA-registered food ingredient vendor.", notes: "Supplies: Cane sugar, pectin, natural flavor." },
  { supplierName: "Unverified Terpene Imports", contactPerson: null, email: "info@uvterp.test", phone: "(000) 000-0000", licenseNumber: null, supplierType: "Raw Material Supplier", status: "Pending Review", riskTier: "High", riskTierRationale: "New vendor, no Michigan track record; documentation incomplete.", notes: "INTENTIONAL: NOT approved. Confirms an unapproved supplier is flagged and cannot pass qualification yet." },
  { supplierName: "Terpene Source Labs", contactPerson: "Tess Moreno", email: "qa@terpenesource.test", phone: "(231) 555-0210", licenseNumber: null, supplierType: "Raw Material Supplier", status: "Approved", riskTier: "Medium", riskTierRationale: "Food-grade botanical terpene blends added to vape formulation; non-cannabis input.", notes: "Supplies: Botanical terpenes (Blue Dream profile)." },
  { supplierName: "RollRight Pre-Roll Supply", contactPerson: "Gil Anders", email: "orders@rollright.test", phone: "(616) 555-0233", licenseNumber: null, supplierType: "Packaging Supplier", status: "Approved", riskTier: "Medium", riskTierRationale: "Pre-roll cones + filter tips; cannabis-contact packaging.", notes: "Supplies: Pre-roll cones, filter tips." },
];

// Mirrors the v2 "Supplier Quals" sheet. A supplier only clears "Never
// Qualified" when it has an Approved qual WITH an approvalDate — the review/risk
// logic in suppliers.ts keys on the latest such date. So every approved vendor
// gets one Approved record; the unapproved vendor gets an open (non-Approved)
// For-Cause review and stays non-qualified. Green Valley's approvalDate is set
// >1yr back so it surfaces as OVERDUE for re-qualification (intentional v2 test).
interface SeedQual {
  supplierName: string; qualificationType: string; riskLevel: string;
  status: string; assessorName: string; assessmentDate: string;
  approvalDate: string | null; expiryDate: string | null; notes: string;
}

const SAMPLE_QUALS: SeedQual[] = [
  { supplierName: "Green Valley Cultivation LLC", qualificationType: "Annual Re-qualification", riskLevel: "Critical", status: "Approved", assessorName: "Quentin Lake", assessmentDate: "2025-05-20", approvalDate: "2025-05-20", expiryDate: "2026-06-01", notes: "INTENTIONAL: approval >1yr old → surfaces as overdue / due for re-qualification." },
  { supplierName: "PureExtract Processors LLC", qualificationType: "Initial Qualification", riskLevel: "Critical", status: "Approved", assessorName: "Quentin Lake", assessmentDate: "2026-02-01", approvalDate: "2026-02-01", expiryDate: "2027-02-01", notes: "Distillate COAs reviewed; solvent panel acceptable." },
  { supplierName: "VapeTech Hardware Supply", qualificationType: "Initial Qualification", riskLevel: "Medium", status: "Approved", assessorName: "Sam Porter", assessmentDate: "2026-02-10", approvalDate: "2026-02-10", expiryDate: "2027-02-10", notes: "Heavy-metal leach certs reviewed." },
  { supplierName: "ClearPack Solutions", qualificationType: "Initial Qualification", riskLevel: "Medium", status: "Approved", assessorName: "Sam Porter", assessmentDate: "2026-02-12", approvalDate: "2026-02-12", expiryDate: "2027-02-12", notes: "Food-contact compliance docs on file." },
  { supplierName: "GreenLeaf Analytics", qualificationType: "Initial Qualification", riskLevel: "Low", status: "Approved", assessorName: "Quinn Rivera", assessmentDate: "2026-01-20", approvalDate: "2026-01-20", expiryDate: "2027-01-20", notes: "ISO 17025 scope verified." },
  { supplierName: "Sweet Source Foods", qualificationType: "Initial Qualification", riskLevel: "Medium", status: "Approved", assessorName: "Quinn Rivera", assessmentDate: "2026-02-05", approvalDate: "2026-02-05", expiryDate: "2027-02-05", notes: "FDA registration + allergen statement on file." },
  { supplierName: "Terpene Source Labs", qualificationType: "Initial Qualification", riskLevel: "Medium", status: "Approved", assessorName: "Quinn Rivera", assessmentDate: "2026-02-20", approvalDate: "2026-02-20", expiryDate: "2027-02-20", notes: "Food-grade terpene COA + GRAS documentation on file." },
  { supplierName: "RollRight Pre-Roll Supply", qualificationType: "Initial Qualification", riskLevel: "Medium", status: "Approved", assessorName: "Sam Porter", assessmentDate: "2026-02-22", approvalDate: "2026-02-22", expiryDate: "2027-02-22", notes: "Cannabis-contact material certs reviewed." },
  { supplierName: "Unverified Terpene Imports", qualificationType: "For-Cause Review", riskLevel: "High", status: "In Progress", assessorName: "Quentin Lake", assessmentDate: "2026-06-15", approvalDate: null, expiryDate: null, notes: "INTENTIONAL: open review for the unapproved vendor; remains non-qualified until complete." },
];

// Mirrors the v2 "Inventory" + "Lots" sheets. Each catalog item carries one or
// more on-hand lots. Blue Dream / Northern Lights / Distillate use the
// first-class LOT-2026-#### numbers from the Lots sheet (for split / merge /
// ship practice); the rest use their vendor lot numbers.
interface SeedLot { lotNumber: string; quantity: number; origin: string; }
interface SeedInventory {
  itemName: string; itemType: string; supplierName: string | null;
  unitOfMeasure: string; reorderPoint: number; reorderQuantity: number;
  isCannabis: boolean; notes: string; lots: SeedLot[];
}

const SAMPLE_INVENTORY: SeedInventory[] = [
  { itemName: "Blue Dream Flower", itemType: "Cannabis Flower", supplierName: "Green Valley Cultivation LLC", unitOfMeasure: "g", reorderPoint: 500, reorderQuantity: 2000, isCannabis: true, notes: "Vape/edible feedstock; flower for batch reference.", lots: [{ lotNumber: "LOT-2026-0001", quantity: 5000, origin: "received" }] },
  { itemName: "THC Distillate", itemType: "Cannabis Extract", supplierName: "PureExtract Processors LLC", unitOfMeasure: "g", reorderPoint: 200, reorderQuantity: 1000, isCannabis: true, notes: "84% THC; used in gummies + vapes. Seeded as two lots for merge practice.", lots: [{ lotNumber: "LOT-2026-0003", quantity: 500, origin: "received" }, { lotNumber: "LOT-2026-0004", quantity: 300, origin: "received" }] },
  { itemName: "CCELL TH2 Cartridge (0.5g)", itemType: "Packaging Material", supplierName: "VapeTech Hardware Supply", unitOfMeasure: "units", reorderPoint: 250, reorderQuantity: 1000, isCannabis: false, notes: "Vape hardware.", lots: [{ lotNumber: "VT-TH2-118", quantity: 2000, origin: "received" }] },
  { itemName: "Mylar Pouch (child-resist)", itemType: "Packaging Material", supplierName: "ClearPack Solutions", unitOfMeasure: "units", reorderPoint: 300, reorderQuantity: 1000, isCannabis: false, notes: "Gummy pouches.", lots: [{ lotNumber: "CP-MYL-441", quantity: 2000, origin: "received" }] },
  { itemName: "Cartridge Box", itemType: "Packaging Material", supplierName: "ClearPack Solutions", unitOfMeasure: "units", reorderPoint: 300, reorderQuantity: 1000, isCannabis: false, notes: "Vape cartons.", lots: [{ lotNumber: "CP-BOX-442", quantity: 2000, origin: "received" }] },
  { itemName: "Cane Sugar", itemType: "Excipient", supplierName: "Sweet Source Foods", unitOfMeasure: "g", reorderPoint: 5000, reorderQuantity: 20000, isCannabis: false, notes: "Edible base.", lots: [{ lotNumber: "SS-SUG-077", quantity: 25000, origin: "received" }] },
  { itemName: "Pectin", itemType: "Excipient", supplierName: "Sweet Source Foods", unitOfMeasure: "g", reorderPoint: 1000, reorderQuantity: 5000, isCannabis: false, notes: "Gelling agent.", lots: [{ lotNumber: "SS-PEC-078", quantity: 5000, origin: "received" }] },
  { itemName: "Blue Razz Flavor", itemType: "Terpene", supplierName: "Sweet Source Foods", unitOfMeasure: "mL", reorderPoint: 250, reorderQuantity: 1000, isCannabis: false, notes: "Flavoring.", lots: [{ lotNumber: "SS-FLV-079", quantity: 2000, origin: "received" }] },
  { itemName: "Northern Lights Flower", itemType: "Cannabis Flower", supplierName: "Green Valley Cultivation LLC", unitOfMeasure: "g", reorderPoint: 500, reorderQuantity: 2000, isCannabis: true, notes: "Pre-roll feedstock.", lots: [{ lotNumber: "LOT-2026-0002", quantity: 3000, origin: "received" }] },
  { itemName: "Gummy Pouch Label", itemType: "Label", supplierName: "ClearPack Solutions", unitOfMeasure: "units", reorderPoint: 300, reorderQuantity: 1000, isCannabis: false, notes: "Label item-type test.", lots: [{ lotNumber: "CP-LBL-450", quantity: 2000, origin: "received" }] },
  { itemName: "Cartridge Label", itemType: "Label", supplierName: "ClearPack Solutions", unitOfMeasure: "units", reorderPoint: 300, reorderQuantity: 1000, isCannabis: false, notes: "Label item-type test.", lots: [{ lotNumber: "CP-LBL-451", quantity: 2000, origin: "received" }] },
  { itemName: "Botanical Terpenes (Blue Dream)", itemType: "Terpene", supplierName: "Terpene Source Labs", unitOfMeasure: "mL", reorderPoint: 200, reorderQuantity: 1000, isCannabis: false, notes: "Vape formulation (5%).", lots: [{ lotNumber: "TS-TERP-310", quantity: 1000, origin: "received" }] },
  { itemName: "Pre-Roll Cone (0.5 g)", itemType: "Packaging Material", supplierName: "RollRight Pre-Roll Supply", unitOfMeasure: "units", reorderPoint: 200, reorderQuantity: 1000, isCannabis: false, notes: "Pre-roll component.", lots: [{ lotNumber: "RR-CONE-512", quantity: 1000, origin: "received" }] },
  { itemName: "Filter Tip", itemType: "Packaging Material", supplierName: "RollRight Pre-Roll Supply", unitOfMeasure: "units", reorderPoint: 200, reorderQuantity: 1000, isCannabis: false, notes: "Pre-roll component.", lots: [{ lotNumber: "RR-TIP-513", quantity: 1000, origin: "received" }] },
];

// Admin-only one-shot reset for the deployed sandbox. Wipes all transactional
// data (KEEPS users / recipes / label_templates / label_static_blocks) and
// re-seeds the 6 starter recipes idempotently. Caller must:
//   - be authenticated AND have role=Admin
//   - send { confirm: "yes-wipe-sandbox" } in the body
// Designed to be runnable against the production database from inside the
// deployed app, since dev-side scripts cannot reach the prod DB.
router.post("/admin/sandbox-reset", async (req: Request, res: Response) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: "Admin role required" }); return; }
    const { confirm, alsoWipeRecipes, seedSampleData } = (req.body ?? {}) as { confirm?: string; alsoWipeRecipes?: boolean; seedSampleData?: boolean };
    if (confirm !== "yes-wipe-sandbox") {
      res.status(400).json({ error: 'Body must include { "confirm": "yes-wipe-sandbox" }' });
      return;
    }

    const summary: { truncated: string[]; recipesCreated: number; recipesSkipped: number; recipesWiped: boolean; sampleSuppliers: number; sampleQuals: number; sampleInventory: number; sampleLots: number } = {
      truncated: [],
      recipesCreated: 0,
      recipesSkipped: 0,
      recipesWiped: !!alsoWipeRecipes,
      sampleSuppliers: 0,
      sampleQuals: 0,
      sampleInventory: 0,
      sampleLots: 0,
    };

    // All-or-nothing: probe → truncate → (optional recipe wipe) → seed → audit
    // ride a single transaction so a mid-seed failure rolls the wipe back.
    await db.transaction(async (tx) => {
      // TABLES_TO_TRUNCATE is a hard-coded allowlist (no user input), so
      // inlining the literals is injection-safe AND avoids Drizzle's array
      // parameter binding (which Postgres rejects as `ANY((row))`).
      const inList = TABLES_TO_TRUNCATE.map((t) => `'${t}'`).join(", ");
      const probe = await tx.execute(sql.raw(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN (${inList})`
      ));
      const present = (probe.rows as Array<{ table_name: string }>).map((r) => r.table_name);

      if (present.length > 0) {
        // TRUNCATE doesn't accept parameters, but `present` is filtered by the
        // information_schema lookup above against a constant allowlist, so
        // identifier interpolation here is injection-safe.
        const stmt = `TRUNCATE TABLE ${present.join(", ")} RESTART IDENTITY CASCADE`;
        await tx.execute(sql.raw(stmt));
        summary.truncated = present;
      }

      if (alsoWipeRecipes) {
        await tx.execute(sql`TRUNCATE TABLE recipe_items, recipes RESTART IDENTITY CASCADE`);
      }

      for (const r of RECIPES) {
        const [existing] = await tx.select({ id: recipesTable.id }).from(recipesTable).where(eq(recipesTable.productName, r.productName)).limit(1);
        if (existing) { summary.recipesSkipped++; continue; }
        const [ins] = await tx.insert(recipesTable).values({
          productType: r.productType,
          productName: r.productName,
          notes: r.notes,
        }).returning({ id: recipesTable.id });
        if (!ins) continue;
        for (let i = 0; i < r.items.length; i++) {
          const it = r.items[i];
          if (!it) continue;
          await tx.insert(recipeItemsTable).values({
            recipeId: ins.id,
            ingredientName: it.ingredientName,
            plannedQuantity: it.plannedQuantity,
            unitOfMeasure: it.unitOfMeasure,
            kind: it.kind,
            notes: it.notes ?? null,
            sortOrder: i,
          });
        }
        summary.recipesCreated++;
      }

      // Optional: rebuild fresh sample data under the unified lot-ledger model.
      // Runs inside the same txn so a failure rolls the whole reset back. The
      // transactional tables were just truncated (RESTART IDENTITY), so these
      // inserts start from a clean slate — no idempotency guard needed.
      if (seedSampleData) {
        const supplierIdByName = new Map<string, number>();
        for (const s of SAMPLE_SUPPLIERS) {
          const [ins] = await tx.insert(suppliersTable).values({
            supplierName: s.supplierName,
            contactPerson: s.contactPerson,
            email: s.email,
            phone: s.phone,
            licenseNumber: s.licenseNumber,
            supplierType: s.supplierType,
            status: s.status,
            riskTier: s.riskTier,
            riskTierRationale: s.riskTierRationale,
            riskTierSetAt: new Date(),
            riskTierSetByName: actor.fullName,
            notes: s.notes,
          }).returning({ id: suppliersTable.id });
          if (ins) { supplierIdByName.set(s.supplierName, ins.id); summary.sampleSuppliers++; }
        }

        // Qualification records — what clears a supplier off "Never Qualified"
        // and drives its re-qualification review state + risk score.
        let qualSeq = 0;
        for (const q of SAMPLE_QUALS) {
          const supplierId = supplierIdByName.get(q.supplierName);
          if (!supplierId) continue;
          qualSeq++;
          const qualNumber = `SQ-2026-${String(qualSeq).padStart(4, "0")}`;
          await tx.insert(supplierQualificationsTable).values({
            supplierId,
            qualNumber,
            qualificationType: q.qualificationType,
            riskLevel: q.riskLevel,
            status: q.status,
            assessorName: q.assessorName,
            assessmentDate: q.assessmentDate,
            approvalDate: q.approvalDate,
            expiryDate: q.expiryDate,
            approvedByName: q.status === "Approved" ? q.assessorName : null,
            notes: q.notes,
            createdByName: actor.fullName,
          });
          summary.sampleQuals++;
        }

        for (const it of SAMPLE_INVENTORY) {
          const supplierId = it.supplierName ? supplierIdByName.get(it.supplierName) ?? null : null;
          const totalQty = it.lots.reduce((sum, l) => sum + l.quantity, 0);
          // Catalog row carries the reorder thresholds + supplier link.
          const [inv] = await tx.insert(inventoryItemsTable).values({
            itemName: it.itemName,
            itemType: it.itemType,
            supplierId,
            lotNumber: it.lots[0]?.lotNumber ?? null,
            quantity: totalQty,
            unitOfMeasure: it.unitOfMeasure,
            reorderPoint: it.reorderPoint,
            reorderQuantity: it.reorderQuantity,
            notes: it.notes,
          }).returning({ id: inventoryItemsTable.id });
          if (!inv) continue;
          summary.sampleInventory++;

          // One or more linked on-hand lots — the live quantity the Inventory
          // screen reads. Items with multiple lots (e.g. distillate split into
          // two) seed each separately so split/merge ops have real fixtures.
          for (const l of it.lots) {
            const [lot] = await tx.insert(lotsTable).values({
              lotNumber: l.lotNumber,
              itemName: it.itemName,
              itemType: it.itemType,
              unitOfMeasure: it.unitOfMeasure,
              originalQuantity: l.quantity,
              currentQuantity: l.quantity,
              origin: l.origin,
              status: "Active",
              isCannabis: it.isCannabis,
              supplierId,
              inventoryItemId: inv.id,
              notes: it.notes,
              createdBy: actor.id,
              createdByName: actor.fullName,
            }).returning({ id: lotsTable.id });
            if (!lot) continue;
            summary.sampleLots++;

            await tx.insert(lotEventsTable).values({
              lotId: lot.id,
              eventType: "create",
              quantityDelta: l.quantity,
              resultingQuantity: l.quantity,
              reason: "Lot created (sample reseed)",
              performedBy: actor.id,
              performedByName: actor.fullName,
            });
          }
        }
      }

      // Re-seed a single immutable evidence row INTO the freshly wiped audit_log
      // so there is always a record of who triggered the reset (Part-11 trail
      // for the destructive event itself, after the rest of the log is gone).
      await tx.insert(auditLogTable).values({
        tableName: "system",
        rowId: 0,
        operation: "SANDBOX_RESET",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: null,
        afterState: { summary, requestedBy: actor.fullName, at: new Date().toISOString() },
      });
    });

    req.log.warn({ actorId: actor.id, summary }, "Sandbox reset executed");
    res.json({ ok: true, ...summary });
  } catch (err) {
    req.log.error({ err }, "Sandbox reset failed");
    res.status(500).json({ error: "Sandbox reset failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Starter document library (Admin only) ────────────────────────────────────
//
// Loads the 15 generic, pre-approved controlled documents (13 SOPs + Quality
// Manual + Quality Policy) so a new facility opens with a working QMS. Idempotent
// — re-running skips titles already present as starter defaults. The set is
// flagged is_starter_default so it can be removed if the facility brings its own.
router.post("/admin/seed-starter-documents", async (req: Request, res: Response) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: "Admin role required" }); return; }
    const result = await seedStarterDocuments({ id: actor.id, fullName: actor.fullName });
    req.log.info({ actorId: actor.id, created: result.created.length, skipped: result.skipped.length }, "Seeded starter documents");
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to seed starter documents");
    res.status(500).json({ error: "Failed to seed starter documents", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Removes the starter set. Body: { confirm: "yes-remove-starter", purge?: boolean }.
// Only untouched starter docs (still Approved rev A) are affected; ones a facility
// has begun revising are left alone. Default marks them Obsolete (retained for
// history); purge:true hard-deletes them for a clean slate.
router.post("/admin/remove-starter-documents", async (req: Request, res: Response) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: "Admin role required" }); return; }
    const { confirm, purge } = (req.body ?? {}) as { confirm?: string; purge?: boolean };
    if (confirm !== "yes-remove-starter") {
      res.status(400).json({ error: 'Body must include { "confirm": "yes-remove-starter" }' });
      return;
    }
    const result = await removeStarterDocuments({ id: actor.id, fullName: actor.fullName }, { purge: !!purge });
    req.log.warn({ actorId: actor.id, removed: result.removed.length, skipped: result.skipped.length, purge: !!purge }, "Removed starter documents");
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to remove starter documents");
    res.status(500).json({ error: "Failed to remove starter documents", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Starter inventory catalog (Admin only) ───────────────────────────────────
//
// Loads common non-cannabis items each segment stocks (edible ingredients,
// vape/pre-roll hardware, cultivation inputs) so a new facility's item list
// isn't empty on day one. Idempotent — re-running skips items already present as
// starter defaults. Flagged is_starter_default so the set can be removed.
router.post("/admin/seed-starter-inventory", async (req: Request, res: Response) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: "Admin role required" }); return; }
    const result = await seedStarterInventory({ id: actor.id, fullName: actor.fullName });
    req.log.info({ actorId: actor.id, created: result.created.length, skipped: result.skipped.length }, "Seeded starter inventory");
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to seed starter inventory");
    res.status(500).json({ error: "Failed to seed starter inventory", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Removes the starter inventory set. Body: { confirm: "yes-remove-starter-inventory" }.
// Only untouched starter items (no stock, reorder point, or supplier) are deleted.
router.post("/admin/remove-starter-inventory", async (req: Request, res: Response) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "Admin") { res.status(403).json({ error: "Admin role required" }); return; }
    const { confirm } = (req.body ?? {}) as { confirm?: string };
    if (confirm !== "yes-remove-starter-inventory") {
      res.status(400).json({ error: 'Body must include { "confirm": "yes-remove-starter-inventory" }' });
      return;
    }
    const result = await removeStarterInventory({ id: actor.id, fullName: actor.fullName });
    req.log.warn({ actorId: actor.id, removed: result.removed.length, skipped: result.skipped.length }, "Removed starter inventory");
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to remove starter inventory");
    res.status(500).json({ error: "Failed to remove starter inventory", detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
