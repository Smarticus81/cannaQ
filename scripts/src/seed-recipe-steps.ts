import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Populates the "Raw Pre-Rolls" recipe with a generic, non-infused process-step
// set so the WI→batch chain runs end-to-end (linking WI-SEED-0005 to a batch now
// seeds the interactive Process Steps tab — see Session 100 "option a").
// {tokens} are blanks the operator fills + e-signs at run time on the batch.
// GENERIC content — tune to real SOP before production use.
async function run() {
  const client = await pool.connect();
  try {
    console.log("🌱 Populating Raw Pre-Rolls recipe process steps…\n");

    const rec = await client.query(
      `SELECT id, product_name FROM recipes WHERE product_name ILIKE 'Raw Pre-Rolls%' ORDER BY id LIMIT 1`
    );
    if (rec.rowCount === 0) { throw new Error("No 'Raw Pre-Rolls' recipe found."); }
    const recipeId = rec.rows[0].id as number;
    console.log(`→ Recipe #${recipeId} — ${rec.rows[0].product_name}`);

    // Retype the compliance label from Material → Packaging (belongs on the
    // Packaging tab, not Materials). Bonus fix for feedback item.
    const relabel = await client.query(
      `UPDATE recipe_items SET kind='Packaging'
       WHERE recipe_id=$1 AND kind='Material' AND ingredient_name ILIKE '%label%'`,
      [recipeId]
    );
    console.log(`   ✓ Retyped ${relabel.rowCount} label item(s) Material → Packaging`);

    // Idempotent: clear existing steps for this recipe, then insert the canonical set.
    await client.query(`DELETE FROM recipe_process_steps WHERE recipe_id=$1`, [recipeId]);

    const steps: Array<{ description: string; template: string; instructions?: string }> = [
      {
        description: "Line clearance & sanitation",
        template: "{operator} verified the production area, scale, and tools are clean and sanitized, and appropriate PPE is worn, before starting.",
        instructions: "No product from a prior batch may remain in the area. Record any equipment IDs used.",
      },
      {
        description: "Weigh flower",
        template: "{operator} weighed {flower_weight} g of ground cannabis flower for the batch using scale {scale_id}.",
        instructions: "Confirm the flower lot is Active and pulled from inventory (Ingredients tab).",
      },
      {
        description: "Grind & sift",
        template: "Ground the flower to consistency and sifted through a {screen_size} mm screen; removed any contaminants.",
      },
      {
        description: "Fill cones",
        template: "Loaded cones into the knockbox and filled {cone_count} cones ({cone_size}).",
        instructions: "Cover the tray when not in use. Cones are on the Materials tab.",
      },
      {
        description: "Tamp to density",
        template: "Tamped each pre-roll to consistent density; checked bounce/fill level. Target fill weight {fill_weight} g.",
        instructions: "Do not over-pack — over-packing causes improper draw.",
      },
      {
        description: "Crown / close",
        template: "Brushed excess material from the filter tip and used the crowning tool to close each pre-roll.",
      },
      {
        description: "In-process visual inspection",
        template: "{operator} inspected fill level and closure on each pre-roll; segregated any that did not meet internal spec ({reject_count} rejected).",
      },
      {
        description: "Package & label",
        template: "Placed pre-rolls into {tube_count} tubes and applied the compliance label to each final package.",
        instructions: "Tubes + label are on the Packaging tab. Verify label matches test results before applying.",
      },
      {
        description: "Sample for testing & QA hold",
        template: "Pulled a representative sample for compliance testing, recorded its Metrc tag {sample_metrc_tag}, and placed the lot on QA hold pending passing results.",
        instructions: "Capturing the sample's Metrc tag is what lets the system pull lab results back from Metrc.",
      },
    ];

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await client.query(
        `INSERT INTO recipe_process_steps (recipe_id, step_number, description, template, instructions, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [recipeId, i + 1, s.description, s.template, s.instructions ?? null, i]
      );
    }
    console.log(`   ✓ Inserted ${steps.length} process steps`);

    console.log("\n✅ Done. Link WI-SEED-0005 to a new Raw Pre-Roll batch — the Process Steps tab");
    console.log("   will now populate with these steps for the operator to fill + e-sign.");
  } catch (err) {
    console.error("❌ Failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(() => process.exit(1));
