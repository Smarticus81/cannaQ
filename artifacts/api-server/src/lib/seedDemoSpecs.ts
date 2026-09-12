import { db } from "@workspace/db";
import {
  documentsTable,
  documentSectionsTable,
  recipesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { facilityDateStr } from "./facilityDate";

// Session 66 (2026-06-11, Jonathan) — seed Approved, recipe-backed Work
// Instruction documents (plus a couple of standalone library docs) so a fresh
// instance can actually run a batch to RELEASE. Session 65 OQ-12 was BLOCKED
// because the release path requires an Approved Specification/Work Instruction
// to link to the batch, and a first-run instance seeds none (Deviation D5).
//
// What "Approved" means here (mirrors POST /documents/:id/approve): the doc is
// status="Approved" with the full Part 11 signature block filled — a distinct
// reviewer and approver, signature timestamps, initials, meaning, approval +
// effective dates, and a next-review date. The link-spec route only checks
// `documentType ∈ {Specification, Work Instruction}` and `status === "Approved"`,
// so these are immediately linkable in the batch "Link Procedure" picker.
//
// The WIs are RECIPE-BACKED (recipeId set), so the document's `process_steps`
// section renders the SAME steps the operator executes on a batch — the hybrid
// doc<->process bridge (single source of truth). Each WI is generated from the
// recipe it backs, so it auto-covers every seeded recipe and stays in sync.
//
// Idempotent: a doc is only seeded if one with the same docNumber doesn't
// already exist. Deleting a seeded doc lets it re-seed on the next boot. We
// never touch a user-authored doc. Numbering uses a dedicated `-SEED-` scheme so
// it can never collide with the live generateDocNumber() sequence (WI-26-####).

const SEED_TAG = "Seeded first-run library document (2026-06-11). Safe to edit or delete.";

// Distinct reviewer/approver identities so the segregation-of-duties story holds
// up on inspection of the seeded signature block. Names only — the seeded docs
// are demo content and intentionally carry no assignedReviewerId/approverId.
const SEED_REVIEWER = "Quality Reviewer (Seed)";
const SEED_APPROVER = "Quality Manager (Seed)";
const SEED_AUTHOR = "Process Engineering (Seed)";

// Section kinds that render from live batch data need no body. `free_text`,
// `equipment`, and `room_environmental` render their bodyMarkdown verbatim.
type SeedSection = {
  kind: string;
  title: string;
  bodyMarkdown?: string;
};

// Per-product-type framing for the generated Work Instructions.
function departmentFor(productType: string): string {
  switch (productType) {
    case "Edible":
      return "Kitchen / Edibles";
    case "Concentrate":
      return "Extraction / Concentrates";
    case "Vape Cartridge":
      return "Fill / Inhalants";
    case "Pre-Roll":
      return "Pre-Roll";
    default:
      return "Production";
  }
}

// Known source-document provenance, by recipe productName. Surfaced in the WI's
// Purpose & Scope section so the seeded doc traces back to the real SOP/WI the
// process steps were drawn from (Jonathan's Exhale library + the MI uploads).
const SOURCE_REFS: Record<string, string> = {
  "Rosin Decarb": "EXSOP_0017 — Rosin Decarb Procedure",
  "Vape Cartridge": "EXSOP_0018 — Vaporizer Inventory Control Procedure",
  "Pre-Roll": "Infused Pre-Roll Procedure (MI) / Pre-Roll Inventory Control Form",
  "100 mg Infused Cookie (CC/PB)": "Cookie Inventory Control Form (MI)",
  "Crude Extraction (BHO / CO2 / Ethanol)": "SOP-CRUDE-001 / WI-EXTRACT-CRUDE-001",
  "Distillate Production": "SOP-DISTILLATE-001 / WI-DISTILL-001",
};

function workInstructionSections(productName: string, productType: string): SeedSection[] {
  const src = SOURCE_REFS[productName];
  const provenance = src ? `\n\nDerived from approved source procedure: **${src}**.` : "";
  return [
    { kind: "header", title: "Batch Record Header" },
    {
      kind: "free_text",
      title: "Purpose & Scope",
      bodyMarkdown:
        `This Work Instruction defines the controlled manufacturing steps for **${productName}** ` +
        `(${productType}). It is the approved procedure operators execute on each batch; the ` +
        `process steps below are the single source of truth shared with the batch record.${provenance}`,
    },
    {
      kind: "equipment",
      title: "Materials & Equipment",
      bodyMarkdown:
        "Use only calibrated, in-date equipment and released, correctly-tagged materials. " +
        "Confirm sanitation and line clearance before opening the batch.",
    },
    { kind: "ingredients", title: "Bill of Materials (Planned vs Actual)" },
    // Session 112 — packaging and the compliance label get their own section,
    // kept next to the Bill of Materials so every material line reads together.
    // The BOM above now covers only what's weighed out during manufacturing;
    // without this section those lots wouldn't print at all.
    { kind: "packaging", title: "Packaging & Label Lots" },
    {
      kind: "process_steps",
      title: "Procedure",
      bodyMarkdown:
        "Execute each step in order. Operators fill the {blank} run-time values and e-sign; " +
        "qualified operators may sign solo, unqualified operators require supervisor co-sign.",
    },
    { kind: "in_process_checks", title: "In-Process Checks" },
    { kind: "tests", title: "Laboratory Testing" },
    { kind: "yield", title: "Yield Reconciliation" },
    { kind: "signoffs", title: "Review & Release Signatures" },
  ];
}

// Standalone library docs that are not tied to a single recipe. The release
// Specification is linkable (documentType "Specification") and gives an instance
// a generic acceptance-criteria doc to link when no product-specific WI applies.
const STANDALONE_DOCS: Array<{
  docNumber: string;
  title: string;
  documentType: string;
  department: string;
  description: string;
  scope: string;
  sections: SeedSection[];
}> = [
  {
    docNumber: "SPEC-SEED-0001",
    title: "Finished Product Release Specification — Cannabis Products",
    documentType: "Specification",
    department: "Quality",
    description: "Generic finished-goods acceptance criteria for batch release.",
    scope: "Applies to all finished cannabis products pending release to inventory.",
    sections: [
      { kind: "header", title: "Release Record Header" },
      {
        kind: "free_text",
        title: "Acceptance Criteria",
        bodyMarkdown:
          "A batch may be released only when: (1) all required state compliance tests PASS " +
          "(potency, microbials, residual solvents where applicable, heavy metals, pesticides per " +
          "MI MRA R 420.305); (2) label verification confirms COA-matched potency and all required " +
          "warnings; (3) yield reconciliation is within tolerance; and (4) the release is e-signed by " +
          "an authorized approver. Any failure routes the lot to Quarantine and a Nonconformance.",
      },
      { kind: "tests", title: "Laboratory Testing" },
      { kind: "yield", title: "Yield Reconciliation" },
      { kind: "signoffs", title: "Release Signatures" },
    ],
  },
  {
    docNumber: "SOP-SEED-0001",
    title: "Testing & Sampling — Submission and Manifest",
    documentType: "SOP",
    department: "Quality",
    description: "How samples are created in METRC and a testing transfer/manifest is registered.",
    scope: "Scheduling and submission of cannabis sample pick-ups to the testing laboratory.",
    sections: [
      {
        kind: "free_text",
        title: "Procedure",
        bodyMarkdown:
          "1. In METRC, filter active packages for the bulk source to be submitted and choose " +
          "**Submit for Testing**.\n" +
          "2. Enter the sampled quantity, assign a new METRC tag, set the package date to today, and " +
          "select the required tests.\n" +
          "3. Create a **New Transfer**: destination testing facility + license, planned route, type " +
          "**Testing Transfer**, departure/arrival times, gross weight (from the lab technician), and " +
          "driver details.\n" +
          "4. Add the created sample packages to the manifest and **Register Transfer**.\n" +
          "5. Before the samples leave, management prints the manifest and reviews it with the lab " +
          "technician to confirm all tags and test requests are correct.",
      },
    ],
  },
];

function approvedFields(now: Date) {
  const approvalDateStr = facilityDateStr(now);
  const nextReview = new Date(now);
  nextReview.setFullYear(nextReview.getFullYear() + 3);
  const nextReviewStr = facilityDateStr(nextReview);
  return {
    revision: "1.0",
    status: "Approved" as const,
    ownerName: SEED_APPROVER,
    createdByName: SEED_AUTHOR,
    summaryOfChanges: SEED_TAG,
    changeSeverity: "Minor",
    effectiveDate: approvalDateStr,
    approvalDate: approvalDateStr,
    approvedByName: SEED_APPROVER,
    reviewerSignedAt: now,
    reviewerSignedName: SEED_REVIEWER,
    reviewerSignedInitials: "QR",
    reviewerSignedMeaning: "Reviewed for technical accuracy and completeness.",
    approverSignedAt: now,
    approverSignedInitials: "QM",
    approverSignedMeaning: "Approved for use.",
    reviewIntervalYears: 3,
    reviewDate: nextReviewStr,
    nextReviewDate: nextReviewStr,
  };
}

async function insertSections(documentId: number, sections: SeedSection[]) {
  await db.insert(documentSectionsTable).values(
    sections.map((s, i) => ({
      documentId,
      sortOrder: i + 1,
      kind: s.kind,
      title: s.title,
      bodyMarkdown: s.bodyMarkdown ?? null,
    })),
  );
}

export async function seedDemoSpecs(): Promise<void> {
  try {
    const now = new Date();
    const approved = approvedFields(now);
    let created = 0;

    // 1) One Approved, recipe-backed Work Instruction per demo recipe. These are
    // what unblock OQ-12 (link procedure -> send to testing -> release).
    const recipes = await db.select().from(recipesTable);
    // Stable WI numbering: order by recipe id so re-seeds reuse the same numbers.
    const sorted = [...recipes].sort((a, b) => a.id - b.id);
    let seq = 0;
    for (const recipe of sorted) {
      seq++;
      const docNumber = `WI-SEED-${String(seq).padStart(4, "0")}`;
      const [existing] = await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.docNumber, docNumber));
      if (existing) continue; // idempotent — never touch an existing doc

      const [doc] = await db
        .insert(documentsTable)
        .values({
          docNumber,
          title: `${recipe.productName} — Work Instruction`,
          documentType: "Work Instruction",
          department: departmentFor(recipe.productType),
          description: `Approved manufacturing Work Instruction for ${recipe.productName}.`,
          scope: `Applies to the production of ${recipe.productName} (${recipe.productType}).`,
          recipeId: recipe.id,
          ...approved,
        })
        .returning();
      if (!doc) continue;
      await insertSections(doc.id, workInstructionSections(recipe.productName, recipe.productType));
      created++;
    }

    // 2) Standalone library docs (release Specification + Testing & Sampling SOP).
    for (const d of STANDALONE_DOCS) {
      const [existing] = await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.docNumber, d.docNumber));
      if (existing) continue;
      const [doc] = await db
        .insert(documentsTable)
        .values({
          docNumber: d.docNumber,
          title: d.title,
          documentType: d.documentType,
          department: d.department,
          description: d.description,
          scope: d.scope,
          ...approved,
        })
        .returning();
      if (!doc) continue;
      await insertSections(doc.id, d.sections);
      created++;
    }

    if (created > 0) logger.info({ created }, "Demo specs/WIs seed complete");
  } catch (err) {
    logger.error({ err }, "Failed to seed demo specs/WIs");
  }
}
