import { db } from "@workspace/db";
import {
  labelStaticBlocksTable,
  labelTemplatesTable,
  PRODUCT_TYPES,
  type ProductType,
  type RegionConfig,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";

// ⛔ CORRECTED 2026-08-30. What stood here was INVENTED — "premature birth" for
// preterm birth, no developmental-problems clause, "AND PETS" (that is New York,
// not Michigan), a driving warning in wording the rule does not use, and an
// "edible onset — 2 hours" block Michigan does not require at all. Every citation
// pointed at R 420.504 generally or at subsections about something else.
//
// The five statements below are R 420.504(1)(j)(i)-(v) VERBATIM, read from the
// Michigan Marihuana Rules (2022 MR 5, eff. 7 Mar 2022). Do not paraphrase them:
// the rule prescribes the words, not the meaning.
//
// ⚠️ (j)(v) also carries a FORMATTING requirement — clearly legible type,
// surrounded by a continuous heavy line — which this model has no way to express.
// It is stated in the citation so whoever lays out the label sees it.
//
// ⚠️ THREE BLOCKS BELOW ARE NOT REQUIRED BY ANY RULE I could find (edible onset,
// vape inhalation, topical application). They are kept because templates may
// already reference them, but their citation now says so plainly. A company
// standard is a fine thing to print; filing it under a rule number is not.
const STANDARD_BLOCKS: Array<{ name: string; body: string; regulationRef: string; appliesTo: ReadonlyArray<ProductType> }> = [
  {
    name: "Government Warning",
    body: "WARNING: USE BY PREGNANT OR BREASTFEEDING WOMEN, OR BY WOMEN PLANNING TO BECOME PREGNANT, MAY RESULT IN FETAL INJURY, PRETERM BIRTH, LOW BIRTH WEIGHT, OR DEVELOPMENTAL PROBLEMS FOR THE CHILD.",
    regulationRef: "MI R 420.504(1)(j)(v) — clearly legible type, surrounded by a continuous heavy line",
    appliesTo: PRODUCT_TYPES,
  },
  {
    name: "Keep Out of Reach",
    body: "For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.",
    regulationRef: "MI R 420.504(1)(j)(iv)",
    appliesTo: PRODUCT_TYPES,
  },
  {
    // The OTHER age statement. The rule has two and which one is correct depends
    // on whether the product exceeds the maximum THC allowed under MRTMA, so a
    // label carries one or the other — never both, never neither.
    name: "Age Statement — Exceeds MRTMA THC Limits",
    body: "For use by registered qualifying patients only. Keep out of reach of children.",
    regulationRef: "MI R 420.504(1)(j)(iii)",
    appliesTo: PRODUCT_TYPES,
  },
  {
    name: "Poison Control",
    body: "National Poison Control Center 1-800-222-1222.",
    regulationRef: "MI R 420.504(1)(j)(ii)",
    appliesTo: PRODUCT_TYPES,
  },
  {
    // Legacy name kept so existing templates keep resolving; the TEXT is now the
    // rule's driving statement, which is what (j)(i) actually requires.
    name: "Drug Interaction Warning",
    body: "It is illegal to drive a motor vehicle while under the influence of marihuana.",
    regulationRef: "MI R 420.504(1)(j)(i)",
    appliesTo: PRODUCT_TYPES,
  },
  {
    name: "Edible Onset Warning",
    body: "Effects from edible marijuana products may be delayed by 2 hours or more.",
    regulationRef: "Company standard — no CRA rule located. R 420.504(1)(g) requires activation time in words or a pictogram, but prescribes no wording.",
    appliesTo: ["Edible"],
  },
  {
    name: "Vape Inhalation Warning",
    body: "Inhalation of cannabinoid concentrates may cause respiratory irritation.",
    regulationRef: "Company standard — no CRA rule located",
    appliesTo: ["Vape", "Concentrate"],
  },
  {
    name: "Topical Application",
    body: "For external use only. Avoid contact with eyes and mucous membranes.",
    regulationRef: "Company standard — no CRA rule located",
    appliesTo: ["Topical"],
  },
];

/**
 * One-time correction of blocks already seeded with the invented text.
 *
 * The seeder skips a block that exists, so fixing the constant alone would leave
 * every database still holding the wrong words. This rewrites a block ONLY where
 * its body still exactly matches what was seeded — so a facility that has edited
 * its own wording is never overwritten, and running twice does nothing.
 */
const BLOCK_CORRECTIONS: Array<{ name: string; wasBody: string; body: string; regulationRef: string }> = [
  {
    name: "Government Warning",
    wasBody: "WARNING: Marijuana use by pregnant or breastfeeding women, or by women planning to become pregnant, may result in fetal injury, low birth weight, or premature birth.",
    body: "WARNING: USE BY PREGNANT OR BREASTFEEDING WOMEN, OR BY WOMEN PLANNING TO BECOME PREGNANT, MAY RESULT IN FETAL INJURY, PRETERM BIRTH, LOW BIRTH WEIGHT, OR DEVELOPMENTAL PROBLEMS FOR THE CHILD.",
    regulationRef: "MI R 420.504(1)(j)(v) — clearly legible type, surrounded by a continuous heavy line",
  },
  {
    name: "Keep Out of Reach",
    wasBody: "KEEP OUT OF REACH OF CHILDREN AND PETS.",
    body: "For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.",
    regulationRef: "MI R 420.504(1)(j)(iv)",
  },
  {
    name: "Poison Control",
    wasBody: "If accidentally ingested, contact Poison Control at 1-800-222-1222.",
    body: "National Poison Control Center 1-800-222-1222.",
    regulationRef: "MI R 420.504(1)(j)(ii)",
  },
  {
    name: "Drug Interaction Warning",
    wasBody: "Marijuana may impair the ability to drive or operate machinery. Do not consume marijuana products and drive a vehicle.",
    body: "It is illegal to drive a motor vehicle while under the influence of marihuana.",
    regulationRef: "MI R 420.504(1)(j)(i)",
  },
  {
    name: "Edible Onset Warning",
    wasBody: "Effects from edible marijuana products may be delayed by 2 hours or more.",
    body: "Effects from edible marijuana products may be delayed by 2 hours or more.",
    regulationRef: "Company standard — no CRA rule located. R 420.504(1)(g) requires activation time in words or a pictogram, but prescribes no wording.",
  },
  {
    name: "Vape Inhalation Warning",
    wasBody: "Inhalation of cannabinoid concentrates may cause respiratory irritation.",
    body: "Inhalation of cannabinoid concentrates may cause respiratory irritation.",
    regulationRef: "Company standard — no CRA rule located",
  },
  {
    name: "Topical Application",
    wasBody: "For external use only. Avoid contact with eyes and mucous membranes.",
    body: "For external use only. Avoid contact with eyes and mucous membranes.",
    regulationRef: "Company standard — no CRA rule located",
  },
];

// Default region layout per product type. Order is the on-label vertical order.
function defaultRegionsFor(pt: ProductType, blockIdsByName: Map<string, number>): RegionConfig[] {
  const govId = blockIdsByName.get(`${pt}::Government Warning`);
  const koorId = blockIdsByName.get(`${pt}::Keep Out of Reach`);
  const poisonId = blockIdsByName.get(`${pt}::Poison Control`);
  const drugId = blockIdsByName.get(`${pt}::Drug Interaction Warning`);
  const onsetId = blockIdsByName.get(`${pt}::Edible Onset Warning`);
  const vapeId = blockIdsByName.get(`${pt}::Vape Inhalation Warning`);
  const topicalId = blockIdsByName.get(`${pt}::Topical Application`);

  const regions: RegionConfig[] = [
    { id: "r-brand", kind: "brand-header", enabled: true, order: 1, fontSize: 14, fontWeight: "bold", align: "center" },
    { id: "r-product", kind: "product-info", enabled: true, order: 2, fontSize: 10, align: "center" },
    { id: "r-strain", kind: "strain", enabled: pt === "Flower" || pt === "Pre-Roll", order: 3, fontSize: 9 },
    { id: "r-thc", kind: "thc-cbd", enabled: true, order: 4, fontSize: 9, fontWeight: "bold" },
    { id: "r-weight", kind: "net-weight", enabled: true, order: 5, fontSize: 9 },
    { id: "r-dates", kind: "dates", enabled: true, order: 6, fontSize: 8 },
    { id: "r-metrc", kind: "batch-metrc", enabled: true, order: 7, fontSize: 8 },
    { id: "r-div1", kind: "divider", enabled: true, order: 8 },
  ];

  let order = 9;
  const push = (id: string, blockId: number | undefined) => {
    if (blockId != null) regions.push({ id, kind: "static-block", enabled: true, order: order++, fontSize: 7, staticBlockId: blockId });
  };
  push(`r-gov`, govId);
  push(`r-koor`, koorId);
  push(`r-poison`, poisonId);
  push(`r-drug`, drugId);
  if (pt === "Edible") push(`r-onset`, onsetId);
  if (pt === "Vape" || pt === "Concentrate") push(`r-vape`, vapeId);
  if (pt === "Topical") push(`r-topical`, topicalId);

  return regions;
}

function dimsFor(pt: ProductType): { widthIn: number; heightIn: number } {
  switch (pt) {
    case "Flower":
    case "Pre-Roll":
      return { widthIn: 2.0, heightIn: 4.0 };
    case "Edible":
      return { widthIn: 3.0, heightIn: 5.0 };
    case "Concentrate":
    case "Vape":
      return { widthIn: 2.0, heightIn: 3.0 };
    case "Topical":
      return { widthIn: 2.5, heightIn: 4.0 };
  }
}

/**
 * Idempotent seed of the 6 MI category default templates and their static
 * blocks. Existing rows (matched by productType+name) are not overwritten so
 * facility edits are preserved on subsequent boots.
 */
export async function seedLabelDefaults(): Promise<void> {
  try {
    const blockIdsByName = new Map<string, number>();

    // ⛔ Run the corrections BEFORE seeding, so a block whose text is being fixed
    // is repaired rather than skipped as "already present". Matches on the exact
    // old body, so an edited block is left alone and a second run is a no-op.
    for (const fix of BLOCK_CORRECTIONS) {
      const updated = await db
        .update(labelStaticBlocksTable)
        .set({ body: fix.body, regulationRef: fix.regulationRef })
        .where(and(
          eq(labelStaticBlocksTable.name, fix.name),
          eq(labelStaticBlocksTable.body, fix.wasBody),
        ))
        .returning({ id: labelStaticBlocksTable.id });
      if (updated.length > 0) {
        logger.info({ block: fix.name, rows: updated.length }, "Label static block corrected to the rule text");
      }
    }

    for (const pt of PRODUCT_TYPES) {
      for (const block of STANDARD_BLOCKS) {
        if (!block.appliesTo.includes(pt)) continue;
        const key = `${pt}::${block.name}`;
        const [existing] = await db.select().from(labelStaticBlocksTable)
          .where(and(eq(labelStaticBlocksTable.productType, pt), eq(labelStaticBlocksTable.name, block.name)));
        if (existing) {
          blockIdsByName.set(key, existing.id);
          continue;
        }
        const [inserted] = await db.insert(labelStaticBlocksTable).values({
          productType: pt,
          name: block.name,
          body: block.body,
          regulationRef: block.regulationRef,
        }).returning();
        if (inserted) blockIdsByName.set(key, inserted.id);
      }
    }

    for (const pt of PRODUCT_TYPES) {
      const templateName = `MI Default — ${pt}`;
      const [existing] = await db.select().from(labelTemplatesTable)
        .where(and(eq(labelTemplatesTable.productType, pt), eq(labelTemplatesTable.name, templateName)));
      if (existing) continue;
      const dims = dimsFor(pt);
      await db.insert(labelTemplatesTable).values({
        productType: pt,
        name: templateName,
        widthIn: dims.widthIn,
        heightIn: dims.heightIn,
        regions: defaultRegionsFor(pt, blockIdsByName),
        isDefault: true,
      });
    }

    const [{ count: tplCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(labelTemplatesTable);
    const [{ count: blkCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(labelStaticBlocksTable);
    logger.info({ templates: tplCount, blocks: blkCount }, "Label defaults seed complete");
  } catch (err) {
    logger.error({ err }, "Failed to seed label defaults");
  }
}
