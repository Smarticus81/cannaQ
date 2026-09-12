import { db } from "@workspace/db";
import { recipesTable, recipeProcessStepsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// Session 59.2 / 59.3 — seed four generic edible recipes (Jonathan's, 2026-06-05)
// with their procedure steps as fill-in-the-blank templates, so the FDA
// process-step + baker e-signature flow is demoable without hand-entering data.
// Session 60 (2026-06-07) — added two concentrate processes (Crude Extraction,
// Distillate) mirroring the SOP/WI drafts, including METRC form-change tag
// capture as e-signed steps.
//
// Convention (per Jonathan, 2026-06-05): values FIXED by the facility procedure
// (oven temperature) are written directly into the sentence — they are not
// blanks. Only values the operator records at run time stay as {blanks}: the
// ACTUAL bake {time} (which lives within an SOP +/- tolerance, so it must be
// entered, not assumed) and {baker} (auto-fills from the signer). The SOP target
// time is shown in parentheses as the reference the actual is checked against.
//
// Idempotent: a recipe is only seeded if one with the same productName doesn't
// already exist, so this is safe on every boot. Deleting a demo recipe lets it
// re-seed on the next deploy — remove this seeder (and its index.ts call) when
// the demo data is no longer wanted.
const DEMO_RECIPES: Array<{
  productName: string;
  productType: string;
  steps: Array<{ description: string; template: string }>;
}> = [
  {
    productName: "Chocolate Chip Cookies",
    productType: "Edible",
    steps: [
      { description: "Preheat & gather", template: "Gather all ingredients and preheat the oven to 375 degrees F (190 degrees C)." },
      { description: "Combine dry ingredients", template: "Combine flour, baking soda and salt in a small bowl." },
      { description: "Cream butter & sugars", template: "Beat butter, white sugar, brown sugar and vanilla in a large mixing bowl until creamy." },
      { description: "Add eggs", template: "Add eggs one at a time, beating well after each addition." },
      { description: "Add flour & morsels", template: "Gradually beat in the flour mixture, then stir in the chocolate morsels and nuts." },
      { description: "Portion onto sheets", template: "{baker} dropped rounded tablespoons of dough onto ungreased baking sheets." },
      { description: "Bake", template: "Bake at 375 degrees F until golden brown for {time} minutes (SOP target 9-11 min), switching racks halfway through." },
      { description: "Cool", template: "Cool on the baking sheets for 2 minutes, then transfer to wire racks to cool completely." },
    ],
  },
  {
    productName: "Rice Crispy Squares",
    productType: "Edible",
    steps: [
      { description: "Melt butter", template: "Melt butter in a large saucepan over low heat." },
      { description: "Melt marshmallows", template: "Add marshmallows and stir until completely melted, then remove from heat." },
      { description: "Prep cereal", template: "Measure all of the cereal and have it ready in a large bowl." },
      { description: "Coat cereal", template: "Working quickly, {baker} added the rice krispies cereal and stirred until the cereal was well coated." },
      { description: "Press into pan", template: "Using a buttered spatula or waxed paper, press the mixture evenly into a greased 13 x 9 x 2 inch pan." },
      { description: "Cool & cut", template: "When the treats are cooled, cut into squares." },
    ],
  },
  {
    productName: "Chocolate Brownies",
    productType: "Edible",
    steps: [
      { description: "Preheat", template: "Preheat the oven to 350 degrees F." },
      { description: "Wet ingredients", template: "Mix sugar and oil, then add eggs one at a time (mixing well after each) and add the vanilla. (1 cup oil, 2 cups granulated sugar, 4 large eggs, 1 Tbsp vanilla extract)" },
      { description: "Dry ingredients", template: "Add the cocoa powder, salt and flour and stir until combined. (6 Tbsp unsweetened cocoa, 1 tsp kosher salt, 1 1/2 cups all-purpose flour)" },
      { description: "Bake", template: "{baker} poured the batter into a greased 9x13 inch pan and baked at 350 degrees F for {time} minutes (SOP target 30 min), until a toothpick inserted in the center came out clean." },
      { description: "Cool", template: "Cool completely." },
    ],
  },
  {
    productName: "Peanut Butter Cookies",
    productType: "Edible",
    steps: [
      { description: "Preheat", template: "Preheat the oven to 350 degrees F (175 degrees C)." },
      { description: "Mix", template: "Mix the peanut butter, sugar and egg in a large bowl until well blended." },
      { description: "Form", template: "{baker} rolled the dough into 24 balls, placed them 4 inches apart on ungreased baking sheets, and flattened each with the back of a fork." },
      { description: "Bake", template: "Bake at 350 degrees F until the edges are lightly browned for {time} minutes (SOP target 10-12 min); do not overbake, then cool on the baking sheets for 5 minutes and transfer to wire racks." },
    ],
  },
  // Session 60 — concentrate processes (Jonathan, 2026-06-07). These mirror the
  // SOP/WI drafts (SOP-CRUDE-001 / WI-EXTRACT-CRUDE-001 and SOP-DISTILLATE-001 /
  // WI-DISTILL-001). Created as Concentrate recipes; spin a batch with
  // process_type "Inhalants". Company-specific setpoints stay as {blanks} the
  // operator records at run time (generic template — no fixed facility value to
  // bake in yet). {baker} auto-fills from the e-signature, so it captures the
  // acting operator. METRC tag transitions are captured as e-signed steps: every
  // change of form decrements the source package and records a NEW source-linked
  // tag (metrc1 flower -> metrc2 crude -> metrc3 distillate).
  {
    productName: "Crude Extraction (BHO / CO2 / Ethanol)",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, PPE is on, and the two-person rule is met before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the scale, vacuum gauge, and temperature probes are calibrated and in date, and leak-checked the closed-loop rig." },
      { description: "Input biomass (metrc1)", template: "{baker} selected released/staged biomass package {source_tag} (metrc1), weighed {input_weight} g, and recorded it as the batch input. (Fresh-frozen inputs: confirm cold chain held.)" },
      { description: "Extraction", template: "{baker} ran extraction with solvent {solvent_type} (lot {solvent_lot}) at temperature {extract_temp} and pressure {extract_pressure} for {extract_time}, per the SOP solvent:biomass ratio." },
      { description: "Solvent recovery", template: "{baker} recovered solvent at the recorded parameters and segregated recovered solvent per facility policy." },
      { description: "Form change - new METRC tag (metrc2)", template: "{baker} decremented biomass package {source_tag} by mass consumed and created the crude package {crude_tag} (metrc2), source-linked, crude yield {crude_yield} g; the container was labeled with the new tag. (No prior tag may carry forward through a form change.)" },
      { description: "Spent biomass disposition", template: "{baker} routed spent biomass to destruction (WI-DESTRUCTION-001, R 420.211) and recorded the waste." },
      { description: "Crude disposition", template: "{baker} set the crude lot to Quarantine and recorded the storage location/conditions pending downstream routing to a concentrate branch." },
    ],
  },
  {
    productName: "Distillate Production",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, and PPE is on before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the scale, vacuum gauge, and temperature probes are calibrated and in date, and leak-checked the distillation rig." },
      { description: "Input crude (metrc2)", template: "{baker} selected released/staged crude package {crude_tag} (metrc2), weighed {crude_input} g, and recorded it as the batch input." },
      { description: "Winterization & filtration", template: "{baker} dissolved crude in ethanol, held it at {winter_temp} for {winter_time}, and filtered out precipitated fats/waxes. (Refines the same crude package - no form change, no new tag. Mark N/A if not required for this crude.)" },
      { description: "Solvent recovery", template: "{baker} recovered ethanol via evaporator at the recorded parameters and segregated recovered solvent per facility policy." },
      { description: "Decarboxylation", template: "{baker} heated the cleaned crude to {decarb_temp} for {decarb_time} until CO2 evolution stopped, recording the endpoint." },
      { description: "Distillation - first pass", template: "{baker} ran the first pass at vacuum {pass1_vacuum} and vapor temperature {pass1_vapor_temp}, stripping residual terpenes/lights; cut points and fraction weight {pass1_weight} g recorded." },
      { description: "Distillation - main body", template: "{baker} collected the main-body cannabinoid fraction at vacuum {pass2_vacuum} and vapor temperature {pass2_vapor_temp}; main-body weight {main_body_weight} g recorded." },
      { description: "Form change - new METRC tag (metrc3)", template: "{baker} decremented crude package {crude_tag} by mass consumed and created the distillate package {distillate_tag} (metrc3), source-linked; the container was labeled with the new tag. (No prior tag may carry forward through a form change.)" },
      { description: "Quarantine & testing", template: "{baker} set the distillate lot to Quarantine (R 420.303a) and submitted samples for residual solvent, potency, contaminants, and Vitamin E Acetate / cutting-agent screen if vape-bound (R 420.305)." },
      { description: "Disposition", template: "On COA pass, {baker} promoted the lot to a potency-bearing ingredient or released it as a finished good; on fail, {baker} raised a nonconformance and routed the lot to destruction." },
    ],
  },
  // Session 60 (cont.) — the four post-processing branches off crude/extract
  // (metrc2). Each is its own form change and gets a NEW source-linked METRC tag.
  // "Badder/Budder" here is the WHIPPED hydrocarbon concentrate, not kitchen
  // cannabutter (that is a separate Edible recipe). All four are solvent-based, so
  // residual-solvent testing is mandatory before release.
  {
    productName: "Badder / Budder (Whipped Concentrate)",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, and PPE is on before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the vacuum oven, scale, and temperature probes are calibrated and in date." },
      { description: "Input extract (metrc2)", template: "{baker} selected released/staged crude/BHO extract package {source_tag} (metrc2) and weighed {input_weight} g as the batch input." },
      { description: "Initial purge", template: "{baker} purged the extract under vacuum at {purge_temp} for {purge_time} to begin removing residual solvent." },
      { description: "Whip", template: "{baker} whipped the extract for {whip_time} at {whip_temp} to incorporate air and develop the creamy badder/budder consistency." },
      { description: "Final purge", template: "{baker} completed the final vacuum purge at {final_purge_temp} for {final_purge_time} to bring residual solvent within limits." },
      { description: "Form change - new METRC tag", template: "{baker} decremented extract package {source_tag} by mass consumed and created the badder package {product_tag}, source-linked, output weight {output_weight} g; the container was labeled with the new tag." },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) and submitted samples for residual solvent (PASS required), potency, and contaminants." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good or promoted it to an ingredient; on fail, {baker} raised a nonconformance and routed the lot to destruction." },
    ],
  },
  {
    productName: "Shatter",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, and PPE is on before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the vacuum oven, scale, and temperature probes are calibrated and in date." },
      { description: "Input extract (metrc2)", template: "{baker} selected released/staged crude/BHO extract package {source_tag} (metrc2) and weighed {input_weight} g as the batch input." },
      { description: "Thin-film pour", template: "{baker} poured the extract into a thin, even layer on parchment/PTFE to enable an undisturbed purge." },
      { description: "Undisturbed vacuum purge", template: "{baker} purged the extract undisturbed under vacuum at {purge_temp} for {purge_time}, allowing it to stabilize into a glass-like sheet; the slab was not agitated (agitation would turn it to badder)." },
      { description: "Form change - new METRC tag", template: "{baker} decremented extract package {source_tag} by mass consumed and created the shatter package {product_tag}, source-linked, output weight {output_weight} g; the container was labeled with the new tag." },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) and submitted samples for residual solvent (PASS required), potency, and contaminants." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good or promoted it to an ingredient; on fail, {baker} raised a nonconformance and routed the lot to destruction." },
    ],
  },
  {
    productName: "Crumble",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, and PPE is on before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the vacuum oven, scale, and temperature probes are calibrated and in date." },
      { description: "Input extract (metrc2)", template: "{baker} selected released/staged crude/BHO extract package {source_tag} (metrc2) and weighed {input_weight} g as the batch input." },
      { description: "Whip", template: "{baker} whipped the extract for {whip_time} to introduce air ahead of drying." },
      { description: "Low-temp vacuum dry", template: "{baker} vacuum-dried the whipped extract at {dry_temp} for {dry_time} until it reached a dry, crumbly consistency and residual solvent was within limits." },
      { description: "Form change - new METRC tag", template: "{baker} decremented extract package {source_tag} by mass consumed and created the crumble package {product_tag}, source-linked, output weight {output_weight} g; the container was labeled with the new tag." },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) and submitted samples for residual solvent (PASS required), potency, and contaminants." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good or promoted it to an ingredient; on fail, {baker} raised a nonconformance and routed the lot to destruction." },
    ],
  },
  {
    productName: "THCa Diamonds & Sauce",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed the C1D1 booth is operational, LEL/gas monitoring is active and in-range, no ignition sources are present, and PPE is on before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the vacuum oven, scale, pressure vessel, and temperature probes are calibrated and in date." },
      { description: "Input extract (metrc2)", template: "{baker} selected released/staged extract package {source_tag} (metrc2) and weighed {input_weight} g; high-terpene live-resin extract is preferred for strong crystal formation." },
      { description: "Jar under pressure (crystallization)", template: "{baker} jarred the extract and held it at {crystallization_temp} under controlled pressure for {crystallization_time} (commonly days to weeks) to let THCa crystals nucleate while the terpene sauce separates." },
      { description: "Determine output configuration", template: "{baker} chose the output configuration after crystallization: THCa diamonds separated from terpene sauce as individual products, retained together as a combined Diamonds & Sauce product, or a mix of both." },
      { description: "Final purge", template: "{baker} purged the diamonds and the sauce under vacuum at {purge_temp} for {purge_time} to bring residual solvent within limits." },
      { description: "Form change - new METRC tag(s) (up to three outputs)", template: "{baker} decremented extract package {source_tag} and created the applicable new source-linked packages: diamonds-only {diamonds_tag} ({diamonds_weight} g), sauce-only {sauce_tag} ({sauce_weight} g), and/or combined Diamonds & Sauce {combo_tag} ({combo_weight} g). Only the packages actually produced are created and labeled; the unused ones are left blank." },
      { description: "Quarantine & testing", template: "{baker} set each created lot (diamonds, sauce, and/or combo) to Quarantine (R 420.303a) and submitted samples for residual solvent (PASS required), potency, and contaminants." },
      { description: "Disposition", template: "On COA pass, {baker} released each lot as a finished good or promoted it to an ingredient; on fail, {baker} raised a nonconformance and routed the affected lot to destruction." },
    ],
  },
  // Session 63 (2026-06-09, Jonathan) — expand the library beyond Crude so the
  // other process types are exercisable. Pre-Roll → Pre-roll process type,
  // Vape Cartridge → Inhalants, Gummies → Kitchen (Edible). Same conventions:
  // facility-fixed values written into the sentence; only run-time records and
  // {baker} stay as {blanks}; METRC form changes captured as e-signed steps.
  {
    productName: "Pre-Roll",
    productType: "Pre-Roll",
    steps: [
      { description: "Sanitation & equipment", template: "{baker} confirmed the rolling station, grinder, and scale are clean, sanitized, and calibrated/in date, and that PPE is on before opening the batch." },
      // Session 112 (2026-08-17) — the package tag and the input weight are
      // already captured on the batch's Ingredients tab (Food Ingredients), so
      // asking for them again here made the operator re-type a 24-character
      // METRC tag for no added traceability. The step is now an attestation
      // that the recorded input was verified and staged.
      { description: "Input flower", template: "{baker} verified the released/tested flower or shake package and its weight as recorded on this batch's Ingredients tab, and confirmed the material was staged for this batch. (Infused pre-rolls: also record the concentrate/kief package and weight on the Ingredients tab.)" },
      { description: "Grind / mill", template: "{baker} ground the flower to the target consistency for even draw and removed stems and seeds." },
      { description: "Fill cones", template: "{baker} filled pre-roll cones to the SOP target fill weight of {unit_weight} g per cone." },
      { description: "Pack & close", template: "{baker} packed each cone to the target density and twisted/closed the tip." },
      { description: "QC weight check", template: "{baker} weighed a sample of finished pre-rolls against the {unit_weight} g target (within SOP tolerance), recorded the results, and pulled any out-of-tolerance units." },
      { description: "Form change - new METRC tag", template: "{baker} decremented flower package {source_tag} by mass consumed and created the pre-roll package {product_tag}, source-linked, unit count {unit_count}; the package was labeled with the new tag. (No prior tag may carry forward through a form change.)" },
      { description: "Package & label", template: "{baker} packaged the pre-rolls into compliant child packages and verified the labels against the approved template." },
      { description: "Disposition", template: "{baker} released the lot as a finished good, or set it to Quarantine pending any testing required by facility policy (e.g. infused pre-rolls)." },
    ],
  },
  {
    productName: "Vape Cartridge",
    productType: "Vape Cartridge",
    steps: [
      { description: "Safety & equipment", template: "{baker} confirmed the fill station is clean, fume control is active, PPE is on, and the cartridge-filling equipment, scale, and temperature probes are calibrated/in date before opening the batch." },
      { description: "Input distillate (metrc3)", template: "{baker} selected released/staged distillate (or other released oil) package {source_tag} (metrc3), weighed {oil_input} g, and recorded it as the batch input." },
      { description: "Terpene / diluent blend", template: "{baker} warmed the oil to {blend_temp}, blended in terpenes/diluent (lot {terpene_lot}) at the SOP ratio of {terpene_ratio}, and mixed until homogeneous. (Homogeneity is the critical control for per-cartridge potency.)" },
      { description: "Fill cartridges", template: "{baker} filled cartridges to the target fill of {fill_volume} per unit using the calibrated filler." },
      { description: "Cap & cure", template: "{baker} capped/pressed each cartridge and allowed wicking/cure for {cure_time} before handling." },
      { description: "QC check", template: "{baker} inspected the cartridges for fill level, leaks, and airflow against the SOP and pulled any defective units." },
      { description: "Form change - new METRC tag", template: "{baker} decremented oil package {source_tag} by mass consumed and created the cartridge package {product_tag}, source-linked, unit count {unit_count}; the package was labeled with the new tag. (No prior tag may carry forward through a form change.)" },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) and submitted samples for residual solvent, potency, heavy metals, and the Vitamin E Acetate / cutting-agent screen (R 420.305)." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good; on fail, {baker} raised a nonconformance and routed the lot to destruction." },
    ],
  },
  {
    productName: "Cannabis Gummies",
    productType: "Edible",
    steps: [
      { description: "Sanitation & equipment", template: "{baker} confirmed the kitchen station and tools are clean and sanitized, PPE is on, and the scale and thermometer are calibrated before opening the batch." },
      { description: "Bloom gelatin / hydrate pectin", template: "{baker} bloomed the gelatin (or hydrated the pectin) per the recipe and set it aside." },
      { description: "Heat base", template: "{baker} combined the juice/water, sugar, and corn syrup and heated the base to the SOP target temperature {cook_temp}, stirring to dissolve." },
      { description: "Incorporate cannabinoid", template: "{baker} measured {cannabinoid_input} g of the potency ingredient (distillate/isolate) from package {source_tag} plus the emulsifier and blended it thoroughly into the base at {mix_temp} until fully homogeneous. (Even distribution is the critical control for per-serving dose accuracy.)" },
      { description: "Add flavor, color & acid", template: "{baker} removed the mix from direct heat and stirred in the flavoring, coloring, and citric acid per the recipe." },
      { description: "Deposit into molds", template: "{baker} deposited the mix into molds at the target {unit_weight} g per cavity to hit the labeled mg per serving." },
      { description: "Set & demold", template: "{baker} set the gummies at {set_temp} for {set_time}, then demolded them." },
      { description: "Cure & coat", template: "{baker} cured/dried the gummies and applied any dusting or coating per the recipe." },
      { description: "QC & package", template: "{baker} checked unit weight against the {unit_weight} g target (within SOP tolerance), packaged the gummies, and confirmed labeled potency against the COA." },
      { description: "Disposition", template: "{baker} released the lot as a finished good, or set it to Quarantine pending COA where required by facility policy." },
    ],
  },
  // Session 63 (2026-06-09, Jonathan) — from uploaded source documents.
  // Rosin Decarb mirrors Exhale SOP EXSOP_0017 (solventless rosin for vape pod
  // filling; NO solvent/booth language — heat + burp + potency gate). Concentrate
  // productType → Inhalants. Facility-fixed values (130-145 degrees F, <2% THCA)
  // are written into the sentences; only run-time records stay as {blanks}.
  {
    productName: "Rosin Decarb",
    productType: "Concentrate",
    steps: [
      { description: "Safety gate", template: "{baker} confirmed PPE is on (lab coat, protective eyewear, hairnet, beard net, gloves, face mask) and acknowledged the hot-product handling and jar-burping precautions (burp jars away from the face; safety glasses when opening warm rosin) before opening the batch." },
      { description: "Equipment & calibration", template: "{baker} verified the convection oven and the industrial scale are functioning and calibrated/in date." },
      { description: "Input pressed rosin (metrc)", template: "{baker} selected the pressed rosin package {source_tag}, confirmed the jars were weighed, logged, and labeled, and recorded {input_weight} g as the batch input." },
      { description: "Preheat & load", template: "{baker} preheated the convection oven to 130-145 degrees F and placed the labeled jars of rosin into the oven." },
      { description: "Monitor & burp", template: "{baker} monitored the jars for pressure buildup (an abnormally raised lid); on any raised lid, removed the jar, burped it away from the face to release pressure, re-secured the lid, and returned it to the oven. Jars in storage are burped daily. Burp observations/dates recorded: {burp_log}." },
      { description: "Decarb to endpoint", template: "{baker} held the oven at 130-145 degrees F until the rosin turned to a liquid state with very few bubbles and a steady consistency. Total decarb time {decarb_time} (varies by strain, commonly ~2 weeks)." },
      { description: "Potency testing", template: "{baker} removed the liquid rosin and submitted it for potency testing only. Release requires passing results with less than 2% THCA." },
      { description: "Disposition / fill-ready", template: "On passing results (<2% THCA), {baker} reheated the rosin to 130-145 degrees F for vape pod/cartridge filling per the brand-specific filling SOP; on fail, {baker} raised a nonconformance and routed the lot accordingly." },
    ],
  },
  // 100 mg infused cookie — from the Cookie Inventory Control Form. Covers both
  // Chocolate Chip (CC) and Peanut Butter (PB); operator records the type at line
  // clearance and follows the CC/PB-specific notes inline. Distillate-infused
  // cannabutter + cannabis distillate are added at the amount the COA potency
  // dictates to hit the 100 mg target (intermediate-as-ingredient). Facility-fixed
  // values (345 degrees F, 11 min, 28 g CC / 31 g PB, 45-55 degrees F chill) live
  // in the sentences; run-time records + {baker} stay as {blanks}.
  {
    productName: "100 mg Infused Cookie (CC/PB)",
    productType: "Edible",
    steps: [
      { description: "Line clearance", template: "Before production, {baker} washed hands 20 seconds with hot water and soap, confirmed PPE on the team (apron/lab coat, hair/beard nets, clean shoes, nitrile gloves), cleaned and disinfected the tabletop with a no-rinse hard-surface sanitizer, verified the cleaned scale is functioning, visually inspected the mixing tools for cleanliness, and checked the Butter Log for the cannabutter, flavor, and quantities. Cookie type this batch: {cookie_type} (CC or PB)." },
      { description: "Ingredient verification", template: "{baker} documented the lot/METRC number, expiration date, and quantity for each ingredient, weighed each against the recipe request (CC and PB targets differ) on scale {scale_id}, and a second team member initialed verification. The distillate-infused cannabutter (per the Distillate Butter SOP) and cannabis distillate are added at the amount the potency results dictate to hit the 100 mg target." },
      { description: "Mix base", template: "In the Hobart mixer ({mixer_id}), {baker} added white sugar, brown sugar, and distillate-infused butter (PB only: also add the non-potent butter) and mixed until light and fluffy." },
      { description: "Mix flavor component", template: "CC: {baker} added the dry vanilla pudding and mixed until fully incorporated. PB: {baker} added the peanut butter and mixed until well incorporated." },
      { description: "Add eggs & vanilla", template: "{baker} added the eggs and vanilla extract and mixed until creamy." },
      { description: "Add flour & baking soda", template: "{baker} added the flour and baking soda. CC: mixed slowly until almost all flour was incorporated. PB: mixed until incorporated and holding together." },
      { description: "Add chocolate chips (CC)", template: "CC only: {baker} added the chocolate chips and mixed slowly until fully incorporated into the batter." },
      { description: "Transfer & chill", template: "{baker} removed the batter into poly bins and refrigerated it 20-30 minutes until firm enough to deposit (ideal depositing temperature 45-55 degrees F). Bulk-dough METRC tag: {bulk_dough_tag}." },
      { description: "Deposit", template: "With at least two people on the line, {baker} set up the Reiser depositor ({depositor_id}) and deposited batter onto parchment-lined trays, 24 cookies per tray (4 x 6), at the target of 28 g/cookie (CC) or 31 g/cookie (PB), checking deposited weight at least twice per rack and adjusting to hold target. PB: stamp each cookie with a crosshatch." },
      { description: "Bake", template: "{baker} preheated the oven ({oven_id}) to 345 degrees F, loaded the rack of trays, and baked 11 minutes; if not golden-brown on the edges, added 30 seconds (CC) or 1 minute (PB) and watched to avoid over-baking. Actual bake time {bake_time}." },
      { description: "Cool", template: "{baker} removed the racks with oven mitts to the designated hot-rack location to cool. Bulk-cookie METRC tag {bulk_cookie_tag}; total cookies {cookie_count}." },
      { description: "Label verification", template: "{baker} confirmed the batch passed State compliance tests (attach results; on fail, quarantine and disposition), assigned bulk units to a new Finished Goods tag, and had a second team member verify the finished-goods label against the test results (producer/packager name + license, THC/CBD match, Produced-On date, expiration date, METRC number, testing lab + analysis date)." },
      { description: "Packaging", template: "Once cooled to room temperature, {baker} verified the packaging matches the product and the cookie-rack METRC matches the baking section, confirmed PPE/hygiene and a sanitized packaging area, let the sealer ({sealer_id}) heat 8-10 minutes, then sealed each cookie into a pouch below the 'CANNABIS-INFUSED' line and confirmed each seal. Weight-check scale {pkg_scale_id}." },
      { description: "Finished goods inventory", template: "{baker} recorded good pouches {good_pouches}, defective pouches {defective_pouches}, labels used {labels_used}, the transfer tag range {transfer_tag_range}, total finished goods {total_finished}, any partial METRC tag and quantity, and completed the METRC adjustment if applicable." },
      { description: "Transfer of goods", template: "{baker} documented transfer into the warehouse: units received {units_received}, METRC location updated, and Leaf Link updated." },
    ],
  },
  // Session 68 (2026-06-14, Jonathan) — generic Tincture and Capsule recipes so
  // those product types are exercisable (they map to the Edible R 420.702 label
  // checklist via checklistTemplateFor). Both are Kitchen-GMP, oil-based, dosed
  // in mg — homogeneity of the cannabinoid in the carrier is the critical control
  // for per-unit dose accuracy. Potency ingredient (distillate/isolate) is added
  // at the amount the COA potency dictates to hit the labeled target
  // (intermediate-as-ingredient). Run-time records + {baker} stay as {blanks}.
  {
    productName: "Cannabis Tincture (MCT Oil)",
    productType: "Tincture",
    steps: [
      { description: "Sanitation & equipment", template: "{baker} confirmed the kitchen station and tools are clean and sanitized, PPE is on, and the scale, thermometer, and homogenizer/mixer are calibrated/in date before opening the batch." },
      { description: "Input potency ingredient", template: "{baker} selected the released/staged distillate or isolate package {source_tag}, weighed {cannabinoid_input} g, and recorded it as the batch input. The amount is set by the COA potency to hit the labeled mg per mL target." },
      { description: "Measure carrier", template: "{baker} measured {carrier_volume} mL of MCT oil (and any flavoring, lot {flavor_lot}) per the recipe." },
      { description: "Heat & homogenize", template: "{baker} warmed the MCT oil to {blend_temp}, added the cannabinoid, and blended/homogenized until fully dissolved and homogeneous. (Even distribution is the critical control for per-mL dose accuracy.)" },
      { description: "Potency calculation / QC", template: "{baker} confirmed the finished batch volume and target mg per mL against the COA potency and recorded the calculated dose." },
      { description: "Fill bottles", template: "{baker} filled tincture bottles to {fill_volume} mL per unit using the calibrated filler/dropper assembly." },
      { description: "Cap & label", template: "{baker} capped each bottle, verified the child-resistant dropper closure, recorded unit count {unit_count}, and verified the labels against the approved template and the COA potency." },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) pending potency and contaminant results where required by facility policy." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good; on fail, {baker} raised a nonconformance and routed the lot accordingly." },
    ],
  },
  {
    productName: "Cannabis Capsules",
    productType: "Capsule",
    steps: [
      { description: "Sanitation & equipment", template: "{baker} confirmed the kitchen station and tools are clean and sanitized, PPE is on, and the scale and encapsulation equipment are calibrated/in date before opening the batch." },
      { description: "Input potency ingredient", template: "{baker} selected the released/staged distillate or oil package {source_tag}, weighed {cannabinoid_input} g, and recorded it as the batch input. The amount is set by the COA potency to hit the labeled mg per capsule target." },
      { description: "Blend carrier", template: "{baker} warmed the mixture to {blend_temp} and blended the cannabinoid into {carrier_amount} g of MCT oil (and any excipient) at the SOP ratio until homogeneous. (Even distribution is the critical control for per-capsule dose accuracy.)" },
      { description: "Encapsulate", template: "{baker} filled capsules to the target {fill_per_capsule} per unit using the calibrated encapsulation machine." },
      { description: "QC weight & count", template: "{baker} checked capsule fill weight against the {fill_per_capsule} target (within SOP tolerance), recorded the results, pulled any out-of-tolerance units, and recorded unit count {unit_count}." },
      { description: "Package & label", template: "{baker} packaged the capsules into compliant child packages and verified the labels against the approved template and the COA potency." },
      { description: "Quarantine & testing", template: "{baker} set the lot to Quarantine (R 420.303a) pending potency and contaminant results where required by facility policy." },
      { description: "Disposition", template: "On COA pass, {baker} released the lot as a finished good; on fail, {baker} raised a nonconformance and routed the lot accordingly." },
    ],
  },
];

const SEED_NOTE = "Demo recipe (seeded 2026-06-05). Safe to edit or delete.";

async function insertSteps(recipeId: number, steps: Array<{ description: string; template: string }>) {
  await db.insert(recipeProcessStepsTable).values(
    steps.map((s, i) => ({
      recipeId,
      stepNumber: i + 1,
      description: s.description,
      template: s.template,
      sortOrder: i + 1,
    })),
  );
}

export async function seedDemoRecipes(): Promise<void> {
  try {
    let created = 0;
    let corrected = 0;
    for (const r of DEMO_RECIPES) {
      const [existing] = await db.select().from(recipesTable)
        .where(eq(recipesTable.productName, r.productName));

      if (existing) {
        // Only ever touch recipes WE seeded — never a user-authored recipe that
        // happens to share a name.
        if (!(existing.notes ?? "").startsWith("Demo recipe (seeded")) continue;
        // One-time correction: earlier demos shipped temperature as a {temp}
        // blank. If any step still has the old format, re-sync this recipe's
        // steps to the canonical templates. Once corrected (no {temp}/{unit}
        // left) this is a no-op, so there's no per-boot churn.
        const steps = await db.select().from(recipeProcessStepsTable)
          .where(eq(recipeProcessStepsTable.recipeId, existing.id));
        // Session 112 — the Pre-Roll "Input flower" step is also re-synced, so
        // the already-seeded demo recipe drops the duplicate {source_tag} /
        // {input_weight} blanks instead of only new installs getting the fix.
        // Matched on the OLD sentence, so this fires once and is then a no-op.
        const needsResync = steps.some((s) => {
          const t = s.template ?? "";
          return t.includes("{temp}") || t.includes("{unit}")
            || t.includes("flower or shake package {source_tag}");
        });
        if (!needsResync) continue;
        await db.delete(recipeProcessStepsTable).where(eq(recipeProcessStepsTable.recipeId, existing.id));
        await insertSteps(existing.id, r.steps);
        corrected++;
        continue;
      }

      const [recipe] = await db.insert(recipesTable).values({
        productName: r.productName,
        productType: r.productType,
        version: 1,
        isActive: true,
        notes: SEED_NOTE,
      }).returning();
      if (!recipe) continue;
      await insertSteps(recipe.id, r.steps);
      created++;
    }
    if (created > 0 || corrected > 0) logger.info({ created, corrected }, "Demo recipes seed complete");
  } catch (err) {
    logger.error({ err }, "Failed to seed demo recipes");
  }
}
