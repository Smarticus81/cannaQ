import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface RecipeItem {
  ingredientName: string;
  plannedQuantity: number;
  unitOfMeasure: string;
  kind: "Ingredient" | "Material";
  notes?: string;
}

interface Recipe {
  productType: string;
  productName: string;
  notes: string;
  items: RecipeItem[];
}

const RECIPES: Recipe[] = [
  {
    productType: "Edible",
    productName: "Chocolate Chip Cookies — 100ct (10mg THC each)",
    notes: "Standard 100-count batch. Cannabutter swap for unsalted butter. Target dose: 10 mg THC / cookie.",
    items: [
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
    ],
  },
  {
    productType: "Edible",
    productName: "Chocolate Brownies — 100ct (10mg THC each)",
    notes: "Cut into 100 squares from full sheet pan. Cannabutter swap for butter.",
    items: [
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
    ],
  },
  {
    productType: "Edible",
    productName: "Rice Crispy Squares — 100ct (10mg THC each)",
    notes: "Cannabutter swap for butter. ~12g per square.",
    items: [
      { ingredientName: "Cannabutter (infused, ~75 mg THC/g)", plannedQuantity: 454, unitOfMeasure: "g", kind: "Ingredient" },
      { ingredientName: "Mini marshmallows", plannedQuantity: 1360, unitOfMeasure: "g", kind: "Ingredient" },
      { ingredientName: "Crisp rice cereal", plannedQuantity: 900, unitOfMeasure: "g", kind: "Ingredient" },
      { ingredientName: "Vanilla extract", plannedQuantity: 10, unitOfMeasure: "mL", kind: "Ingredient" },
      { ingredientName: "Salt (fine)", plannedQuantity: 4, unitOfMeasure: "g", kind: "Ingredient" },
      { ingredientName: "Child-resistant 100ct edible pouch", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
      { ingredientName: "Compliance label (Edible MI)", plannedQuantity: 1, unitOfMeasure: "ea", kind: "Material" },
    ],
  },
  {
    productType: "Vape Cartridge",
    productName: "Vape Cartridges — 1g (100ct batch)",
    notes: "100 carts × 1g distillate + terpene blend.",
    items: [
      { ingredientName: "Cannabis Distillate", plannedQuantity: 95, unitOfMeasure: "g", kind: "Ingredient", notes: "95% w/w of fill" },
      { ingredientName: "Cannabis-derived Terpenes", plannedQuantity: 5, unitOfMeasure: "g", kind: "Ingredient", notes: "5% w/w terpene blend" },
      { ingredientName: "510 Vape Cartridge (1g, ceramic core)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
      { ingredientName: "Vape Mouthpiece", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
      { ingredientName: "Compliance label (Vape MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    ],
  },
  {
    productType: "Pre-Roll",
    productName: "Raw Pre-Rolls — 1g (100ct batch)",
    notes: "Ground flower only, no infusion.",
    items: [
      { ingredientName: "Cannabis Flower (ground)", plannedQuantity: 100, unitOfMeasure: "g", kind: "Ingredient", notes: "1g per cone" },
      { ingredientName: "Pre-Roll Cone (King-size, refined white)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
      { ingredientName: "Compliance label (Pre-Roll MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    ],
  },
  {
    productType: "Infused Pre-Roll",
    productName: "Infused Pre-Rolls — 1.5g (100ct batch)",
    notes: "Flower core + distillate coat + THCa kief outer. MI classifies as a concentrate for testing/labeling (bulletin 9/19/2022).",
    items: [
      { ingredientName: "Cannabis Flower (ground)", plannedQuantity: 100, unitOfMeasure: "g", kind: "Ingredient", notes: "1g flower core per cone" },
      { ingredientName: "Cannabis Distillate", plannedQuantity: 30, unitOfMeasure: "g", kind: "Ingredient", notes: "0.3g distillate coat per cone" },
      { ingredientName: "THCa Diamonds / Kief", plannedQuantity: 20, unitOfMeasure: "g", kind: "Ingredient", notes: "0.2g outer dust per cone" },
      { ingredientName: "Pre-Roll Cone (King-size, refined white)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
      { ingredientName: "Compliance label (Pre-Roll MI)", plannedQuantity: 100, unitOfMeasure: "ea", kind: "Material" },
    ],
  },
];

async function run() {
  const client = await pool.connect();
  try {
    console.log("\n🌱 Seeding recipes (idempotent)…\n");
    let created = 0;
    let skipped = 0;
    for (const r of RECIPES) {
      const existing = await client.query(`SELECT id FROM recipes WHERE product_name = $1 LIMIT 1`, [r.productName]);
      if (existing.rowCount && existing.rowCount > 0) {
        console.log(`  • SKIP "${r.productName}" — already exists (id ${existing.rows[0].id})`);
        skipped++;
        continue;
      }
      const ins = await client.query(
        `INSERT INTO recipes (product_type, product_name, notes) VALUES ($1, $2, $3) RETURNING id`,
        [r.productType, r.productName, r.notes],
      );
      const recipeId = ins.rows[0].id;
      for (let i = 0; i < r.items.length; i++) {
        const item = r.items[i];
        await client.query(
          `INSERT INTO recipe_items (recipe_id, ingredient_name, planned_quantity, unit_of_measure, kind, notes, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [recipeId, item.ingredientName, item.plannedQuantity, item.unitOfMeasure, item.kind, item.notes ?? null, i],
        );
      }
      console.log(`  ✓ CREATE "${r.productName}" (${r.items.length} items)`);
      created++;
    }
    console.log(`\n→ ${created} created, ${skipped} skipped.\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
