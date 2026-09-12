import { Router } from "express";
import { db } from "@workspace/db";
import {
  batchRecordsTable,
  batchIngredientsTable,
  batchTestingTable,
  batchLabelingTable,
  checklistItemsTable,
  checklistResponsesTable,
  batchLabelPrintsTable,
  labelTemplatesTable,
  auditLogTable,
  checklistTemplateFrom,
  LABEL_CHECKLIST_TEMPLATES,
} from "@workspace/db";
import { recipesTable, recipeItemsTable, recipeProcessStepsTable, batchProcessStepsTable, batchMetrcTagsTable, documentsTable, documentSectionsTable, suppliersTable, operatorQualificationsTable, usersTable, lotsTable, lotEventsTable, companyProfileTable, productTypeSettingsTable, inventoryItemsTable, trainingRecordsTable } from "@workspace/db";
import { getActingFacilityId } from "../middlewares/facilityContext";
import { getRegulatoryRulesForFacility, getLabelChecklistsForFacility, getFacilityState } from "../lib/regulatoryRules";
import { getPackagingCoverage } from "../lib/packagingCoverage";
import { getStaleIngredientArtwork, staleArtworkMessage } from "../lib/ingredientTripwire";
import { getLabelTemplateCoverage } from "../lib/labelTemplateCoverage";
import { and, eq, sql, desc, asc, ne, inArray, getTableColumns } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { getMetrcConfig } from "../lib/metrcClient";
import { getPackageByLabel } from "../lib/metrcPackages";
import { getTrackingProviderForFacility } from "../lib/trackingProvider";
import { getLabResultsProvider } from "../lib/labResultsProvider";
import { convertQuantity } from "../lib/units";
import { logger } from "../lib/logger";
import { facilityDateStr } from "../lib/facilityDate";
import { normalizeBomKind, isPackagingStageKind } from "../lib/bomKinds";
import { getRecipeRelease } from "../lib/recipeRelease";
import { labSampleQuarantineBlock } from "../lib/labSampleQuarantine";

// Session 36 (Tier 3 #14) — Testing tab redesign.
//
// Each batch_testing row carries a phase ("pre_test" | "result"). The same
// row evolves: it's created at sample pull (phase="pre_test", carries weight
// + uom + pulled-at + by-name + agency selection) and PATCHed to phase=
// "result" when the CoA arrives (carries the analyte values in `resultValues`
// plus the CoA attachment URL). Legacy single-row tests pre-date the lifecycle
// and migrate to phase="result".
const BATCH_TESTING_PHASES = new Set(["pre_test", "result"]);

// Fields a client may set on a batch_testing row. Server controls id /
// batchId / sequenceNumber / createdAt / updatedAt. Both phases share this
// allowlist; the UI is responsible for showing the right inputs per phase,
// and we don't enforce "only pre_test fields when phase=pre_test" — the
// operator might fill the agency selection on the pre-test row, which is
// fine. The constraint is only on testing_agency_id (validated via FK + a
// status check below).
const BATCH_TESTING_ALLOWED = new Set([
  "phase",
  "chamber",                // dual chamber vape carts — which chamber this test covers (A / B / C)
  "sampleWeight",
  "sampleUom",
  "samplePulledAt",
  "samplePulledByName",
  "testingAgencyId",
  "testingAgency",          // legacy free-text — accepted for back-compat
  "submittedDate",
  "resultDate",
  "testResult",
  "resultValues",
  "thcPct",                 // legacy hardcoded analyte columns; accepted but
  "cbdPct",                 // new UI writes to resultValues instead.
  "totalCannabinoids",
  "microbialsPass",
  "pesticidesPass",
  "heavyMetalsPass",
  "residualSolventsPass",
  "vitaminEAcetate",
  "mctOilPass",
  "coaUrl",
  "notes",
  // Lab sample collection (R 420.304(2), 2026-09-08). The signature trio
  // (coc_signed_by_name / _at) is set SERVER-side from the signed-in user —
  // a client may send the initials and the meaning, never the name or the time.
  "sampleCollectedAt",
  "sampleTransferredAt",
  "sourcePackageTag",
  "sourceRemainingQty",
  "sourceRemainingUom",
  "labCollectorName",
  "observerName",
  "sampleMetrcTag",
  "cocMetrcIdentified",
  "cocObservedThroughout",
  "cocNoAssist",
  "cocRetestConfirmed",
  "cocSignedByInitials",
  "cocSignedMeaning",
]);

// Session 36 — when a testing_agency_id is provided, validate it points at a
// supplier with supplier_type='Testing Laboratory' AND status='Approved'.
// Mirrors the Session 33 cannabis-receiving rule: in-flight suppliers can't
// be production-qualified labs.
async function validateTestingAgency(agencyId: number | null | undefined): Promise<string | null> {
  if (!agencyId) return null;
  const [s] = await db
    .select({
      supplierType: suppliersTable.supplierType,
      status: suppliersTable.status,
      supplierName: suppliersTable.supplierName,
    })
    .from(suppliersTable)
    .where(eq(suppliersTable.id, agencyId));
  if (!s) return `Testing agency supplier #${agencyId} not found.`;
  if (s.supplierType !== "Testing Laboratory") {
    return `Supplier "${s.supplierName}" is not a Testing Laboratory (type: "${s.supplierType}"). Pick an approved testing lab.`;
  }
  if (s.status !== "Approved") {
    return `Testing lab "${s.supplierName}" is in status "${s.status}". Only Approved labs can be selected as a testing agency.`;
  }
  return null;
}

async function writeAuditLog(opts: {
  rowId: number;
  operation: string;
  changedByName?: string | null;
  changedById?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "batch_records",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch (err) {
    // Audit log must never break the main flow, but a swallowed failure made the
    // missing-LABELING_APPROVE issue undiagnosable. Log it so the real cause shows
    // in the Railway logs while still not throwing.
    logger.error({ err, operation: opts.operation, rowId: opts.rowId }, "writeAuditLog insert failed");
  }
}

// Session 56 — ingredient acting-user attribution. Per the 06-04 Part 11
// review, recording an ingredient weight (add / change / remove) must capture
// WHO acted plus the before→after state. We satisfy this through the existing
// audit_log (no schema change) under the "batch_ingredients" table name, with
// the acting user's id + name. Mirrors writeAuditLog but targets the ingredient
// table so the trail is attributable on every weight mutation.
async function writeIngredientAudit(opts: {
  rowId: number;
  operation: string;
  changedById?: number | null;
  changedByName?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "batch_ingredients",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

const router = Router();

// Session 32 — match NC/CAPA generator semantics: MAX of the parsed sequence
// suffix within the current year, NOT count(*). Year-scoped, monotonic, never
// reuses a number after a delete. The old count(*) approach drifted whenever
// rows from prior years or other test data inflated the count, producing the
// "increment-by-N" jump the operator observed (BTH-26-0011 → BTH-26-0021).
// Race-condition note: small TOCTOU window between SELECT and INSERT; the
// unique constraint on batch_number is the hard backstop.
// Session 36 (Tier 7 C1 scoped) — process_type discriminator. Four values
// today; cultivation field set lands in C2/C3.
const BATCH_PROCESS_TYPES = new Set(["Cultivation", "Kitchen", "Inhalants", "Pre-roll"]);

// 2026-08-19 — THE METRC PACKAGE STEP. Every batch gets exactly one of these,
// with or without a recipe, because there is no such thing as a compliant batch
// whose output METRC has never heard of. It is where the batch stops being a
// plan and becomes a tracked package: the operator records the tag they are
// assigning to the bulk output plus what was actually made, and signing it makes
// CannaQMS create that package in METRC from the batch's own source package.
//
// Placed at sortOrder -1 so it sorts ahead of any recipe step. Jonathan's rule
// is that it happens once the bulk source product is finished but before Testing
// — the recipe's own steps sequence around it, and the Testing transition is
// gated on it being signed, which is what actually enforces the ordering.
//
// The blanks are exactly METRC's minimum for a package create, minus what we
// already hold: the source package and the amount drawn come from the batch's
// cannabis ingredient lines (never re-asked — Session 08-17), the packaged date
// comes from the batch, and the production batch number is the tag itself.
const METRC_PACKAGE_STEP_KIND = "metrc_package";
const METRC_PACKAGE_STEP = {
  stepKind: METRC_PACKAGE_STEP_KIND,
  stepNumber: 0,
  sortOrder: -1,
  description: "Assign METRC package (bulk output)",
  template:
    "{baker} assigned METRC tag {new_package_tag} to the bulk output of this batch — {quantity} {uom} of item \"{item}\", placed in {location} — and created the package in METRC from this batch's source package.",
  instructions:
    "Record the NEW, unused METRC tag you are assigning to this batch's bulk output, what was actually made, the METRC item name exactly as it appears in your facility catalog, and the storage location. Signing this step creates the package in METRC and makes this tag the batch number. The source package and the amount drawn from it come from the Ingredients tab — do not re-enter them here.",
} as const;

// Session 63 — map a recipe's productType onto the batch process_type
// discriminator. The dialog sets this client-side when a recipe is picked;
// this is the safety net for non-UI callers (or any caller that sends a
// recipeId without an explicit processType) so a Concentrate recipe never
// silently opens under the Kitchen default. Unlisted types → Kitchen GMP.
const PRODUCT_TYPE_TO_PROCESS_TYPE: Record<string, string> = {
  "Flower": "Cultivation",
  "Concentrate": "Inhalants",
  "Vape Cartridge": "Inhalants",
  // CRA 2026-07-28 dual chamber vape cart — assembled from bulk concentrate, so
  // it routes through the Inhalants process like any vape cartridge.
  "Dual Chamber Vape Cartridge": "Inhalants",
  "Pre-Roll": "Pre-roll",
  // Session 82 — infused pre-rolls are assembled like pre-rolls (cones, count)
  // but MI classifies them as concentrates for testing/labeling; that routing
  // is keyed off productType, so the process_type stays Pre-roll here.
  "Infused Pre-Roll": "Pre-roll",
};
function processTypeForProductType(productType: string | null | undefined): string {
  return PRODUCT_TYPE_TO_PROCESS_TYPE[(productType ?? "").trim()] ?? "Kitchen";
}

// METRC tag formats are NOT consistent across states (this system is
// multi-state by design), so we do NOT enforce a fixed format. METRC package
// IDs (output) and ingredient/lot tags (input) are stored as the user enters
// them, trimmed only. Correctness is the user's responsibility.

// Session 45 — shape of an inline BOM row sent at batch open. Operators can
// either pick a recipe (server seeds via recipeItemsTable) OR list planned
// ingredients inline. The two paths are mutually exclusive: if a recipeId is
// present we ignore plannedIngredients to keep one source of truth.
type PlannedIngredient = {
  ingredientName?: string;
  plannedQuantity?: number | string | null;
  unitOfMeasure?: string;
  kind?: string;
};
function normalizePlannedIngredients(input: unknown): Array<{
  ingredientName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string;
  kind: string;
}> {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw): PlannedIngredient => (raw && typeof raw === "object" ? raw as PlannedIngredient : {}))
    .map((r) => {
      const name = typeof r.ingredientName === "string" ? r.ingredientName.trim() : "";
      const qRaw = r.plannedQuantity;
      const q = typeof qRaw === "number" ? qRaw
        : typeof qRaw === "string" && qRaw.trim() !== "" ? Number(qRaw)
        : null;
      const uom = typeof r.unitOfMeasure === "string" && r.unitOfMeasure ? r.unitOfMeasure : "g";
      const kind = normalizeBomKind(r.kind);
      return { ingredientName: name, plannedQuantity: Number.isFinite(q ?? NaN) ? (q as number) : null, unitOfMeasure: uom, kind };
    })
    .filter((r) => r.ingredientName.length > 0);
}

// The METRC package tag IS the batch number — the two are one identifier (a
// batch is identified by its METRC tag, not a separate arbitrary number). When
// no real tag exists yet, the batch still needs a stable, audit-safe handle, so
// we assign a clearly-synthetic placeholder that can never be mistaken for a
// genuine state METRC tag: IMPORT-###### for paper-record imports, PENDING-######
// for batches opened in-app before a tag is assigned. The real tag promotes into
// the batch number when the form-change process step is SIGNED — METRC issues the
// tag, and the sign handler writes it to both metrc_package_id and batch_number.
// (Until 2026-09-06 the generic PATCH did that promotion off a hand-typed value,
// which is how batches 28 and 29 got stamped with tags METRC never issued.) Each
// prefix has its own consecutive sequence (MAX existing of that prefix + 1).
// Placeholders live ONLY in batch_number; metrc_package_id stays null until a
// genuine tag exists, so "Not Linked" stays honest and no synthetic value is
// ever stored where a real state tag belongs.

async function generatePlaceholder(prefix: "IMPORT" | "PENDING"): Promise<string> {
  const rows = await db
    .select({ batchNumber: batchRecordsTable.batchNumber })
    .from(batchRecordsTable);
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let maxSeq = 0;
  for (const r of rows) {
    const m = (r.batchNumber ?? "").trim().match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}-${String(maxSeq + 1).padStart(6, "0")}`;
}

router.get("/batch-records", async (req, res) => {
  try {
    let rows = await db.select().from(batchRecordsTable).orderBy(batchRecordsTable.createdAt);
    const { status } = req.query;
    if (status) rows = rows.filter((r) => r.status === status);
    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list batches");
    res.status(500).json({ error: "Failed to list batches" });
  }
});

router.post("/batch-records", async (req, res) => {
  // Declared out here so the catch below can name the offending tag in the
  // duplicate-batch-number message.
  let realStartTag: string | null = null;
  try {
    // recipeId and plannedIngredients are transient — strip before insert.
    // Recipe path and inline BOM path are mutually exclusive; recipeId wins
    // when both are present so we keep a single source of truth for seeded
    // ingredients (matches operator expectations on the dialog).
    const { recipeId, plannedIngredients, autoMetrcPlaceholder, ...batchBody } = (req.body ?? {}) as Record<string, unknown>;
    // Session 62 — the recipe a batch runs drives operator competency: solo
    // step-signing requires the operator be Qualified for this recipe. Persist
    // it on the batch (the column added in Session 62 schema) so the /sign gate
    // can resolve it. Null on ad-hoc/inline-BOM batches → no gate.
    const recipeIdNum = typeof recipeId === "number" ? recipeId : (typeof recipeId === "string" && recipeId ? parseInt(recipeId) : null);
    if (recipeIdNum && Number.isFinite(recipeIdNum)) {
      // 2026-09-07 (Jonathan) — RECIPE RELEASE GATE. A batch may only link a
      // RELEASED recipe: "the in-process (and new) batches cannot link to a
      // recipe until the recipe has been released / made effective." A recipe
      // is released when its linked work instruction is Effective, so a recipe
      // can be drafted alongside its WI and neither is usable until the document
      // comes into force. Refused BEFORE the insert — a batch that opened
      // against an unreleased procedure would already be a record.
      const release = await getRecipeRelease(recipeIdNum);
      if (!release.released) {
        res.status(409).json({ error: release.reason });
        return;
      }
      batchBody.recipeId = recipeIdNum;
    }

    // Session 36 — validate process_type if provided. Otherwise the schema
    // default ("Kitchen") covers it.
    const processTypeProvided =
      Object.prototype.hasOwnProperty.call(batchBody, "processType") &&
      typeof batchBody.processType === "string" &&
      (batchBody.processType as string).trim() !== "";
    if (processTypeProvided) {
      const pt = batchBody.processType as string;
      if (!BATCH_PROCESS_TYPES.has(pt)) {
        res.status(400).json({
          error: `Invalid process_type "${pt}". Must be one of: Cultivation, Kitchen, Inhalants, Pre-roll.`,
        });
        return;
      }
    } else if (recipeIdNum && Number.isFinite(recipeIdNum)) {
      // Session 63 — caller sent a recipe but no process_type. Derive it from
      // the recipe's productType so concentrate batches don't fall back to the
      // Kitchen schema default. The dialog sets processType itself, so this
      // only fires for API/non-UI callers.
      const [rec] = await db.select({ productType: recipesTable.productType })
        .from(recipesTable).where(eq(recipesTable.id, recipeIdNum));
      if (rec) batchBody.processType = processTypeForProductType(rec.productType);
    }

    // METRC tag is optional and unformatted — formats vary by state, so we
    // store whatever the user enters (trimmed); empty becomes null. The tag the
    // operator assigns at the START of the process (when cannabis enters the bulk
    // mixture) is the one that becomes the batch number below.
    if (typeof batchBody.metrcPackageId === "string") {
      batchBody.metrcPackageId = batchBody.metrcPackageId.trim() || null;
    }
    // The batch number IS the process-start METRC tag. If a real tag was supplied
    // at open, use it. Otherwise stamp a clearly-synthetic placeholder so the
    // batch still has a stable handle — IMPORT-###### for paper-record imports,
    // PENDING-###### for in-app opens. The real tag promotes into the batch
    // number later (PATCH) the first time one is entered; the metrc_package_id
    // field itself stays null until a genuine tag exists (so "Not Linked" stays
    // honest and no synthetic value is ever mistaken for a state tag).
    realStartTag = (batchBody.metrcPackageId as string | null) ?? null;
    const batchNumber = realStartTag
      ? realStartTag
      : await generatePlaceholder(autoMetrcPlaceholder === true ? "IMPORT" : "PENDING");

    const [batch] = await db.insert(batchRecordsTable).values({ ...batchBody, batchNumber } as never).returning();
    void writeAuditLog({
      rowId: batch.id,
      operation: "INSERT",
      changedByName: (batchBody as Record<string, unknown>).operatorName as string ?? null,
      afterState: batch as unknown as Record<string, unknown>,
    });
    let seededFromRecipe = 0;
    let seededFromBom = 0;
    if (recipeIdNum && Number.isFinite(recipeIdNum)) {
      try {
        const [recipeRow] = await db.select({ referenceUnitCount: recipesTable.referenceUnitCount })
          .from(recipesTable).where(eq(recipesTable.id, recipeIdNum));
        const items = await db.select().from(recipeItemsTable)
          .where(eq(recipeItemsTable.recipeId, recipeIdNum))
          .orderBy(asc(recipeItemsTable.sortOrder), asc(recipeItemsTable.id));
        if (items.length > 0) {
          // Session 82 follow-up — recipe item quantities are authored for the
          // recipe's REFERENCE batch size (recipes.referenceUnitCount; seed recipes
          // = 100, e.g. 100 g flower → 100 cones). Scale each to THIS batch by
          // Scheduled Output ÷ reference count, so any batch size pulls the right
          // amount: a 100-count recipe → 300 g flower / 300 cones on a 300-count
          // batch. A recipe authored per-unit (referenceUnitCount = 1, 0.5 g/unit)
          // yields 0.5 × output — the same ratio math, so both conventions work.
          //
          // Only scales for COUNT output (unit = "units"). Bulk cannabis produced
          // by WEIGHT/VOLUME (bulk flower to retail, distillate yield from crude)
          // has a mass output, not a unit count, so it's left unscaled until the
          // weight-yield model lands.
          const refCount = recipeRow?.referenceUnitCount && recipeRow.referenceUnitCount > 0
            ? recipeRow.referenceUnitCount
            : 100;
          const isCountOutput = (batch.unitOfMeasure ?? "").trim().toLowerCase() === "units";
          const scale = isCountOutput && typeof batch.scheduledOutputQuantity === "number" && batch.scheduledOutputQuantity > 0
            ? batch.scheduledOutputQuantity / refCount
            : null;
          await db.insert(batchIngredientsTable).values(items.map(it => ({
            batchId: batch.id,
            ingredientName: it.ingredientName,
            plannedQuantity: it.plannedQuantity != null && scale != null
              ? it.plannedQuantity * scale
              : (it.plannedQuantity ?? null),
            unitOfMeasure: it.unitOfMeasure ?? "g",
            kind: it.kind ?? "Ingredient",
          })));
          seededFromRecipe = items.length;
        }
        // Session 59 — copy the recipe's approved process steps onto the batch
        // so the baker has the bake/temp/time instructions and can e-sign each.
        // recipeStepId points back to the master for traceability.
        const steps = await db.select().from(recipeProcessStepsTable)
          .where(eq(recipeProcessStepsTable.recipeId, recipeIdNum))
          .orderBy(asc(recipeProcessStepsTable.sortOrder), asc(recipeProcessStepsTable.id));
        if (steps.length > 0) {
          await db.insert(batchProcessStepsTable).values(steps.map((s) => ({
            batchId: batch.id,
            recipeStepId: s.id,
            stepNumber: s.stepNumber,
            description: s.description,
            template: s.template,
            instructions: s.instructions,
            sortOrder: s.sortOrder,
          })));
        }
      } catch (e) {
        req.log.error({ err: e, batchId: batch.id, recipeId: recipeIdNum }, "Recipe seeding failed (batch kept)");
      }
    } else {
      // Session 45 — inline BOM at batch open. Only seeds if there are valid
      // rows after normalization (empty/junk rows are dropped silently). Wrapped
      // in try/catch like the recipe path: a BOM-seeding failure must NEVER lose
      // the batch the operator just opened.
      const bomRows = normalizePlannedIngredients(plannedIngredients);
      if (bomRows.length > 0) {
        try {
          await db.insert(batchIngredientsTable).values(bomRows.map((r) => ({
            batchId: batch.id,
            ingredientName: r.ingredientName,
            plannedQuantity: r.plannedQuantity,
            unitOfMeasure: r.unitOfMeasure,
            kind: r.kind,
          })));
          seededFromBom = bomRows.length;
        } catch (e) {
          req.log.error({ err: e, batchId: batch.id }, "BOM seeding failed (batch kept)");
        }
      }
    }

    // 2026-08-19 — seed the METRC package step onto EVERY batch, outside the
    // recipe/BOM branches above, because it is not a manufacturing instruction
    // that a recipe author chose: it is the point at which this batch becomes a
    // tracked package, and it applies whether or not anyone wrote a recipe.
    // Seeded even when the caller supplied a tag at open, so the tag is always
    // signed for by a named person rather than typed into a dialog by nobody.
    // Wrapped like the seeders above — a failure here must not lose the batch
    // the operator just opened; the Testing gate still refuses to advance, so a
    // missing step surfaces as a blocked transition rather than a silent hole.
    try {
      await db.insert(batchProcessStepsTable).values({
        batchId: batch.id,
        stepKind: METRC_PACKAGE_STEP.stepKind,
        stepNumber: METRC_PACKAGE_STEP.stepNumber,
        sortOrder: METRC_PACKAGE_STEP.sortOrder,
        description: METRC_PACKAGE_STEP.description,
        template: METRC_PACKAGE_STEP.template,
        instructions: METRC_PACKAGE_STEP.instructions,
      });
    } catch (e) {
      req.log.error({ err: e, batchId: batch.id }, "METRC package step seeding failed (batch kept)");
    }

    res.status(201).json({ ...batch, seededFromRecipe, seededFromBom });
  } catch (err) {
    // batch_records.batch_number is UNIQUE, and the batch number IS the
    // process-start METRC tag. Re-using a tag is an ordinary operator mistake,
    // not a server fault — it surfaced as a bare "Failed to create batch" with
    // no hint that the tag was the problem. Name the tag and say what to do.
    if ((err as { code?: string }).code === "23505") {
      req.log.warn({ err, realStartTag }, "Batch create rejected — batch number already in use");
      res.status(409).json({
        error: realStartTag
          ? `METRC tag ${realStartTag} is already the batch number for another batch. Enter a different tag, or leave the field blank to open with a provisional number.`
          : "That batch number is already in use. Leave the METRC tag blank to open with a provisional number.",
      });
      return;
    }
    req.log.error({ err }, "Failed to create batch");
    res.status(500).json({ error: "Failed to create batch" });
  }
});

router.get("/batch-records/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    res.json(batch);
  } catch (err) {
    req.log.error({ err }, "Failed to get batch");
    res.status(500).json({ error: "Failed to get batch" });
  }
});

router.patch("/batch-records/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Batch not found" }); return; }
    // Spec linkage fields are managed only via dedicated /link-spec endpoints
    // so that the immutable snapshot (Part 11) cannot be tampered with by
    // generic PATCH. Strip them defensively.
    const { specDocId: _sdi, specRevisionAtLink: _srl, specLinkedAt: _sla,
      specDocSnapshot: _sds, specSectionsSnapshot: _sss, ...safeBody } = (req.body ?? {}) as Record<string, unknown>;

    // Session 36 — validate process_type on PATCH if the client tried to
    // change it. Operators can re-classify legacy "Kitchen"-defaulted rows
    // via this path; the validation catches typos and stray values.
    if (Object.prototype.hasOwnProperty.call(safeBody, "processType")) {
      const pt = safeBody.processType as string;
      if (!BATCH_PROCESS_TYPES.has(pt)) {
        res.status(400).json({
          error: `Invalid process_type "${pt}". Must be one of: Cultivation, Kitchen, Inhalants, Pre-roll.`,
        });
        return;
      }
    }

    // 2026-09-06 — the generic batch PATCH NO LONGER SETS THE METRC TAG.
    //
    // It used to accept metrcPackageId and, when the batch number was still a
    // synthetic PENDING-/IMPORT- placeholder, promote the typed tag into the batch
    // number. That was written for imported batches whose package already existed
    // in METRC, but the same field was editable on the Overview tab of a brand new
    // batch, and nothing checked that METRC had ever issued the tag. Typing one
    // stamped the batch with a number the state system had never heard of and then
    // blocked the one step whose job is to create that package. Batches 28 (09-03)
    // and 29 (09-04) both died that way, and there is no screen that clears the
    // column again.
    //
    // The tag now has exactly ONE way in on an existing batch: sign the form-change
    // process step (stepKind = 'metrc_package'), which creates the package in METRC
    // and writes back the tag METRC actually issued — see the create-package handler
    // below, which also does the batch-number promotion. An IMPORTED batch still
    // supplies its pre-existing tag at batch CREATION, which is a separate path and
    // is untouched.
    //
    // A no-op echo is tolerated (a screen round-tripping the batch object it read
    // is not trying to change anything); an actual CHANGE is refused with an
    // explanation rather than silently dropped, so a caller is never left believing
    // it set something it did not.
    if (Object.prototype.hasOwnProperty.call(safeBody, "metrcPackageId")) {
      const raw = safeBody.metrcPackageId;
      const next = typeof raw === "string" ? (raw.trim() || null) : (raw === null ? null : undefined);
      const current = (before.metrcPackageId ?? "") || null;
      if (next !== undefined && next !== current) {
        res.status(409).json({
          error:
            "The METRC package tag can't be set here. It is recorded by signing the "
            + "form-change step on the Process Steps tab, which creates the package in "
            + "METRC and writes back the tag METRC issues.",
        });
        return;
      }
      delete safeBody.metrcPackageId;
    }

    // Guard: a batch cannot advance to "testing_in_progress" until its bill of
    // materials is COMPLETE and every line has verifiable PROVENANCE. Skipping
    // or fabricating the Ingredients section makes the batch record non-compliant
    // with R 420.504 traceability. Three checks, in order, each with a specific
    // message so the operator knows exactly what to fix. Server-side guard is the
    // source of truth; the UI should disable the button but cannot be relied on.
    //
    //   1. EMPTY      — no ingredient/material rows at all.
    //   2. COMPLETE   — every recorded line has both a lot number AND a recorded
    //                   actual quantity (> 0). A seeded recipe BOM row that the
    //                   operator never filled in is caught here.
    //   3. PROVENANCE — every line's lot resolves to a real lot in the ledger
    //                   that came in through receiving/inspection (origin
    //                   received/manual/split/merged) or is a released
    //                   intermediate (produced + available_as_ingredient), and is
    //                   not Quarantined/Recalled/Expired. A free-typed lot string
    //                   that matches no inspected lot is rejected here — this is
    //                   what forces "pick the lot from inventory". Consumed lots
    //                   pass (the ingredients may already have been committed via
    //                   the Step 3 e-signature, which draws the lot down to 0).
    const nextStatus = typeof safeBody.status === "string" ? safeBody.status : undefined;
    // FG-3 (2026-07-06) — the finished-goods transition must go through the
    // dedicated confirm endpoint (records Metrc package tags + Supervisor+ e-sig).
    // Previously this generic PATCH could flip to finished_goods with no gate.
    if (nextStatus === "finished_goods" && before.status !== "finished_goods") {
      res.status(409).json({
        error: "Use the \"Confirm as Finished Goods\" action — it records the METRC package tags and requires a Supervisor+ e-signature.",
      });
      return;
    }
    if (nextStatus === "testing_in_progress" && before.status !== "testing_in_progress") {
      const allRows = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, id));
      // Packaging & label lines (cartons, cartridges, cones, containers, pouches,
      // compliance labels, etc.) are applied at/after packaging — the label
      // carries the test results — and may not carry a lot number or expiry, so
      // they must NOT block Testing. They're recorded either as kind
      // "Material"/"Packaging" OR (compliance labels especially) as a plain
      // "Ingredient" row, so we match on kind AND on the item name. Only the
      // consumable ingredient lines must be lotted + provenanced at this gate;
      // packaging/label lots are enforced later, at packaging/release.
      // (Fix 2026-08-12 — Jonathan: a Pre-Roll compliance label kept blocking
      // Testing because it was stored as an Ingredient-kind row.)
      const PKG_LABEL_RE = /\b(label|carton|box|container|cone|cartridge|mouth-?piece|cap|lid|jar|bag|pouch|sticker|insert|packag\w*|shrink|band|tube|vial|clamshell|seal|closure)\b/i;
      const ingRows = allRows.filter((r) => {
        const kind = r.kind ?? "Ingredient";
        if (kind === "Material" || isPackagingStageKind(kind)) return false;
        if (PKG_LABEL_RE.test(r.ingredientName ?? "")) return false;
        return true;
      });
      if (ingRows.length === 0) {
        res.status(409).json({
          error: "Cannot advance to Testing — no ingredients recorded. Record each ingredient (with its lot and actual amount used) before submitting samples. Packaging and labels are recorded later.",
        });
        return;
      }
      const incomplete = ingRows.filter((r) => !((r.lotNumber ?? "").trim()) || !(Number(r.actualQuantity) > 0));
      if (incomplete.length > 0) {
        const names = incomplete.map((r) => r.ingredientName).join(", ");
        res.status(409).json({
          error: `Cannot advance to Testing — these ingredient lines are missing a lot number and/or a recorded quantity: ${names}. Record each one (with its lot and actual amount used) before submitting samples.`,
        });
        return;
      }
      const lotNumbers = Array.from(new Set(ingRows.map((r) => (r.lotNumber ?? "").trim()).filter(Boolean)));
      const ledgerLots = lotNumbers.length
        ? await db.select().from(lotsTable).where(inArray(lotsTable.lotNumber, lotNumbers))
        : [];
      const lotByNumber = new Map(ledgerLots.map((l) => [l.lotNumber, l]));
      const okStatus = new Set(["Active", "Consumed"]);
      const okOrigin = new Set(["received", "manual", "split", "merged"]);
      const badProvenance = ingRows.filter((r) => {
        const lot = lotByNumber.get((r.lotNumber ?? "").trim());
        if (!lot || !okStatus.has(lot.status)) return true;
        // produced lots only count once released as an ingredient
        if (lot.origin === "produced") return lot.availableAsIngredient !== true;
        return !okOrigin.has(lot.origin);
      });
      if (badProvenance.length > 0) {
        const detail = badProvenance.map((r) => `${r.ingredientName} (lot ${(r.lotNumber ?? "").trim() || "—"})`).join(", ");
        res.status(409).json({
          error: `Cannot advance to Testing — these lines are not tied to an active, inspected lot: ${detail}. Each ingredient/material must be drawn from a received (inspected) lot or a released intermediate — pick the lot from inventory rather than typing it.`,
        });
        return;
      }

      // 2026-08-19 — the bulk output must exist in METRC before samples are
      // submitted. Jonathan's placement: the METRC package step happens once the
      // bulk source product is finished and before Testing, so this transition is
      // what enforces the ordering. Checked last, after the ingredient gates
      // above, because the step cannot be signed until those lines are recorded —
      // telling someone to sign it first would send them in a circle.
      const [metrcStep] = await db.select().from(batchProcessStepsTable)
        .where(and(eq(batchProcessStepsTable.batchId, id), eq(batchProcessStepsTable.stepKind, METRC_PACKAGE_STEP_KIND)));
      if (metrcStep && !metrcStep.completed) {
        res.status(409).json({
          error: metrcStep.cosignRequired
            ? `Cannot advance to Testing — "${metrcStep.description}" is signed but still needs a supervisor co-sign.`
            : `Cannot advance to Testing — sign "${metrcStep.description}" on the Process Steps tab first. That step creates this batch's package in METRC; until it is signed the state has no record of what this batch made.`,
        });
        return;
      }
      // A batch opened before this step existed has no row to sign, so fall back
      // to the fact the step is meant to guarantee: a METRC tag on the batch.
      if (!metrcStep && !(before.metrcPackageId ?? "").trim()) {
        res.status(409).json({
          error: "Cannot advance to Testing — this batch has no METRC package. Record the bulk package tag on the batch before submitting samples.",
        });
        return;
      }
    }

    // 2026-09-11 (Jonathan) — A BATCH MAY NOT READ "PASSED" WITH NO TEST RECORD.
    // Found live on batch AAA05030000213A000001142: the status moved to
    // passed_awaiting_packaging with ZERO rows in batch_testing, so the record
    // said the product had passed compliance testing when nothing had been
    // recorded at all. Shipping was still blocked further downstream — the
    // manifest pre-flight checks for a passing result — but the batch record
    // itself is the document an inspector reads, and it was not true.
    // His ruling when asked block or warn: "For A11, blocked."
    if (nextStatus === "passed_awaiting_packaging" && before.status !== "passed_awaiting_packaging") {
      const rows = await db.select({ testResult: batchTestingTable.testResult })
        .from(batchTestingTable).where(eq(batchTestingTable.batchId, id));
      const passing = rows.filter((r) => String(r.testResult ?? "").trim().toLowerCase() === "pass");
      if (passing.length === 0) {
        res.status(409).json({
          error: rows.length === 0
            ? "Cannot mark this batch Passed — no laboratory result is recorded. Record the result on the Testing tab first (R 420.305)."
            : `Cannot mark this batch Passed — ${rows.length} test record(s) exist but none reads Pass. Record the passing result on the Testing tab first (R 420.305).`,
        });
        return;
      }
    }

    const [batch] = await db.update(batchRecordsTable).set({ ...safeBody, updatedAt: new Date() }).where(eq(batchRecordsTable.id, id)).returning();
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    // Session 100 — attribute the edit to the signed-in user (Part 11) instead
    // of leaving changedByName null, which renders as "System".
    const auditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: auditActor?.id ?? null,
      changedByName: auditActor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: batch as unknown as Record<string, unknown>,
    });
    res.json(batch);
  } catch (err) {
    req.log.error({ err }, "Failed to update batch");
    res.status(500).json({ error: "Failed to update batch" });
  }
});

// ── Spec linkage (Print Batch Record) ─────────────────────────────────────────
//
// Only Approved Specification documents may be linked. The spec's revision is
// snapshotted at link time so reprints stay reproducible (Part 11) even after
// the spec is later revised. Linking is locked once the batch is released.

router.post("/batch-records/:id/link-spec", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const specDocIdRaw = (req.body as { specDocId?: unknown })?.specDocId;
    const specDocId = typeof specDocIdRaw === "number" ? specDocIdRaw
      : typeof specDocIdRaw === "string" ? parseInt(specDocIdRaw) : NaN;
    if (!Number.isFinite(specDocId)) {
      res.status(400).json({ error: "specDocId is required" });
      return;
    }
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    if (batch.status === "released_to_inventory") {
      res.status(409).json({ error: "Spec linkage is locked after batch release." });
      return;
    }
    const [spec] = await db.select().from(documentsTable).where(eq(documentsTable.id, specDocId));
    if (!spec) { res.status(404).json({ error: "Document not found" }); return; }
    // Session 61 — Work Instruction docs are now linkable too (not just
    // Specification), so a batch can prove which approved WI revision it ran.
    if (spec.documentType !== "Specification" && spec.documentType !== "Work Instruction") {
      res.status(400).json({ error: "Only Specification or Work Instruction documents can be linked." });
      return;
    }
    if (spec.status !== "Approved" && spec.status !== "Effective") {
      res.status(400).json({ error: "Only Approved or Effective documents can be linked." });
      return;
    }
    const sections = await db.select().from(documentSectionsTable)
      .where(eq(documentSectionsTable.documentId, spec.id))
      .orderBy(asc(documentSectionsTable.sortOrder), asc(documentSectionsTable.id));
    // Session 61 — if the linked doc is backed by a recipe, snapshot its process
    // steps at link time (the WI provenance: "ran against approved revision X").
    const specRecipeId = (spec as { recipeId?: number | null }).recipeId ?? null;
    const procSteps = specRecipeId
      ? await db.select().from(recipeProcessStepsTable)
          .where(eq(recipeProcessStepsTable.recipeId, specRecipeId))
          .orderBy(asc(recipeProcessStepsTable.sortOrder), asc(recipeProcessStepsTable.stepNumber), asc(recipeProcessStepsTable.id))
      : [];
    // Conditional update: only succeeds if the batch is still not released.
    // This closes the link-vs-release race.
    const updatedRows = await db.update(batchRecordsTable).set({
      specDocId: spec.id,
      specRevisionAtLink: spec.revision,
      specLinkedAt: new Date(),
      specDocSnapshot: {
        id: spec.id,
        docNumber: spec.docNumber,
        title: spec.title,
        revision: spec.revision,
        approvedByName: (spec as { approvedByName?: string | null }).approvedByName ?? null,
        approvalDate: (spec as { approvalDate?: Date | string | null }).approvalDate
          ? String((spec as { approvalDate: Date | string }).approvalDate)
          : null,
      },
      specSectionsSnapshot: sections.map(s => ({
        id: s.id, sortOrder: s.sortOrder, kind: s.kind, title: s.title, bodyMarkdown: s.bodyMarkdown,
      })),
      specProcessStepsSnapshot: procSteps.length
        ? procSteps.map(s => ({ id: s.id, stepNumber: s.stepNumber, sortOrder: s.sortOrder, description: s.description, template: s.template }))
        : null,
      updatedAt: new Date(),
    }).where(and(eq(batchRecordsTable.id, id), ne(batchRecordsTable.status, "released_to_inventory"))).returning();
    if (updatedRows.length === 0) {
      res.status(409).json({ error: "Spec linkage is locked after batch release." });
      return;
    }
    // Session 100 (option a) — a linked procedure should drive the interactive
    // Process Steps tab, not just the print snapshot. If the linked WI/spec is
    // recipe-backed with process steps AND the batch has none recorded yet, copy
    // them onto the batch so the operator can execute + e-sign each. We NEVER
    // clobber existing steps — a batch may already have signed steps (Part 11).
    let processStepsSeeded = 0;
    if (procSteps.length > 0) {
      const existingSteps = await db.select({ id: batchProcessStepsTable.id })
        .from(batchProcessStepsTable).where(eq(batchProcessStepsTable.batchId, id));
      if (existingSteps.length === 0) {
        await db.insert(batchProcessStepsTable).values(procSteps.map((s) => ({
          batchId: id,
          recipeStepId: s.id,
          stepNumber: s.stepNumber,
          description: s.description,
          template: s.template,
          instructions: s.instructions,
          sortOrder: s.sortOrder,
        })));
        processStepsSeeded = procSteps.length;
      }
    }
    await writeAuditLog({
      rowId: id,
      operation: "LINK_SPEC",
      beforeState: { specDocId: batch.specDocId, specRevisionAtLink: batch.specRevisionAtLink },
      afterState: { specDocId: spec.id, specRevisionAtLink: spec.revision, docNumber: spec.docNumber, documentType: spec.documentType, sectionCount: sections.length, processStepCount: procSteps.length, processStepsSeeded },
    });
    res.json(updatedRows[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to link spec");
    res.status(500).json({ error: "Failed to link spec" });
  }
});

router.delete("/batch-records/:id/link-spec", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    if (batch.status === "released_to_inventory") {
      res.status(409).json({ error: "Spec linkage is locked after batch release." });
      return;
    }
    const updatedRows = await db.update(batchRecordsTable).set({
      specDocId: null,
      specRevisionAtLink: null,
      specLinkedAt: null,
      specDocSnapshot: null,
      specSectionsSnapshot: null,
      specProcessStepsSnapshot: null,
      updatedAt: new Date(),
    }).where(and(eq(batchRecordsTable.id, id), ne(batchRecordsTable.status, "released_to_inventory"))).returning();
    if (updatedRows.length === 0) {
      res.status(409).json({ error: "Spec linkage is locked after batch release." });
      return;
    }
    await writeAuditLog({
      rowId: id,
      operation: "UNLINK_SPEC",
      beforeState: { specDocId: batch.specDocId, specRevisionAtLink: batch.specRevisionAtLink },
      afterState: { specDocId: null },
    });
    res.json(updatedRows[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to unlink spec");
    res.status(500).json({ error: "Failed to unlink spec" });
  }
});

// Spec snapshot for the print view — ALWAYS served from the immutable
// snapshot stored on the batch at link time, never from the live spec or
// document_sections (Part 11 reproducibility).
router.get("/batch-records/:id/spec-snapshot", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    if (!batch.specDocId || !batch.specDocSnapshot) {
      res.json({ spec: null, sections: [], processSteps: [], revisionAtLink: null, linkedAt: null });
      return;
    }
    res.json({
      spec: batch.specDocSnapshot,
      sections: batch.specSectionsSnapshot ?? [],
      processSteps: batch.specProcessStepsSnapshot ?? [],
      revisionAtLink: batch.specRevisionAtLink,
      linkedAt: batch.specLinkedAt,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load spec snapshot");
    res.status(500).json({ error: "Failed to load spec snapshot" });
  }
});

// Session 39 (Tier 3 #12f) — Batch release is gated to APPROVER_ROLES
// (Supervisor / Manager / Quality / Admin). Operators can flip the batch
// through earlier statuses but cannot release to inventory — that requires
// an approver-eligible signer. The actor is resolved from the Clerk session
// rather than trusted from the request body, so a downgraded user can't
// pass a stale `userId` to bypass the check. Initials are validated against
// the actor's recorded initials (Part 11 surface check, matching Gate 1).
const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// One-time backfill: compute + store expiration for already-released batches
// that predate the stored-expiration feature (same basis as release). Admin only.
router.post("/batch-records/backfill-expiration", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") { res.status(403).json({ error: "Admin only." }); return; }
    const all = await db.select().from(batchRecordsTable);
    let updated = 0;
    for (const b of all) {
      if (b.status !== "released_to_inventory" && b.status !== "finished_goods") continue;
      if (b.expirationDate != null) continue;
      const testRows = await db.select({ resultDate: batchTestingTable.resultDate, testResult: batchTestingTable.testResult, sequenceNumber: batchTestingTable.sequenceNumber })
        .from(batchTestingTable).where(eq(batchTestingTable.batchId, b.id));
      const passing = testRows
        .filter((t) => t.testResult === "Pass" && t.resultDate)
        .sort((x, y) => (y.sequenceNumber ?? 0) - (x.sequenceNumber ?? 0));
      const baseDate = (passing[0]?.resultDate as unknown as string | undefined) ?? (b.productionDate ? String(b.productionDate) : null);
      const [ps] = await db.select().from(productTypeSettingsTable).where(eq(productTypeSettingsTable.productType, b.productType ?? ""));
      const exp = computeExpirationDate(b.productType, baseDate, ps?.shelfLifeDays ?? null);
      if (exp) { await db.update(batchRecordsTable).set({ expirationDate: exp }).where(eq(batchRecordsTable.id, b.id)); updated += 1; }
    }
    res.json({ ok: true, updated });
  } catch (err) {
    req.log.error({ err }, "Backfill expiration failed");
    res.status(500).json({ error: "Backfill failed" });
  }
});

router.post("/batch-records/:id/release", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({
        error: `Batch release requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".`,
      });
      return;
    }
    const { initials, signingMeaning } = req.body as { initials?: string; signingMeaning?: string };
    if (!initials?.trim() || !signingMeaning?.trim()) {
      res.status(400).json({ error: "Initials and signing meaning are required (21 CFR Part 11)" }); return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." });
      return;
    }
    const [before] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Batch not found" }); return; }


    // R 420.304(2)(k) — sampled product is quarantined until passing results.
    {
      const blocked = await labSampleQuarantineBlock(id, "released");
      if (blocked) { res.status(409).json({ error: blocked }); return; }
    }

    // 2026-08-10 — units produced must be recorded before a batch can be
    // released, so no released batch sits in inventory with a blank output.
    // The department lead enters it (with cases/cartons) on the Packaging tab.
    if (before.outputQuantity == null || before.outputQuantity <= 0) {
      res.status(400).json({ error: "Record the units produced on the Packaging tab before releasing this batch." });
      return;
    }

    // 2026-08-13 — INGREDIENT DRAW-DOWN GATE. A batch cannot be released until
    // every recorded ingredient/material has been committed (drawn) from
    // inventory via the signed "Confirm ingredients" step. Without this, a batch
    // could reach Released with inventory never decremented (Batch 1125 slipped
    // through this way). Block on any line still under-drawn (actual > committed);
    // an edited-down line (committed > actual) is refunded at commit and is fine.
    //
    // 2026-09-07 (Jonathan) — PACKAGING AND LABELING LINES ARE EXEMPT. Tubes,
    // cartons, boxes and compliance labels are consumed at the PACKAGING stage,
    // which happens AFTER release: the compliance label carries the test
    // results, so it cannot be applied any earlier. Demanding they be drawn
    // from inventory before release asked the operator to consume packaging
    // they had not used yet. They are still drawn — by the same signed "Confirm
    // ingredients & remove from inventory" block, which also sits on the
    // Packaging tab — just not as a precondition of release.
    const ingredientRows = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, id));
    const undrawn = ingredientRows.filter((r) => {
      if (isPackagingStageKind(r.kind)) return false;
      const actual = r.actualQuantity ?? 0;
      const committed = r.lotCommittedQty ?? 0;
      return actual > 1e-9 && actual - committed > 1e-9;
    });
    if (undrawn.length > 0) {
      res.status(400).json({ error: `Confirm ingredients before releasing this batch — these lines have not been drawn from inventory yet: ${undrawn.map((r) => r.ingredientName).join(", ")}. Sign the "Confirm ingredients & remove from inventory" step on the Ingredients tab first.` });
      return;
    }

    // Dual Chamber Vape Cart (CRA MI_IB_0114) — EVERY required chamber must pass
    // before release. One failed chamber fails the whole device (you can't ship a
    // passing gram alongside a failing gram). Mirrors DualChamberTestingPanel.
    if (before.productType === "Dual Chamber Vape Cartridge") {
      let twoOils = false, combined = false, configKnown = false;
      if (before.recipeId != null) {
        const [recipe] = await db.select({ twoOils: recipesTable.dualChamberTwoOils, combined: recipesTable.dualChamberCombinedDraw })
          .from(recipesTable).where(eq(recipesTable.id, before.recipeId));
        if (recipe) { twoOils = recipe.twoOils === true; combined = recipe.combined === true; configKnown = recipe.twoOils != null; }
      }
      const requiredChambers = !configKnown ? ["A", "B", "C"]
        : !twoOils ? ["A"]
        : combined ? ["A", "B", "C"] : ["A", "B"];
      const rows = await db.select({ chamber: batchTestingTable.chamber, testResult: batchTestingTable.testResult, sequenceNumber: batchTestingTable.sequenceNumber })
        .from(batchTestingTable).where(eq(batchTestingTable.batchId, id));
      const chamberPassed = (code: string): boolean => {
        const cr = rows.filter((t) => (t.chamber ?? null) === code && (t.testResult === "Pass" || t.testResult === "Fail"));
        if (cr.length === 0) return false;
        const lastFailSeq = cr.filter((r) => r.testResult === "Fail").reduce((m, r) => Math.max(m, r.sequenceNumber ?? 0), -1);
        const passesSinceFail = cr.filter((r) => r.testResult === "Pass" && (r.sequenceNumber ?? 0) > lastFailSeq).length;
        return passesSinceFail >= (lastFailSeq >= 0 ? 2 : 1);
      };
      const label = (c: string) => (c === "C" ? "Combined draw (Chamber C)" : `Chamber ${c}`);
      const notPassed = requiredChambers.filter((c) => !chamberPassed(c));
      if (notPassed.length > 0) {
        res.status(409).json({ error: `Cannot release this Dual Chamber Vape Cartridge — every chamber must pass testing before release. Not yet passing: ${notPassed.map(label).join(", ")}. A single failed chamber fails the whole device.` });
        return;
      }
    }

    // 2026-08-19 — METRC EXISTENCE GATE. The batch number IS the METRC tag on
    // the bulk output, but nothing ever verified that tag is real: the create
    // dialog stores whatever text is typed. Batch ...1141 reached Released with
    // 100 units recorded and no such package in METRC — product the state cannot
    // see, which is the licensee's violation, not ours. Release now fails closed,
    // including when METRC can't be reached: unverifiable is not the same as
    // verified, and a facility that can't reach METRC can't lawfully move
    // material anyway (paper contingency covers the outage). Called through
    // getPackageByLabel directly rather than renderMetrc, which still answers
    // 200 on failure (known debt) and would make this gate worthless.
    // Runs last so the cheap local checks above reject first and only an
    // otherwise-releasable batch costs a network round trip.
    const startTag = before.metrcPackageId?.trim() || null;
    if (!startTag) {
      res.status(400).json({
        error: "This batch has no METRC tag, so there is nothing for METRC to confirm. Record the batch's METRC package tag before releasing.",
      });
      return;
    }
    const startPackage = await getPackageByLabel(startTag);
    if (!startPackage.ok) {
      // METRC answers 401 — not 404 — for a tag this facility doesn't hold.
      // Verified 2026-08-19 against the sandbox, same keys, back to back:
      // ...000058 (a real package) → 200 with the full record, while
      // ...001141 (a tag never created) → 401. So 401 and 404 both mean "we
      // don't have that package", and reporting 401 as an outage sent the
      // operator to check the network when the tag was the problem. Only 5xx,
      // network and unconfigured are genuine we-failed-to-ask outcomes.
      //
      // A revoked or mis-scoped key would also 401, which is why the message
      // names both possibilities rather than asserting the tag is wrong: a key
      // problem 401s EVERY package, so it shows up immediately and everywhere,
      // and either way this batch must not release.
      if (startPackage.status === 401 || startPackage.status === 404) {
        res.status(409).json({
          error: `METRC does not recognize package ${startTag} as belonging to this facility. This batch cannot be released — the units it produced are not tracked by the state. Either the METRC tag on this batch is wrong, or the package was never created in METRC. Create it from the Packaging tab first.`,
        });
      } else {
        res.status(503).json({
          error: `Cannot release — METRC could not be reached to confirm package ${startTag} (${startPackage.error}). Release stays blocked until METRC confirms the package exists.`,
        });
      }
      return;
    }

    // Lock the batch expiration at release (edibles R 420.403 — must not be
    // altered once set). Computed from the passing test result date + product-
    // type shelf life, the same basis as the label export. Keep any stored value.
    let lockedExpiration = before.expirationDate ?? null;
    if (lockedExpiration == null) {
      const testRows = await db.select({ resultDate: batchTestingTable.resultDate, testResult: batchTestingTable.testResult, sequenceNumber: batchTestingTable.sequenceNumber })
        .from(batchTestingTable).where(eq(batchTestingTable.batchId, id));
      const passing = testRows
        .filter((t) => t.testResult === "Pass" && t.resultDate)
        .sort((a, b) => (b.sequenceNumber ?? 0) - (a.sequenceNumber ?? 0));
      const baseDate = (passing[0]?.resultDate as unknown as string | undefined) ?? (before.productionDate ? String(before.productionDate) : null);
      const [ps] = await db.select().from(productTypeSettingsTable).where(eq(productTypeSettingsTable.productType, before.productType ?? ""));
      lockedExpiration = computeExpirationDate(before.productType, baseDate, ps?.shelfLifeDays ?? null);
    }

    const [batch] = await db.update(batchRecordsTable).set({
      status: "released_to_inventory",
      expirationDate: lockedExpiration,
      approvedBy: actor.id,
      approvalInitials: initials.trim().toUpperCase(),
      approvalName: actor.fullName,
      approvalDate: new Date(),
      // Session 66 (OQ-11) — persist the Part 11 meaning of signature on the record.
      approvalMeaning: signingMeaning.trim(),
      updatedAt: new Date(),
    }).where(eq(batchRecordsTable.id, id)).returning();
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    void writeAuditLog({
      rowId: id,
      operation: "RELEASE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: { ...(batch as unknown as Record<string, unknown>), signingMeaning: signingMeaning.trim() },
    });
    res.json(batch);
  } catch (err) {
    req.log.error({ err }, "Failed to release batch");
    res.status(500).json({ error: "Failed to release batch" });
  }
});

// FG-3 (2026-07-06) — Confirm as Finished Goods. Records the METRC package tags
// created for this batch's sellable units (as a batch_metrc_tags node: one
// 'range' for sequential tags, or 'single' rows for scanned/non-contiguous
// tags) and advances the batch released_to_inventory → finished_goods. Gated to
// APPROVER_ROLES (Supervisor+) with a Part 11 e-signature — the actual METRC
// write is done first by POST /metrc/packages/create-finished-goods; this step
// records the result locally so FG-2 reconciliation lights up. Idempotent-safe:
// if this fails after the METRC create, it can be retried without re-creating in
// METRC (recording the same tags is additive; correct via the Cancel pattern).
router.post("/batch-records/:id/confirm-finished-goods", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Confirming Finished Goods requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".` });
      return;
    }
    const body = (req.body ?? {}) as {
      initials?: string; signingMeaning?: string; sourceTag?: string;
      tags?: unknown; rangeStart?: string; rangeEnd?: string; rangeCount?: number;
      quantity?: number | string; uom?: string; stageLabel?: string; finalize?: boolean;
      metrcCreated?: boolean;
    };
    // Repeatable packaging (JIT). finalize=true (default = the original one-shot
    // behavior) closes the batch to Finished Goods. finalize=false records this
    // packaging run + its METRC tags but KEEPS the batch In Fulfillment
    // (released_to_inventory) so more units can be packaged later / per order.
    const finalize = body.finalize !== false;
    // The dialog creates the packages in METRC FIRST and only calls this route
    // after that write returns 2xx, so metrcCreated:true is a statement of fact,
    // not an intention. Stamping it here is what makes a real METRC package
    // distinguishable from a hand-typed tag string downstream.
    const metrcPackageCreatedAt = body.metrcCreated === true ? new Date() : null;
    const initials = (body.initials ?? "").trim();
    const signingMeaning = (body.signingMeaning ?? "").trim();
    if (!initials || !signingMeaning) {
      res.status(400).json({ error: "Initials and signing meaning are required (21 CFR Part 11)." }); return;
    }
    if (actor.initials && initials.toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }

    const [before] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Batch not found" }); return; }
    if (before.status === "finished_goods") { res.status(409).json({ error: "This batch is already Finished Goods." }); return; }
    if (before.status !== "released_to_inventory") {
      res.status(409).json({ error: `A batch can only be confirmed as Finished Goods from "Released to Inventory". Current status: "${before.status}".` }); return;
    }

    // R 420.304(2)(k) — sampled product is quarantined until passing results.
    {
      const blocked = await labSampleQuarantineBlock(id, "packaged");
      if (blocked) { res.status(409).json({ error: blocked }); return; }
    }


    // Tag input: a sequential range (start+end) OR a list of individual tags.
    const tagList = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
      : [];
    const rangeStart = (body.rangeStart ?? "").trim();
    const rangeEnd = (body.rangeEnd ?? "").trim();
    const hasRange = rangeStart !== "" && rangeEnd !== "";
    if (!hasRange && tagList.length === 0) {
      res.status(400).json({ error: "Provide the METRC tags for the finished units — either a tag range (rangeStart + rangeEnd) or a non-empty tags list." }); return;
    }
    // Duplicate guard for the individual-tags path.
    if (!hasRange) {
      const upper = tagList.map((t) => t.toUpperCase());
      if (new Set(upper).size !== upper.length) {
        res.status(400).json({ error: "Duplicate tags in the list — each finished unit needs a unique METRC tag." }); return;
      }
    }

    // Idempotency guard — a repeated Confirm (double-click, retry, or a resubmit
    // after the METRC packages were already created) must NOT log a second
    // identical packaging run. If an active (non-cancelled) run for the SAME tags
    // already exists on this batch, reject instead of duplicating. (Fix
    // 2026-08-12 — Jonathan: two identical 99-unit "Fulfillment packaging" runs
    // from a double submit.)
    {
      const existingRuns = await db.select().from(batchMetrcTagsTable).where(and(
        eq(batchMetrcTagsTable.batchId, id),
        sql`${batchMetrcTagsTable.cancelledAt} IS NULL`,
      ));
      const dup = hasRange
        ? existingRuns.find((r) => r.kind === "range"
            && (r.rangeStart ?? "").toUpperCase() === rangeStart.toUpperCase()
            && (r.rangeEnd ?? "").toUpperCase() === rangeEnd.toUpperCase())
        : existingRuns.find((r) => r.kind === "single"
            && tagList.some((t) => (r.metrcTag ?? "").toUpperCase() === t.toUpperCase()));
      if (dup) {
        res.status(409).json({ error: "These finished-goods tags are already recorded on this batch — no second run was created. Refresh the batch to see the existing run. To re-package, cancel that run first." });
        return;
      }
    }

    const stageLabel = (body.stageLabel ?? "").trim() || (finalize ? "Final packaging" : "Fulfillment packaging");
    const sourceTag = (body.sourceTag ?? "").trim() || null;
    const qty = body.quantity != null && String(body.quantity).trim() !== "" ? String(body.quantity) : null;
    const uom = (body.uom ?? "").trim() || null;

    // Record the tag node(s) FIRST; only advance status if that succeeds.
    if (hasRange) {
      await db.insert(batchMetrcTagsTable).values({
        batchId: id,
        sourceTag,
        stageLabel,
        kind: "range",
        rangeStart,
        rangeEnd,
        rangeCount: typeof body.rangeCount === "number" ? body.rangeCount : null,
        quantity: qty,
        uom,
        // JIT commit 2 — a fulfillment (finalize=false) packaging run is packaged
        // but not yet labeled; a finalize=true final-packaging run is labeled.
        labelStatus: finalize ? "labeled" : "unlabeled",
        metrcPackageCreatedAt,
        recordedByUserId: actor.id,
        recordedByName: actor.fullName,
      });
    } else {
      await db.insert(batchMetrcTagsTable).values(
        tagList.map((tag) => ({
          batchId: id,
          sourceTag,
          stageLabel,
          kind: "single" as const,
          metrcTag: tag,
          uom,
          labelStatus: finalize ? "labeled" : "unlabeled",
          metrcPackageCreatedAt,
          recordedByUserId: actor.id,
          recordedByName: actor.fullName,
        })),
      );
    }

    const [batch] = await db.update(batchRecordsTable).set({
      // A partial run keeps the batch In Fulfillment (released_to_inventory) so
      // more can be packaged later; only a finalize run closes it to Finished Goods.
      status: finalize ? "finished_goods" : "released_to_inventory",
      updatedAt: new Date(),
    }).where(eq(batchRecordsTable.id, id)).returning();

    void writeAuditLog({
      rowId: id,
      operation: finalize ? "CONFIRM_FINISHED_GOODS" : "PACKAGE_RUN",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: {
        ...(batch as unknown as Record<string, unknown>),
        signingMeaning,
        finishedGoodsTags: hasRange ? { kind: "range", rangeStart, rangeEnd } : { kind: "single", tags: tagList },
      },
    });
    res.json(batch);
  } catch (err) {
    req.log.error({ err }, "Failed to confirm finished goods");
    res.status(500).json({ error: "Failed to confirm finished goods" });
  }
});

// JIT commit 2 (label-later). Units may be PACKAGED now ("package a portion",
// finalize=false → tag runs recorded label_status='unlabeled', batch stays In
// Fulfillment) and LABELED later at order time. This is that order-time step: it
// enforces the SAME R 420.504 label-review checklist gate as the labeling-approval
// path, captures the retail destination (dispensary) + a Part 11 signature, flips
// every unlabeled run for the batch to 'labeled', records the labeling approval,
// and finalizes the batch to Finished Goods. No NEW METRC tag is created here —
// the units already carry their tags from the packaging run; this records label.
router.post("/batch-records/:id/label-and-finalize", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Label & Finalize requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".` });
      return;
    }
    const body = (req.body ?? {}) as {
      initials?: string; signingMeaning?: string; signatureMeaning?: string; dispensaryName?: string;
    };
    const initials = (body.initials ?? "").trim();
    const meaning = (body.signingMeaning ?? body.signatureMeaning ?? "").trim();
    const dispensaryName = (body.dispensaryName ?? "").trim() || null;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning are required (21 CFR Part 11)." }); return;
    }
    if (actor.initials && initials.toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }

    const [before] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!before) { res.status(404).json({ error: "Batch not found" }); return; }
    if (before.status === "finished_goods") { res.status(409).json({ error: "This batch is already Finished Goods." }); return; }
    if (before.status !== "released_to_inventory") {
      res.status(409).json({ error: `Label & Finalize is only available for a batch in Bulk — Released. Current status: "${before.status}".` }); return;
    }

    // R 420.304(2)(k) — sampled product is quarantined until passing results.
    {
      const blocked = await labSampleQuarantineBlock(id, "labeled and finalized");
      if (blocked) { res.status(409).json({ error: blocked }); return; }
    }


    // There must be at least one packaged-but-unlabeled run to label.
    const unlabeled = await db.select().from(batchMetrcTagsTable).where(and(
      eq(batchMetrcTagsTable.batchId, id),
      eq(batchMetrcTagsTable.labelStatus, "unlabeled"),
      sql`${batchMetrcTagsTable.cancelledAt} IS NULL`,
    ));
    if (unlabeled.length === 0) {
      res.status(409).json({ error: "No packaged, unlabeled units to label on this batch. Package a portion (label later) first, or use Confirm Finished Goods to finalize a fresh packaging run." }); return;
    }

    // R 420.504 label-review gate — reuse the SAME checklist-complete rule the
    // labeling-approval path enforces so Label & Finalize can't bypass the review.
    const [labeling] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!labeling) {
      res.status(409).json({ error: "Start the labeling approval and complete the R 420.504 checklist before Label & Finalize." }); return;
    }
    const checkItems = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id));
    if (checkItems.length === 0) {
      res.status(409).json({ error: `No labeling checklist exists for product type "${labeling.productType}". Seed the R 420.504 checklist (Start/Refresh Labeling Approval) first.` }); return;
    }
    const requiredItems = checkItems.filter((it) => String(it.required) === "true");
    if (requiredItems.length > 0) {
      const reqIds = requiredItems.map((it) => it.id);
      const responses = await db.select().from(checklistResponsesTable).where(inArray(checklistResponsesTable.checklistItemId, reqIds));
      const respByItem = new Map(responses.map((r) => [r.checklistItemId, String(r.response ?? "")]));
      const incomplete = requiredItems.filter((it) => { const v = respByItem.get(it.id); return v !== "Pass" && v !== "N/A"; });
      if (incomplete.length > 0) {
        res.status(409).json({ error: `Complete the R 420.504 labeling checklist before Label & Finalize — ${incomplete.length} of ${requiredItems.length} required item(s) still need a Pass or N/A.` }); return;
      }
    }

    const now = new Date();
    // Flip the unlabeled runs → labeled; stamp who/when + retail destination.
    await db.update(batchMetrcTagsTable).set({
      labelStatus: "labeled",
      dispensaryName,
      labeledByUserId: actor.id,
      labeledByName: actor.fullName,
      labeledAt: now,
      updatedAt: now,
    }).where(and(
      eq(batchMetrcTagsTable.batchId, id),
      eq(batchMetrcTagsTable.labelStatus, "unlabeled"),
      sql`${batchMetrcTagsTable.cancelledAt} IS NULL`,
    ));

    // Record the R 420.504 labeling approval on batch_labeling (same Part 11 sig).
    // Preserve an earlier approvalDate if one already exists.
    await db.update(batchLabelingTable).set({
      approvedBy: actor.id,
      approvalInitials: initials.toUpperCase(),
      approvalName: actor.fullName,
      approvalMeaning: meaning,
      approvalDate: labeling.approvalDate ?? now,
      updatedAt: now,
    }).where(eq(batchLabelingTable.id, labeling.id));

    // — 2026-09-09 (Jonathan): APPLYING LABELS NO LONGER CLOSES THE BATCH.
    // Putting the compliance label on a unit and finishing production are two
    // different acts by two different people at two different times: labels go
    // on during packaging, and a batch closes when the last unit is out of bulk.
    // Welding them together meant you could not label a run without ending the
    // batch, and could not ship without labelling — so a partial order was
    // impossible. The caller has to ASK for the close now.
    const closeBatch = (req.body as { closeBatch?: boolean } | undefined)?.closeBatch === true;
    const [batch] = closeBatch
      ? await db.update(batchRecordsTable).set({ status: "finished_goods", updatedAt: now })
          .where(eq(batchRecordsTable.id, id)).returning()
      : await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));

    void writeAuditLog({
      rowId: id,
      operation: closeBatch ? "LABEL_AND_FINALIZE" : "LABELS_APPLIED",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: {
        ...(batch as unknown as Record<string, unknown>),
        signingMeaning: meaning,
        labeledRuns: unlabeled.length,
        dispensaryName,
        closedBatch: closeBatch,
      },
    });
    res.json({ batch, labeledRuns: unlabeled.length, closedBatch: closeBatch });
  } catch (err) {
    req.log.error({ err }, "Failed to label and finalize");
    res.status(500).json({ error: `Failed to label & finalize: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.get("/batch-records/:id/ingredients", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Session 112 (2026-08-17) — carry the catalog item's TYPE onto each line.
    // The batch record UI routes a line by type: an item typed "Label" is a
    // compliance label, which is applied at the Labeling stage, not consumed
    // while ingredients are weighed, so it belongs on the Labeling tab's lot
    // traceability card. That routing has always been in the UI but could never
    // fire, because this endpoint returned only batch_ingredients' own columns
    // and the type lives on inventory_items — so every label silently fell
    // through to the Materials card on the Ingredients tab. LEFT join: a
    // hand-typed line with no catalog item still comes back, with a null type.
    const ingredients = await db
      .select({ ...getTableColumns(batchIngredientsTable), itemType: inventoryItemsTable.itemType })
      .from(batchIngredientsTable)
      .leftJoin(inventoryItemsTable, eq(batchIngredientsTable.inventoryItemId, inventoryItemsTable.id))
      .where(eq(batchIngredientsTable.batchId, id));
    res.json(ingredients);
  } catch (err) {
    req.log.error({ err }, "Failed to list ingredients");
    res.status(500).json({ error: "Failed to list ingredients" });
  }
});

// Session 79.5 — the legacy `inventory_items` per-row decrement (findInventoryRow
// + the take/refund blocks in POST/PATCH/DELETE) was REMOVED. Since Step 2 the
// Inventory screen reads the `lots` ledger, and Step 3 draws lots down on the
// signed "confirm ingredients" commit — so the old catalog decrement was moving
// a number nobody reads. Entering/editing ingredients now moves no inventory;
// the lot is the single ledger, adjusted only at commit (or refunded on an
// Admin signed-delete below).

// Session 79.3 — Materials (kind="Material", e.g. cartridges, cones, hardware)
// need a lot number so a recall can trace the batch back to the source material.
// The supplier-provenance hard-requirement was DROPPED: a material picked from
// inventory is itself a lot that already carries its supplier link, so forcing
// the operator to re-enter a supplier lot number was redundant and blocked
// adds. Supplier lot # / received-on are still captured when provided. Citation
// note: the old "R 420.704" reference was wrong (that rule covers disciplinary
// hearings); traceability flows from the statewide monitoring system, so no
// specific labeling-rule cite is asserted here.
function checkMaterialLotCapture(_body: Record<string, unknown>): { status: number; error: string } | null {
  // 2026-08-12 (Jonathan) — a lot number is NO LONGER required to add a material.
  // Many packaging/label materials (cartons, compliance labels, cones, closures)
  // don't carry a lot number or expiry date, and forcing one blocked legitimate
  // no-lot materials. When a lot IS provided its provenance still flows through
  // (and the Testing gate still validates lots on consumable ingredients); this
  // only relaxes the hard add-time requirement for materials.
  return null;
}

// BOM INTEGRITY (2026-09-06, Jonathan's ruling: "I do not want them adding 5kg of
// salt when 5kg of flour is required"). The ingredient dialog now refuses to offer
// — or accept — a lot that isn't the line's own material, but a UI gate is not a
// gate: the same rule has to hold on the server, or a stale tab, a replayed
// request or a direct call walks straight past it.
//
// The rule: when a line names a material AND links a real lot, that lot must BE
// that material. Matching is the same canonical name-or-type rule the picker uses,
// so a generic BOM line ("Cannabis Flower (ground)") still legitimately pairs with
// a strain lot of that type — what it stops is flour vs salt.
//
// Lines with no linked lot are untouched (a material may legitimately carry no lot),
// and so are lines whose lot has since been deleted.
function canonMaterial(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
}

async function checkIngredientMatchesLot(
  body: Record<string, unknown>,
): Promise<{ status: number; error: string } | null> {
  const name = typeof body.ingredientName === "string" ? body.ingredientName.trim() : "";
  const lotId = typeof body.lotId === "number" ? body.lotId : null;
  if (!name || lotId == null) return null;

  const [lot] = await db
    .select({ itemName: lotsTable.itemName, itemType: lotsTable.itemType, lotNumber: lotsTable.lotNumber })
    .from(lotsTable)
    .where(eq(lotsTable.id, lotId));
  if (!lot) return null;

  const want = canonMaterial(name);
  const gotName = canonMaterial(lot.itemName ?? "");
  const gotType = canonMaterial(lot.itemType ?? "");
  const matches =
    (want.length > 0 && gotName === want) ||
    (gotType.length > 0 && (want.includes(gotType) || gotType.includes(want)));
  if (matches) return null;

  return {
    status: 409,
    error:
      `This line requires "${name}", but lot ${lot.lotNumber ?? lotId} is "${lot.itemName}". ` +
      `A batch line can only be filled with its own material — pick a lot of "${name}", ` +
      `or correct the recipe line if it names the wrong material.`,
  };
}

router.post("/batch-records/:id/ingredients", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const lotCheck = checkMaterialLotCapture((req.body ?? {}) as Record<string, unknown>);
    if (lotCheck) { res.status(lotCheck.status).json({ error: lotCheck.error }); return; }
    const matchCheck = await checkIngredientMatchesLot((req.body ?? {}) as Record<string, unknown>);
    if (matchCheck) { res.status(matchCheck.status).json({ error: matchCheck.error }); return; }
    // Session 79.5 — adding an ingredient moves no inventory; the lot is drawn
    // down only on the signed "confirm ingredients" commit (Step 3).
    const [result] = await db.insert(batchIngredientsTable).values({ ...req.body, batchId: id, invDecrementedQty: 0 }).returning();
    if (!result) throw new Error("Insert failed");
    void writeIngredientAudit({
      rowId: result.id,
      operation: "INGREDIENT_ADDED",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? null,
      afterState: result as unknown as Record<string, unknown>,
    });
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to add ingredient");
    res.status(500).json({ error: "Failed to add ingredient" });
  }
});

router.patch("/batch-ingredients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    // Caller cannot tamper with the inventory bookkeeping fields directly.
    const { invDecrementedQty: _i, lotCommittedQty: _l, ...patch } = (req.body ?? {}) as Record<string, unknown>;
    let auditBefore: Record<string, unknown> | null = null;
    const result = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.id, id));
      if (!before) return null;
      auditBefore = before as unknown as Record<string, unknown>;
      // Session 40 (Tier 3 #12e) — re-validate material lot capture against
      // the merged state (existing row + this patch). A PATCH that flips
      // kind→Material or clears lot fields must still satisfy the contract.
      const merged: Record<string, unknown> = {
        kind: before.kind,
        lotNumber: before.lotNumber,
        supplierId: before.supplierId,
        supplierLotNumber: before.supplierLotNumber,
        ...patch,
      };
      const lotCheck = checkMaterialLotCapture(merged);
      if (lotCheck) {
        // Throw to roll back the tx; outer catch returns the right status.
        throw Object.assign(new Error(lotCheck.error), { __status: lotCheck.status });
      }
      // BOM integrity on EDIT too (2026-09-06) — re-pointing an existing line at a
      // lot of a different material is the same defect as adding one, so it gets
      // the same refusal. Checked against the merged state, not just the patch.
      const matchCheck = await checkIngredientMatchesLot({
        ingredientName: before.ingredientName,
        lotId: before.lotId,
        ...patch,
      });
      if (matchCheck) {
        throw Object.assign(new Error(matchCheck.error), { __status: matchCheck.status });
      }
      // Session 79.5 — editing an ingredient moves no inventory here. If the row
      // was already committed, the lot delta is applied on the next signed
      // "confirm ingredients" commit (it becomes pending again automatically).
      const [updated] = await tx.update(batchIngredientsTable).set({ ...patch, updatedAt: new Date() }).where(eq(batchIngredientsTable.id, id)).returning();
      return updated ?? null;
    });
    if (!result) { res.status(404).json({ error: "Ingredient not found" }); return; }
    void writeIngredientAudit({
      rowId: id,
      operation: "INGREDIENT_UPDATED",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? null,
      beforeState: auditBefore,
      afterState: result as unknown as Record<string, unknown>,
    });
    res.json(result);
  } catch (err) {
    // Session 40 — validation errors thrown from inside the tx carry a
    // `__status` property and a user-facing message; surface them as 4xx
    // rather than 500.
    const status = (err as { __status?: number })?.__status;
    if (typeof status === "number") {
      const msg = err instanceof Error ? err.message : "Validation failed";
      res.status(status).json({ error: msg });
      return;
    }
    req.log.error({ err }, "Failed to update ingredient");
    res.status(500).json({ error: "Failed to update ingredient" });
  }
});

router.delete("/batch-ingredients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const { initials, signingMeaning } = (req.body ?? {}) as { initials?: string; signingMeaning?: string };

    const [existing] = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Ingredient not found" }); return; }
    const committed = existing.lotCommittedQty ?? 0;

    // Session 79.5 — deleting an ingredient whose quantity has already been drawn
    // from inventory reverses a signed action. Admin-only, and requires a Part 11
    // reason + e-signature; the lot is refunded. Un-committed rows delete freely.
    if (committed > 1e-9) {
      if (!actor || actor.role !== "Admin") {
        res.status(403).json({ error: "Only an Admin can remove an ingredient that has already been drawn from inventory." });
        return;
      }
      if (!initials?.trim() || !signingMeaning?.trim()) {
        res.status(400).json({ error: "Removing a signed ingredient requires your initials and a reason (21 CFR Part 11)." });
        return;
      }
      if (actor.initials && actor.initials.trim().toUpperCase() !== initials.trim().toUpperCase()) {
        res.status(400).json({ error: `Initials must match the signed-in user (${actor.initials}).` });
        return;
      }
    }

    let auditRow: Record<string, unknown> | null = null;
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.id, id));
      if (!row) return;
      auditRow = row as unknown as Record<string, unknown>;
      const give = row.lotCommittedQty ?? 0;
      if (give > 1e-9) {
        // Refund the lot the consumption came from (resolve by lotId, else number).
        let lot: typeof lotsTable.$inferSelect | null = null;
        if (row.lotId) {
          const [l] = await tx.select().from(lotsTable).where(eq(lotsTable.id, row.lotId));
          lot = l ?? null;
        }
        if (!lot && row.lotNumber) {
          const [l] = await tx.select().from(lotsTable).where(eq(lotsTable.lotNumber, row.lotNumber)).orderBy(desc(lotsTable.createdAt)).limit(1);
          lot = l ?? null;
        }
        if (lot) {
          // lotCommittedQty is stored in the INGREDIENT's unit; convert it into
          // the lot's unit before refunding so we give back exactly what was
          // taken (same reason as the commit path above). Fall back to the raw
          // number only for identical/unrecognized labels (legacy 1:1 behavior).
          const rconv = convertQuantity(give, row.unitOfMeasure, lot.unitOfMeasure);
          const giveInLot = rconv.ok ? rconv.value : give;
          const [updated] = await tx.update(lotsTable)
            .set({ currentQuantity: sql`${lotsTable.currentQuantity} + ${giveInLot}`, status: "Active", updatedAt: new Date() })
            .where(eq(lotsTable.id, lot.id))
            .returning({ after: lotsTable.currentQuantity });
          await tx.insert(lotEventsTable).values({
            lotId: lot.id, eventType: "consume-reversal", quantityDelta: giveInLot, resultingQuantity: updated?.after ?? 0,
            relatedBatchId: row.batchId, reason: `Reversed consumption — ingredient removed (${row.ingredientName})`,
            performedBy: actor?.id ?? null, performedByName: actor?.fullName ?? null,
            signedInitials: initials?.trim() ?? null, signedMeaning: signingMeaning?.trim() ?? null, signedAt: new Date(),
          });
        }
      }
      await tx.delete(batchIngredientsTable).where(eq(batchIngredientsTable.id, id));
    });
    if (auditRow) {
      void writeIngredientAudit({
        rowId: id,
        operation: "INGREDIENT_REMOVED",
        changedById: actor?.id ?? null,
        changedByName: actor?.fullName ?? null,
        beforeState: auditRow,
      });
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete ingredient");
    res.status(500).json({ error: "Failed to delete ingredient" });
  }
});

// ── Session 79 (Step 3) — confirm ingredients & remove from inventory ─────────
// A single Part 11 e-signature at the END of the ingredient list is the point at
// which on-hand inventory is removed. Entering/editing rows moves NOTHING until
// this is signed. On sign, each ingredient's linked LOT (the visible on-hand
// ledger from Step 2) is decremented by its actual quantity, writing a signed
// lot_event for attribution. Re-signing after an edit moves only the delta
// (tracked on lot_committed_qty); an edit-down refunds the lot.
router.post("/batch-records/:id/ingredients/commit", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required for this action." }); return; }
    const { initials, signingMeaning, allowShortDraw, shortDrawReason } = (req.body ?? {}) as
      { initials?: string; signingMeaning?: string; allowShortDraw?: boolean; shortDrawReason?: string };
    if (!initials?.trim() || !signingMeaning?.trim()) {
      res.status(400).json({ error: "Initials and a signing statement are required (21 CFR Part 11)." });
      return;
    }
    // Same identity rule as the baker step-sign: the signer's initials must match
    // the signed-in user so the signature is attributable.
    if (actor.initials && actor.initials.trim().toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: `Initials must match the signed-in user (${actor.initials}).` });
      return;
    }
    const signedAt = new Date();

    // — HIS RULING 2026-09-08: running a line short is allowed, "by Mgt or
    // Quality only". Not Supervisor, not Operator — the people on the floor
    // fix a shortfall by adding another lot, they do not decide to make less.
    const SHORT_DRAW_ROLES = new Set(["Manager", "Quality"]);
    const shortDrawAllowed = allowShortDraw === true && SHORT_DRAW_ROLES.has(actor.role);
    if (allowShortDraw === true && !shortDrawAllowed) {
      res.status(403).json({
        error: `Running a line short must be authorised by Manager or Quality. Your role is "${actor.role}".`,
      });
      return;
    }
    if (shortDrawAllowed && !(shortDrawReason ?? "").trim()) {
      res.status(400).json({ error: "A reason is required when authorising a short draw." });
      return;
    }

    const summary = await db.transaction(async (tx) => {
      const rows = await tx.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, id));
      let committed = 0, refunded = 0, skipped = 0, shortDrawn = 0;
      const shortfalls: Array<{ ingredientName: string; lotNumber: string | null; have: number; want: number; uom: string }> = [];
      for (const row of rows) {
        const actual = row.actualQuantity ?? 0;
        const already = row.lotCommittedQty ?? 0;
        const delta = actual - already;
        if (Math.abs(delta) < 1e-9) continue;

        // Resolve the linked lot: prefer explicit lotId, else the unique lot_number.
        let lot: typeof lotsTable.$inferSelect | null = null;
        if (row.lotId) {
          const [l] = await tx.select().from(lotsTable).where(eq(lotsTable.id, row.lotId));
          lot = l ?? null;
        }
        if (!lot && row.lotNumber) {
          const [l] = await tx.select().from(lotsTable).where(eq(lotsTable.lotNumber, row.lotNumber)).orderBy(desc(lotsTable.createdAt)).limit(1);
          lot = l ?? null;
        }
        if (!lot) { skipped++; continue; }

        // Convert the draw into the LOT's own unit before moving stock. The
        // ingredient may be recorded in a different unit than the lot is stored
        // in (e.g. 100 g drawn from a lot tracked in Ounces). Subtracting the raw
        // number without converting silently over-/under-consumes and can wrongly
        // zero + Consume the lot — METRC (the source of truth for cannabis) only
        // removes the converted amount, so the local ledger diverged. Same-
        // dimension conversions are exact; identical/custom labels stay 1:1.
        const conv = convertQuantity(delta, row.unitOfMeasure, lot.unitOfMeasure);
        if (!conv.ok) {
          // Cross-dimension or unrecognized unit (e.g. count vs mass): we cannot
          // safely move stock without corrupting it. Skip and flag rather than
          // guess — entry-time validation should prevent this from reaching here.
          skipped++;
          continue;
        }
        let lotDelta = conv.value; // `delta` expressed in the lot's unit (sign preserved)

        // — 2026-09-08 — YOU CANNOT DRAW WHAT THE LOT DOES NOT HOLD.
        // The clamp below (GREATEST(qty - delta, 0)) was written as a crash guard
        // and was silently doing duty as a rule: asking for 100 g from a 94 g lot
        // took the lot to zero, marked it Consumed, dropped it off the Inventory
        // screen (that view lists Active lots only) and recorded 100 g as drawn.
        // Six grams that never existed entered a compliance record. Jonathan
        // found it on his first pre-roll batch.
        //
        // ⛔ ONE LOT PER LINE (his call 2026-09-08). Splitting a line across tags
        // is NOT the answer to a short lot: mixing changes the potency number, so
        // a mixed line has to be re-tested and re-labelled, and two strains of
        // flower means two harvest dates on one package. So the options are to
        // correct the entry, or run the line SHORT — and running short is a
        // management call, not an operator's.
        let shortBy = 0;
        if (lotDelta > 0) {
          const have = lot.currentQuantity ?? 0;
          if (lotDelta > have + 1e-9) {
            if (!shortDrawAllowed) {
              shortfalls.push({
                ingredientName: row.ingredientName,
                lotNumber: lot.lotNumber,
                have,
                want: lotDelta,
                uom: lot.unitOfMeasure,
              });
              continue;
            }
            shortBy = lotDelta - have;
            lotDelta = have;
          }
        }

        if (lotDelta > 0) {
          // Take from the lot (race-safe, clamp at 0). Mark Consumed when empty.
          const [updated] = await tx.update(lotsTable)
            .set({ currentQuantity: sql`GREATEST(${lotsTable.currentQuantity} - ${lotDelta}, 0)`, updatedAt: new Date() })
            .where(eq(lotsTable.id, lot.id))
            .returning({ after: lotsTable.currentQuantity });
          const after = updated?.after ?? 0;
          if (after <= 1e-9) {
            await tx.update(lotsTable).set({ status: "Consumed", updatedAt: new Date() }).where(eq(lotsTable.id, lot.id));
          }
          await tx.insert(lotEventsTable).values({
            lotId: lot.id, eventType: "consume", quantityDelta: -lotDelta, resultingQuantity: after,
            relatedBatchId: id, reason: `Consumed by batch (ingredient: ${row.ingredientName})`,
            performedBy: actor.id, performedByName: actor.fullName,
            signedInitials: initials.trim(), signedMeaning: signingMeaning.trim(), signedAt,
          });
          committed++;
        } else {
          // Edited down — refund the lot; re-activate if it was Consumed.
          const giveBack = -lotDelta;
          const [updated] = await tx.update(lotsTable)
            .set({ currentQuantity: sql`${lotsTable.currentQuantity} + ${giveBack}`, status: "Active", updatedAt: new Date() })
            .where(eq(lotsTable.id, lot.id))
            .returning({ after: lotsTable.currentQuantity });
          await tx.insert(lotEventsTable).values({
            lotId: lot.id, eventType: "consume-adjust", quantityDelta: giveBack, resultingQuantity: updated?.after ?? 0,
            relatedBatchId: id, reason: `Adjusted ingredient draw-down (ingredient: ${row.ingredientName})`,
            performedBy: actor.id, performedByName: actor.fullName,
            signedInitials: initials.trim(), signedMeaning: signingMeaning.trim(), signedAt,
          });
          refunded++;
        }
        if (shortBy > 0) {
          // The line ran short with authorisation. Correct the recorded actual
          // DOWN to what the lot really gave, so the batch record states what
          // went in rather than what was hoped for, and stamp who allowed it.
          const backConv = convertQuantity(lotDelta, lot.unitOfMeasure, row.unitOfMeasure);
          const realActual = already + (backConv.ok ? backConv.value : lotDelta);
          await tx.update(batchIngredientsTable).set({
            actualQuantity: realActual,
            lotCommittedQty: realActual,
            lotId: lot.id,
            shortDrawApprovedByName: actor.fullName,
            shortDrawApprovedInitials: initials.trim().toUpperCase(),
            shortDrawReason: (shortDrawReason ?? "").trim() || null,
            shortDrawAt: signedAt,
            updatedAt: new Date(),
          }).where(eq(batchIngredientsTable.id, row.id));
          shortDrawn++;
          continue;
        }
        await tx.update(batchIngredientsTable).set({ lotCommittedQty: actual, lotId: lot.id, updatedAt: new Date() }).where(eq(batchIngredientsTable.id, row.id));
      }
      // — Nothing commits while a line is short. Throwing rolls the WHOLE
      // transaction back, so the operator never gets a half-drawn batch: they
      // add another lot for the remainder, or Management authorises running short.
      if (shortfalls.length > 0) {
        const err = new Error("SHORT_DRAW") as Error & { shortfalls?: typeof shortfalls };
        err.shortfalls = shortfalls;
        throw err;
      }
      return { committed, refunded, skipped, shortDrawn };
    });

    void db.insert(auditLogTable).values({
      tableName: "batch_ingredients", rowId: id, operation: "INGREDIENTS_COMMITTED",
      changedBy: actor.id, changedByName: actor.fullName, beforeState: null,
      afterState: { batchId: id, ...summary, meaning: signingMeaning.trim(), at: signedAt.toISOString() } as never,
    }).catch(() => {});

    res.json({ ok: true, ...summary });
  } catch (err) {
    const shortfalls = (err as { shortfalls?: Array<{ ingredientName: string; lotNumber: string | null; have: number; want: number; uom: string }> }).shortfalls;
    if (shortfalls) {
      const lines = shortfalls.map((f) =>
        `${f.ingredientName}: lot ${f.lotNumber ?? "?"} holds ${f.have} ${f.uom}, the batch asks for ${f.want} ${f.uom}`);
      res.status(409).json({
        error: `Not enough material in the lot. ${lines.join("; ")}. Lower the recorded amount, pick a lot that covers it, or have Management or Quality authorise running short.`,
        shortfalls,
        needsShortDrawApproval: true,
      });
      return;
    }
    req.log.error({ err }, "Failed to commit ingredients");
    res.status(500).json({ error: "Failed to commit ingredients to inventory" });
  }
});

// ── Batch process steps (Session 59 — FDA GMP steps + baker e-signature) ──────

router.get("/batch-records/:id/process-steps", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(batchProcessStepsTable)
      .where(eq(batchProcessStepsTable.batchId, id))
      .orderBy(asc(batchProcessStepsTable.sortOrder), asc(batchProcessStepsTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list process steps");
    res.status(500).json({ error: "Failed to list process steps" });
  }
});

// Add an ad-hoc step directly on the batch (e.g. an unplanned step the recipe
// didn't carry). Recipe-sourced steps arrive via the copy at batch creation.
router.post("/batch-records/:id/process-steps", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.description !== "string" || !body.description.trim()) {
      res.status(400).json({ error: "Step description is required" }); return;
    }
    const existing = await db.select({ sortOrder: batchProcessStepsTable.sortOrder })
      .from(batchProcessStepsTable).where(eq(batchProcessStepsTable.batchId, id));
    const nextSort = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), 0) + 1;
    const [row] = await db.insert(batchProcessStepsTable).values({
      batchId: id,
      stepNumber: typeof body.stepNumber === "number" ? body.stepNumber : nextSort,
      description: body.description.trim(),
      template: typeof body.template === "string" ? (body.template.trim() || null) : null,
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : nextSort,
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add process step");
    res.status(500).json({ error: "Failed to add process step" });
  }
});

// Session 59.1 — substitute {token} blanks in a step template with the baker's
// filled-in values, producing the printable sentence. Unfilled tokens render as
// "____" so the gap stays visible on the batch record.
function renderStepTemplate(template: string | null | undefined, values: Record<string, unknown>): string | null {
  if (!template) return null;
  return template.replace(/\{([^}]+)\}/g, (_m, raw) => {
    const v = values[String(raw).trim()];
    return v != null && String(v).trim() !== "" ? String(v) : "____";
  });
}

// Session 62 — competency: a "supervised batch" for (operator, recipe) is a
// distinct batch of that recipe carrying a completed, co-signed step performed
// by the operator. Computed live (never stored) so the count can't drift.
async function computeSupervisedCount(operatorUserId: number, recipeId: number): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(distinct ${batchProcessStepsTable.batchId})` })
    .from(batchProcessStepsTable)
    .innerJoin(batchRecordsTable, eq(batchProcessStepsTable.batchId, batchRecordsTable.id))
    .where(and(
      eq(batchProcessStepsTable.performedByUserId, operatorUserId),
      eq(batchRecordsTable.recipeId, recipeId),
      eq(batchProcessStepsTable.completed, true),
      sql`${batchProcessStepsTable.supervisorUserId} IS NOT NULL`,
    ));
  return Number(r?.c ?? 0);
}

// Part 11 e-signature: the baker signs off a step. Captures the acting user as
// the baker (id + name), their initials (must match the signed-in user), a
// signing meaning, the filled-in blank values, the rendered sentence, and the
// timestamp. A signed step is immutable.
//
// Session 62 — competency gate: if the batch runs a recipe and the operator is
// not yet Qualified for it, the step is recorded but stays PENDING (completed=
// false, cosignRequired=true) until a Supervisor+ co-signs via /cosign. A
// Qualified operator (or a legacy batch with no recipeId) signs solo as before.
// GET /batch-records/:id/my-training-hold — does the signed-in user have training
// still open on a document in force over this batch's recipe? Answers the same
// question the sign route enforces, so the operator is told BEFORE they put their
// initials in rather than after. Jonathan, 2026-08-26: a person with training
// Assigned should be "stopped or given instruction while working".
// Returns { hold: null } for a supervisor+, an unlinked batch, or a clear operator.
router.get("/batch-records/:id/my-training-hold", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.json({ hold: null }); return; }
    if (APPROVER_ROLES.has(actor.role)) { res.json({ hold: null }); return; }
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.json({ hold: null }); return; }
    const [batchRow] = await db.select({ recipeId: batchRecordsTable.recipeId })
      .from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    const recipeId = batchRow?.recipeId ?? null;
    if (recipeId == null) { res.json({ hold: null }); return; }
    const govDocs = await db
      .select({ id: documentsTable.id, docNumber: documentsTable.docNumber, title: documentsTable.title, revision: documentsTable.revision })
      .from(documentsTable)
      .where(and(eq(documentsTable.recipeId, recipeId), eq(documentsTable.status, "Effective")));
    if (!govDocs.length) { res.json({ hold: null }); return; }
    const byId = new Map(govDocs.map((d) => [d.id, d]));
    const recs = await db
      .select()
      .from(trainingRecordsTable)
      .where(
        and(
          eq(trainingRecordsTable.assignedToUserId, actor.id),
          inArray(trainingRecordsTable.documentId, govDocs.map((d) => d.id)),
        ),
      );
    const open = recs.find((r) => {
      const d = r.documentId != null ? byId.get(r.documentId) : undefined;
      if (!d) return false;
      if (r.documentRevisionSnapshot !== d.revision) return false;
      return r.status === "Assigned" || r.status === "In Progress" || r.status === "Overdue";
    });
    if (!open) { res.json({ hold: null }); return; }
    const d = byId.get(open.documentId as number)!;
    res.json({
      hold: {
        docNumber: d.docNumber,
        docTitle: d.title,
        revision: d.revision,
        trainingRecordId: open.id,
        dueDate: open.dueDate,
        status: open.status,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to check training hold");
    res.json({ hold: null });
  }
});

router.post("/batch-process-steps/:id/sign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning, notes, fieldValues } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string; notes?: string;
      fieldValues?: Record<string, unknown>;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to sign a process step." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }
    const [before] = await db.select().from(batchProcessStepsTable).where(eq(batchProcessStepsTable.id, id));
    if (!before) { res.status(404).json({ error: "Process step not found" }); return; }
    if (before.completed) { res.status(409).json({ error: "This step is already signed off and is immutable." }); return; }
    if (before.cosignRequired) {
      res.status(409).json({ error: "This step is already signed and is awaiting a supervisor co-sign." }); return;
    }

    // Session 62 — resolve the batch's recipe and the operator's competency for
    // it. If not Qualified, the sign records but the step stays pending a
    // supervisor co-sign. Auto-enroll the operator into "In Training" on their
    // first sign for a recipe they have no row for yet.
    //
    // Supervisor+ (APPROVER_ROLES) are EXEMPT from the competency gate — their
    // role is their authorization, so they sign solo on any recipe (no pending
    // state, no auto-enrollment). This also avoids a single-supervisor deadlock
    // where a supervisor's own step could never be witnessed. Operators only.
    const actorIsApprover = APPROVER_ROLES.has(actor.role);
    const [batchRow] = await db.select({ recipeId: batchRecordsTable.recipeId })
      .from(batchRecordsTable).where(eq(batchRecordsTable.id, before.batchId));
    const recipeId = batchRow?.recipeId ?? null;
    let cosignRequired = false;
    if (recipeId != null && !actorIsApprover) {
      let [qual] = await db.select().from(operatorQualificationsTable)
        .where(and(eq(operatorQualificationsTable.operatorUserId, actor.id), eq(operatorQualificationsTable.recipeId, recipeId)));
      if (!qual) {
        const inserted = await db.insert(operatorQualificationsTable)
          // Session 66/67 — set the supervised-batch requirement explicitly at row
          // creation instead of relying on the column default, so the threshold
          // is owned by code (no DB-client edit needed) and is deterministic even
          // on an already-provisioned database. Production value is 5; mirrors the
          // DEFAULT in schema + ensureSchema.
          .values({ operatorUserId: actor.id, recipeId, requiredSupervisedBatches: 5 })
          .onConflictDoNothing()
          .returning();
        qual = inserted[0] ?? (await db.select().from(operatorQualificationsTable)
          .where(and(eq(operatorQualificationsTable.operatorUserId, actor.id), eq(operatorQualificationsTable.recipeId, recipeId))))[0];
      }
      if (qual && qual.status !== "Qualified") cosignRequired = true;
    }

    // 2026-08-26 — TRAINING ON THE CONTROLLED DOCUMENT.
    //
    // Operator qualification says this person can run this recipe. It says
    // nothing about whether they have read the revision of the Work Instruction
    // currently in force, and those two came apart the moment a document could be
    // released into force with training still outstanding — which Quality and
    // Managers may do when someone is away sick or on vacation. So an operator
    // can legitimately arrive at a step governed by a revision they have never
    // acknowledged.
    //
    // That is not forbidden; it is supervised. The training module carries a
    // "Direct / Indirect Supervision" type precisely because an untrained person
    // may perform work watched by a trained one. So an open assignment takes the
    // SAME route as an unqualified operator: the step signs and waits for a
    // Supervisor+ co-sign, rather than blocking the line the morning someone
    // comes back from leave. Supervisor+ remain exempt, as above.
    //
    // Scope note: only an OPEN assignment on the revision in force counts —
    // Assigned, In Progress or Overdue. An operator who was never assigned
    // training on this document at all is left alone here, because training
    // coverage is still being built out and gating on "no record" would put a
    // co-sign on nearly every step in the plant. Tighten this to "no Completed
    // record on the current revision" once coverage is real.
    let trainingHold: { docNumber: string; revision: string } | null = null;
    if (recipeId != null && !actorIsApprover) {
      const govDocs = await db
        .select({
          id: documentsTable.id,
          docNumber: documentsTable.docNumber,
          revision: documentsTable.revision,
        })
        .from(documentsTable)
        .where(and(eq(documentsTable.recipeId, recipeId), eq(documentsTable.status, "Effective")));
      if (govDocs.length) {
        const byId = new Map(govDocs.map((d) => [d.id, d]));
        const recs = await db
          .select()
          .from(trainingRecordsTable)
          .where(
            and(
              eq(trainingRecordsTable.assignedToUserId, actor.id),
              inArray(trainingRecordsTable.documentId, govDocs.map((d) => d.id)),
            ),
          );
        const openRec = recs.find((r) => {
          const d = r.documentId != null ? byId.get(r.documentId) : undefined;
          if (!d) return false;
          if (r.documentRevisionSnapshot !== d.revision) return false;
          return r.status === "Assigned" || r.status === "In Progress" || r.status === "Overdue";
        });
        if (openRec) {
          const d = byId.get(openRec.documentId as number)!;
          trainingHold = { docNumber: d.docNumber, revision: d.revision };
          cosignRequired = true;
        }
      }
    }

    // 2026-08-19 — THE METRC PACKAGE STEP. Signing this one does not just record
    // a sentence: it creates the package in METRC and turns the typed tag into
    // this batch's number. Everything below runs BEFORE the signature is written,
    // and any failure returns without touching the step, because a signed step
    // claiming a package METRC refused is exactly the phantom-package problem
    // this system exists to prevent. Nothing is half-committed: either METRC
    // accepted the package and the signature stands, or neither happened.
    if (before.stepKind === METRC_PACKAGE_STEP_KIND) {
      const v = (fieldValues ?? {}) as Record<string, unknown>;
      const str = (k: string) => String(v[k] ?? "").trim();
      // NOT {metrc_tag}: Session 111 established that token as "a tag this batch
      // drew FROM" and the sign dialog prefills it with the batch's source lot,
      // which put the source package's tag into the field meant for the brand-new
      // one. This step means the opposite, so it gets a token that cannot be
      // mistaken for the source by a human or by that prefill.
      const metrcTag = str("new_package_tag").toUpperCase();
      const item = str("item");
      const location = str("location");
      const uom = str("uom");
      const quantity = Number(v["quantity"]);

      const missing: string[] = [];
      if (!metrcTag) missing.push("METRC tag");
      if (!item) missing.push("item");
      if (!location) missing.push("location");
      if (!uom) missing.push("unit of measure");
      if (!(quantity > 0)) missing.push("quantity produced");
      if (missing.length > 0) {
        res.status(400).json({
          error: `Cannot create the METRC package — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required. METRC rejects a package create without them.`,
        });
        return;
      }

      const [batchForMetrc] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, before.batchId));
      if (!batchForMetrc) { res.status(404).json({ error: "Batch not found" }); return; }
      // ⛔ 2026-09-04 — THE GATE ASKS METRC, it does not trust the local column.
      //
      // This used to refuse the moment `metrc_package_id` held anything at all.
      // That column is also writable from the Overview edit form through the
      // generic PATCH above (~line 525), which promotes a typed tag into
      // `batch_number` WITHOUT creating anything in METRC. So typing a tag there
      // permanently blocked the one step whose job is to create that package —
      // batches 28 (09-03) and 29 (09-04) both died exactly that way, and there
      // is no UI anywhere to clear the column again.
      //
      // "A tag is recorded" and "METRC holds this package" are different facts.
      // Only the second one may block: a tag METRC has never heard of is a
      // phantom, and the correct response is to go create the real package.
      //
      // Same idiom as the release gate above — getPackageByLabel DIRECTLY, never
      // renderMetrc (which answers 200 on failure and would make this worthless),
      // and 401 is read as "this facility does not hold it" because METRC answers
      // 401, not 404, for an unknown tag (verified 2026-08-19).
      //
      // ⚠️ FAILS CLOSED. If METRC cannot be reached we do NOT assume the tag is a
      // phantom and wave the step through — that would create a duplicate package
      // for a batch that already had a good one. Unreachable is not "absent".
      const existingTag = (batchForMetrc.metrcPackageId ?? "").trim();
      if (existingTag) {
        const existingPkg = await getPackageByLabel(existingTag);
        if (existingPkg.ok) {
          res.status(409).json({
            error: `This batch already has METRC package ${existingTag}, and METRC confirms it exists. A batch's bulk package is created once — record a further form change on the METRC tab rather than re-signing this step.`,
          });
          return;
        }
        if (existingPkg.status !== 401 && existingPkg.status !== 404) {
          res.status(503).json({
            error: `Cannot create the METRC package — METRC could not be reached to check the tag already on this batch, ${existingTag} (${existingPkg.error}). Nothing was signed. Try again once METRC is reachable.`,
          });
          return;
        }
        // Phantom: recorded locally, unknown to METRC. Let the step proceed and
        // create the real package; the write below overwrites BOTH
        // metrc_package_id and batch_number with the tag actually created, so the
        // phantom does not survive. Logged because a batch reaching this state at
        // all means something wrote the column without going through METRC.
        logger.warn(
          { batchId: before.batchId, phantomTag: existingTag, newTag: metrcTag },
          "Batch carried a METRC tag that METRC does not hold; allowing the package-create step to proceed",
        );
      }

      // batch_records.batch_number is UNIQUE and this tag is about to become it,
      // so a collision is checked HERE rather than being left to the insert. The
      // ordering matters: past this point METRC has created a real package, and
      // a unique violation landing after that would leave a package the state
      // knows about attached to a batch we failed to update.
      const [tagClash] = await db.select({ id: batchRecordsTable.id, batchNumber: batchRecordsTable.batchNumber })
        .from(batchRecordsTable)
        .where(and(eq(batchRecordsTable.batchNumber, metrcTag), ne(batchRecordsTable.id, before.batchId)));
      if (tagClash) {
        res.status(409).json({
          error: `METRC tag ${metrcTag} is already the batch number for batch ${tagClash.batchNumber}. Nothing was created in METRC. Use the next unused tag from your pool.`,
        });
        return;
      }

      // The source package and the amount drawn are NOT re-asked here (08-17):
      // they are the batch's own cannabis ingredient lines. A line counts as the
      // source when its lot is flagged cannabis AND carries a METRC package id,
      // which is precisely what "Sync from METRC" stamps — so food ingredients,
      // packaging and labels can never be mistaken for the source.
      const ingLines = await db.select().from(batchIngredientsTable)
        .where(eq(batchIngredientsTable.batchId, before.batchId));
      const lotNumbers = Array.from(new Set(ingLines.map((r) => (r.lotNumber ?? "").trim()).filter(Boolean)));
      const cannabisLots = lotNumbers.length
        ? (await db.select().from(lotsTable).where(inArray(lotsTable.lotNumber, lotNumbers)))
            .filter((l) => l.isCannabis === true && (l.metrcPackageId ?? "").trim())
        : [];
      if (cannabisLots.length === 0) {
        res.status(409).json({
          error: "Cannot create the METRC package — this batch has no cannabis ingredient drawn from a METRC-tracked lot. Record the source package on the Ingredients tab first; METRC will not accept a package with no source.",
        });
        return;
      }

      // Build ingredient lines from ALL cannabis lots. Multi-source batches (e.g.
      // an infused pre-roll drawing from both flower and concentrate) need all source
      // packages in METRC's Ingredients array — one entry per lot, each with the
      // amount actually drawn. METRC does not auto-deduct; we send the quantities.
      const ingredients = cannabisLots.map((lot) => {
        const drawn = ingLines
          .filter((r) => (r.lotNumber ?? "").trim() === lot.lotNumber)
          .reduce((sum, r) => sum + Number(r.actualQuantity ?? 0), 0);
        const ingUom = ingLines.find((r) => (r.lotNumber ?? "").trim() === lot.lotNumber)?.unitOfMeasure ?? uom;
        return {
          packageLabel: (lot.metrcPackageId ?? "").trim(),
          quantity: drawn,
          unitOfMeasure: ingUom,
        };
      });

      // Every source lot must have actual quantity > 0 on the ingredient lines.
      const zeroDrawn = ingredients.filter((ing) => !(ing.quantity > 0));
      if (zeroDrawn.length > 0) {
        res.status(409).json({
          error: `Cannot create the METRC package — no actual quantity is recorded against source package${zeroDrawn.length > 1 ? "s" : ""} ${zeroDrawn.map((i) => i.packageLabel).join(", ")}. Record the amount drawn on the Ingredients tab.`,
        });
        return;
      }

      const provider = await getTrackingProviderForFacility();
      const created = await provider.createFinishedGoods({
        // Pass all cannabis lots as the Ingredients array. For single-source batches
        // this produces the same result as before (one ingredient entry). For
        // multi-source batches METRC receives all source packages and deducts from each.
        ingredients,
        item,
        unitOfMeasure: uom,
        packagedDate: (batchForMetrc.productionDate ? String(batchForMetrc.productionDate) : facilityDateStr()),
        location,
        // The bulk output of a process run IS a production batch in METRC's
        // sense, and its production batch number is the tag itself — the same
        // identity CannaQMS is about to adopt as the batch number.
        isProductionBatch: true,
        productionBatchNumber: metrcTag,
        packages: [{ tag: metrcTag, quantity }],
      });
      if (!created.ok) {
        res.status(created.status === 401 || created.status === 400 || created.status === 409 ? 409 : 502).json({
          error: `METRC refused to create package ${metrcTag} — ${created.error}. Nothing was signed and the batch is unchanged. Check that the tag is unused and that the item and location match your facility catalog exactly.`,
        });
        return;
      }

      // METRC accepted it. The tag is now a real package, so it becomes this
      // batch's number — the same promotion the create dialog used to do
      // unsigned, now standing on a signature and a state-system confirmation.
      await db.update(batchRecordsTable).set({
        metrcPackageId: metrcTag,
        batchNumber: metrcTag,
        updatedAt: new Date(),
      }).where(eq(batchRecordsTable.id, before.batchId));
      void writeAuditLog({
        rowId: before.batchId,
        operation: "METRC_PACKAGE_CREATED",
        changedByName: actor.fullName,
        afterState: {
          metrcPackageId: metrcTag,
          batchNumber: metrcTag,
          quantity,
          unitOfMeasure: uom,
          item,
          location,
          // All source packages recorded — audit trail must name every lot drawn.
          ingredients: ingredients.map((i) => ({ sourcePackage: i.packageLabel, sourceQuantity: i.quantity, sourceUom: i.unitOfMeasure })),
        },
      });
    }

    // The {baker} blank is authoritative from the signature (the signed-in
    // user), not free text. Render the sentence server-side from the batch
    // step's own template so the stored record can't be tampered with.
    const values: Record<string, unknown> = { ...(fieldValues ?? {}), baker: actor.fullName };
    const renderedText = renderStepTemplate(before.template, values);
    const [row] = await db.update(batchProcessStepsTable).set({
      // Pending steps are NOT complete until co-signed (Session 62).
      completed: !cosignRequired,
      cosignRequired,
      performedByUserId: actor.id,
      performedByName: actor.fullName,
      signedInitials: initials.trim().toUpperCase(),
      signedMeaning: meaning,
      fieldValues: values,
      renderedText,
      performedAt: new Date(),
      notes: notes ?? before.notes,
      updatedAt: new Date(),
    }).where(eq(batchProcessStepsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "batch_process_steps",
        rowId: id,
        operation: cosignRequired ? "STEP_SIGNED_PENDING_COSIGN" : "STEP_SIGNED",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: before as unknown as Record<string, unknown>,
        // The reason for the co-sign is recorded, not just the fact of it: an
        // untrained signer and an unqualified one are different findings.
        afterState: {
          ...(row as unknown as Record<string, unknown>),
          cosignReason: trainingHold
            ? `Training open on ${trainingHold.docNumber} rev ${trainingHold.revision}`
            : cosignRequired
              ? "Operator not qualified on this recipe"
              : null,
        } as unknown as Record<string, unknown>,
      });
    } catch { /* audit must never break the flow */ }
    res.json({ ...row, cosignRequired, trainingHold });
  } catch (err) {
    req.log.error({ err }, "Failed to sign process step");
    res.status(500).json({ error: "Failed to sign process step" });
  }
});

// Remove a process step (only while unsigned — a signed step is a Part 11
// record and is retained).
router.delete("/batch-process-steps/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(batchProcessStepsTable).where(eq(batchProcessStepsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Process step not found" }); return; }
    if (existing.completed) { res.status(409).json({ error: "A signed step cannot be deleted (21 CFR Part 11)." }); return; }
    if (existing.cosignRequired) { res.status(409).json({ error: "A step awaiting a supervisor co-sign cannot be deleted (21 CFR Part 11)." }); return; }
    await db.delete(batchProcessStepsTable).where(eq(batchProcessStepsTable.id, id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete process step");
    res.status(500).json({ error: "Failed to delete process step" });
  }
});

// ── Session 62 — competency: supervisor co-sign + operator qualifications ─────

// Co-sign a step an unqualified operator signed (it's pending). Supervisor+ only,
// and the co-signer MUST be someone other than the operator who performed it
// (independent verification, Part 11). Completing it counts toward the
// operator's supervised-batch tally for the recipe.
router.post("/batch-process-steps/:id/cosign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to co-sign a process step." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Co-signing requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".` }); return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }
    const [before] = await db.select().from(batchProcessStepsTable).where(eq(batchProcessStepsTable.id, id));
    if (!before) { res.status(404).json({ error: "Process step not found" }); return; }
    if (!before.cosignRequired) { res.status(409).json({ error: "This step does not require a co-sign." }); return; }
    if (before.completed) { res.status(409).json({ error: "This step is already co-signed and is immutable." }); return; }
    if (before.performedByUserId && before.performedByUserId === actor.id) {
      res.status(403).json({ error: "A co-signer must be different from the operator who performed the step." }); return;
    }
    const [row] = await db.update(batchProcessStepsTable).set({
      completed: true,
      supervisorUserId: actor.id,
      supervisorName: actor.fullName,
      supervisorInitials: initials.trim().toUpperCase(),
      supervisorMeaning: meaning,
      supervisorSignedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(batchProcessStepsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "batch_process_steps",
        rowId: id,
        operation: "STEP_COSIGNED",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: row as unknown as Record<string, unknown>,
      });
    } catch { /* audit must never break the flow */ }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to co-sign process step");
    res.status(500).json({ error: "Failed to co-sign process step" });
  }
});

// List operator qualifications, optionally filtered by operator and/or recipe.
// Each row is augmented with the live supervised-batch count and an `eligible`
// flag (count >= required) so the client can show progress and gate the
// qualify action without a second round-trip.
router.get("/operator-qualifications", async (req, res) => {
  try {
    const opRaw = req.query.operatorUserId;
    const recRaw = req.query.recipeId;
    const operatorUserId = typeof opRaw === "string" && opRaw ? parseInt(opRaw) : null;
    const recipeId = typeof recRaw === "string" && recRaw ? parseInt(recRaw) : null;
    const conds = [];
    if (operatorUserId && Number.isFinite(operatorUserId)) conds.push(eq(operatorQualificationsTable.operatorUserId, operatorUserId));
    if (recipeId && Number.isFinite(recipeId)) conds.push(eq(operatorQualificationsTable.recipeId, recipeId));
    const rows = await db.select({
      q: operatorQualificationsTable,
      operatorName: usersTable.fullName,
      operatorRole: usersTable.role,
    }).from(operatorQualificationsTable)
      .leftJoin(usersTable, eq(usersTable.id, operatorQualificationsTable.operatorUserId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(operatorQualificationsTable.updatedAt));
    const augmented = await Promise.all(rows.map(async ({ q, operatorName, operatorRole }) => {
      const supervisedCount = await computeSupervisedCount(q.operatorUserId, q.recipeId);
      return {
        ...q,
        operatorName: operatorName ?? null,
        operatorRole: operatorRole ?? null,
        supervisedCount,
        eligible: supervisedCount >= q.requiredSupervisedBatches,
      };
    }));
    res.json(augmented);
  } catch (err) {
    req.log.error({ err }, "Failed to list operator qualifications");
    res.status(500).json({ error: "Failed to list operator qualifications" });
  }
});

// Record a Part 11 qualification sign-off → status "Qualified". Supervisor+ only,
// cannot qualify yourself, and the operator must have met the required supervised
// count (computed live, re-checked server-side as the source of truth).
router.post("/operator-qualifications/:id/qualify", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Qualifying an operator requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".` }); return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }
    const [qual] = await db.select().from(operatorQualificationsTable).where(eq(operatorQualificationsTable.id, id));
    if (!qual) { res.status(404).json({ error: "Qualification record not found" }); return; }
    if (qual.operatorUserId === actor.id) {
      res.status(403).json({ error: "You cannot sign off your own qualification." }); return;
    }
    if (qual.status === "Qualified") { res.status(409).json({ error: "Operator is already Qualified for this recipe." }); return; }
    const supervisedCount = await computeSupervisedCount(qual.operatorUserId, qual.recipeId);
    if (supervisedCount < qual.requiredSupervisedBatches) {
      res.status(409).json({ error: `Not eligible: ${supervisedCount} of ${qual.requiredSupervisedBatches} supervised batches completed.` }); return;
    }
    const [row] = await db.update(operatorQualificationsTable).set({
      status: "Qualified",
      qualifiedAt: new Date(),
      qualifiedBySupervisorUserId: actor.id,
      qualifiedBySupervisorName: actor.fullName,
      signedInitials: initials.trim().toUpperCase(),
      signedMeaning: meaning,
      // clear any prior revocation
      revokedAt: null, revokedReason: null, revokedByName: null,
      updatedAt: new Date(),
    }).where(eq(operatorQualificationsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "operator_qualifications",
        rowId: id,
        operation: "OPERATOR_QUALIFIED",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: qual as unknown as Record<string, unknown>,
        afterState: row as unknown as Record<string, unknown>,
      });
    } catch { /* audit must never break the flow */ }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to qualify operator");
    res.status(500).json({ error: "Failed to qualify operator" });
  }
});

// Revoke a qualification (Supervisor+; reason required). Recoverable by
// re-qualifying. Solo signing for the recipe reverts to pending co-sign.
router.post("/operator-qualifications/:id/revoke", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim()) { res.status(400).json({ error: "A revocation reason is required." }); return; }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Revoking a qualification requires Supervisor, Manager, Quality, or Admin role. Your role is "${actor.role}".` }); return;
    }
    const [qual] = await db.select().from(operatorQualificationsTable).where(eq(operatorQualificationsTable.id, id));
    if (!qual) { res.status(404).json({ error: "Qualification record not found" }); return; }
    const [row] = await db.update(operatorQualificationsTable).set({
      status: "Revoked",
      revokedAt: new Date(),
      revokedReason: reason.trim(),
      revokedByName: actor.fullName,
      updatedAt: new Date(),
    }).where(eq(operatorQualificationsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "operator_qualifications",
        rowId: id,
        operation: "OPERATOR_QUAL_REVOKED",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: qual as unknown as Record<string, unknown>,
        afterState: row as unknown as Record<string, unknown>,
      });
    } catch { /* audit must never break the flow */ }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to revoke qualification");
    res.status(500).json({ error: "Failed to revoke qualification" });
  }
});

router.get("/batch-records/:id/testing", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const results = await db.select().from(batchTestingTable).where(eq(batchTestingTable.batchId, id)).orderBy(batchTestingTable.sequenceNumber);
    res.json(results);
  } catch (err) {
    req.log.error({ err }, "Failed to list test results");
    res.status(500).json({ error: "Failed to list test results" });
  }
});

// 2026-09-08 — the sample collection fields are TIMESTAMPS, and the browser sends
// them as ISO strings. Drizzle hands a timestamp column's value straight to
// `.toISOString()`, so a string blows up with "value.toISOString is not a
// function" and the whole save 500s. Coerce here, once, for both the create and
// the update path. An unparseable value becomes null rather than a bad date.
const BATCH_TESTING_TIMESTAMP_FIELDS = ["sampleCollectedAt", "sampleTransferredAt"] as const;
function coerceTestingTimestamps(safe: Record<string, unknown>): void {
  for (const k of BATCH_TESTING_TIMESTAMP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(safe, k)) continue;
    const v = safe[k];
    if (v == null || v === "") { safe[k] = null; continue; }
    if (v instanceof Date) continue;
    const d = new Date(String(v));
    safe[k] = Number.isNaN(d.getTime()) ? null : d;
  }
}

// Lab sample chain of custody (R 420.304(2)(i), 2026-09-08). Both employees
// sign the form; ours signs electronically. A client sends only the initials
// and the meaning — the NAME and the TIME are taken from the signed-in user and
// the server clock, so a signature can never be attributed to someone else.
// Initials must match the account, exactly like batch release does it.
async function applyCocSignature(
  safe: Record<string, unknown>,
  actorName: string | null,
  actorInitials: string | null,
): Promise<string | null> {
  const initials = typeof safe.cocSignedByInitials === "string" ? safe.cocSignedByInitials.trim() : "";
  if (!initials) return null;
  if (actorInitials && initials.toUpperCase() !== actorInitials.toUpperCase()) {
    return "Initials do not match your account. Sign the chain of custody with your own initials.";
  }
  if (!safe.cocMetrcIdentified || !safe.cocObservedThroughout || !safe.cocNoAssist) {
    return "All three chain-of-custody attestations must be confirmed before signing (R 420.304(2)(g), (h) and (i)).";
  }
  safe.cocSignedByInitials = initials;
  safe.cocSignedByName = actorName ?? "";
  safe.cocSignedAt = new Date();
  return null;
}

router.post("/batch-records/:id/testing", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (BATCH_TESTING_ALLOWED.has(k)) safe[k] = v;
    }
    // Session 36 — validate phase + testing agency FK.
    const phase = (safe.phase as string | undefined) ?? "result";
    if (!BATCH_TESTING_PHASES.has(phase)) {
      res.status(400).json({ error: `Invalid phase "${phase}". Must be "pre_test" or "result".` });
      return;
    }
    safe.phase = phase;
    const agencyErr = await validateTestingAgency(safe.testingAgencyId as number | undefined);
    if (agencyErr) { res.status(409).json({ error: agencyErr }); return; }
    // Legacy testingAgency text field is notNull on the table — provide a
    // sensible default when the operator only set the FK. We mirror the
    // agency's supplier_name so legacy display paths keep working.
    if (!safe.testingAgency && safe.testingAgencyId) {
      const [s] = await db.select({ name: suppliersTable.supplierName }).from(suppliersTable).where(eq(suppliersTable.id, safe.testingAgencyId as number));
      if (s) safe.testingAgency = s.name;
    }
    // Same fix as Session 32 Bug #2 — use MAX(sequenceNumber)+1 not count(*)
    // so deleted rows don't compress the sequence and concurrent inserts
    // can't both pick the same value.
    const [seq] = await db
      .select({ max: sql<number>`coalesce(max(sequence_number), 0)` })
      .from(batchTestingTable)
      .where(eq(batchTestingTable.batchId, id));
    const sequenceNumber = (seq?.max ?? 0) + 1;
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    coerceTestingTimestamps(safe);
    const cocErr = await applyCocSignature(safe, actor?.fullName ?? null, actor?.initials ?? null);
    if (cocErr) { res.status(400).json({ error: cocErr }); return; }
    const [result] = await db.insert(batchTestingTable).values({ ...safe, batchId: id, sequenceNumber } as typeof batchTestingTable.$inferInsert).returning();
    res.status(201).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to add test result");
    res.status(500).json({ error: `Failed to add test result: ${msg}` });
  }
});

// Session 69 — path aligned to the OpenAPI spec + generated client
// (operationId updateBatchTestResult → PATCH /batch-testing/{id}). It was
// previously "/batch-test-results/:id", which no client called, so the update
// endpoint was effectively unreachable (same class of bug as the S67
// labeling-approve path mismatch). No other caller referenced the old path.
router.patch("/batch-testing/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (BATCH_TESTING_ALLOWED.has(k)) safe[k] = v;
    }
    if (Object.prototype.hasOwnProperty.call(safe, "phase")) {
      const phase = safe.phase as string;
      if (!BATCH_TESTING_PHASES.has(phase)) {
        res.status(400).json({ error: `Invalid phase "${phase}". Must be "pre_test" or "result".` });
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(safe, "testingAgencyId")) {
      const agencyErr = await validateTestingAgency(safe.testingAgencyId as number | null | undefined);
      if (agencyErr) { res.status(409).json({ error: agencyErr }); return; }
    }
    const [before] = await db.select().from(batchTestingTable).where(eq(batchTestingTable.id, id));
    const cocActor = await getOrProvisionCurrentUser(req).catch(() => null);
    coerceTestingTimestamps(safe);
    const cocErr = await applyCocSignature(safe, cocActor?.fullName ?? null, cocActor?.initials ?? null);
    if (cocErr) { res.status(400).json({ error: cocErr }); return; }
    const [result] = await db
      .update(batchTestingTable)
      .set({ ...safe, updatedAt: new Date() })
      .where(eq(batchTestingTable.id, id))
      .returning();
    if (!result) { res.status(404).json({ error: "Test result not found" }); return; }
    // Session 100 — audit test-result edits (previously unlogged), attributed to
    // the signed-in user (Part 11) under the "batch_testing" table name.
    const testAuditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    try {
      await db.insert(auditLogTable).values({
        tableName: "batch_testing",
        rowId: id,
        operation: "UPDATE",
        changedBy: testAuditActor?.id ?? null,
        changedByName: testAuditActor?.fullName ?? null,
        beforeState: (before ?? null) as never,
        afterState: result as never,
      });
    } catch (e) {
      req.log.error({ err: e, testId: id }, "Audit log write failed (edit kept)");
    }
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to update test result");
    res.status(500).json({ error: `Failed to update test result: ${msg}` });
  }
});

// Session 101 (#A) — PULL lab results from the state track-and-trace system
// (Metrc now / BioTrack later) for a test-sample tag, and land them on the row.
// Read-only against the provider; contaminant pass/fail is the lab's call, while
// potency acceptance (THC vs label claim) is computed here against the facility's
// configurable tolerance (Metrc does NOT fail on THC variance). Pulling fresh
// results clears any prior verification signature.
router.post("/batch-testing/:id/pull", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.select().from(batchTestingTable).where(eq(batchTestingTable.id, id));
    if (!row) { res.status(404).json({ error: "Test result not found" }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to pull lab results." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Pulling lab results requires Supervisor / Manager / Quality / Admin. Your role is "${actor.role}".` });
      return;
    }

    const bodyTag = typeof (req.body as { sampleTag?: unknown })?.sampleTag === "string"
      ? ((req.body as { sampleTag: string }).sampleTag).trim() : "";
    const sampleTag = bodyTag || (row.sampleMetrcTag ?? "").trim();
    if (!sampleTag) {
      res.status(400).json({ error: "Record the test sample's Metrc tag before pulling results." });
      return;
    }

    // ⛔ Was `.limit(1)` on regulatory_config — whichever state's row came back
    // first. Potency tolerance and the tracking system are BOTH per-state, so a
    // two-state operator was having one state's numbers applied to the other's
    // batches. Resolved by the acting facility's state; falls back to the same
    // defaults (METRC, 10%) when that state has no configured rule set.
    const rules = getRegulatoryRulesForFacility(getActingFacilityId());
    const provider = getLabResultsProvider(rules.tracingSystem);
    const tolerancePct = rules.potencyTolerancePct;
    const license = getMetrcConfig()?.licenseNumber ?? undefined;

    let normalized;
    try {
      normalized = await provider.getResultsBySampleTag(sampleTag, license);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Lab-results provider error." });
      return;
    }

    if (!normalized) {
      await db.update(batchTestingTable)
        .set({ sampleMetrcTag: sampleTag, updatedAt: new Date() })
        .where(eq(batchTestingTable.id, id));
      res.json({ status: "pending", message: "No released lab results for this sample yet — it may still be out for testing." });
      return;
    }

    // Potency acceptance (in-app, configurable). Only when a label claim is on file.
    let withinTolerance: boolean | null = null;
    if (row.labClaimThc != null && row.labClaimThc > 0 && normalized.thcPct != null) {
      const pctDiff = Math.abs(normalized.thcPct - row.labClaimThc) / row.labClaimThc * 100;
      withinTolerance = pctDiff <= tolerancePct;
    }
    // Contaminant fail (the lab's call) drives overall Pass/Fail.
    const anyContamFail = [normalized.microbialsPass, normalized.pesticidesPass, normalized.heavyMetalsPass, normalized.residualSolventsPass]
      .some((p) => p === false);
    const testResult = anyContamFail ? "Fail" : "Pass";

    const [updated] = await db.update(batchTestingTable).set({
      sampleMetrcTag: sampleTag,
      phase: "result",
      testResult,
      resultDate: normalized.resultDate ?? row.resultDate,
      testingAgency: normalized.labFacilityName ?? row.testingAgency,
      thcPct: normalized.thcPct ?? row.thcPct,
      cbdPct: normalized.cbdPct ?? row.cbdPct,
      totalCannabinoids: normalized.totalCannabinoids ?? row.totalCannabinoids,
      thcMgPerServing: normalized.thcMgPerServing,
      cbdMgPerServing: normalized.cbdMgPerServing,
      thcMgPerPackage: normalized.thcMgPerPackage,
      cbdMgPerPackage: normalized.cbdMgPerPackage,
      microbialsPass: normalized.microbialsPass ?? row.microbialsPass,
      pesticidesPass: normalized.pesticidesPass ?? row.pesticidesPass,
      heavyMetalsPass: normalized.heavyMetalsPass ?? row.heavyMetalsPass,
      residualSolventsPass: normalized.residualSolventsPass ?? row.residualSolventsPass,
      potencyWithinTolerance: withinTolerance,
      pullSource: normalized.provider,
      pulledAt: new Date(),
      labResultRaw: normalized as never,
      // A fresh pull invalidates any prior verification — must be re-reviewed.
      verifiedByName: null, verifiedByInitials: null, verifiedMeaning: null, verifiedAt: null,
      updatedAt: new Date(),
    }).where(eq(batchTestingTable.id, id)).returning();

    try {
      await db.insert(auditLogTable).values({
        tableName: "batch_testing", rowId: id, operation: "PULL_LAB_RESULTS",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: { testResult: row.testResult } as never,
        afterState: { provider: normalized.provider, testResult, potencyWithinTolerance: withinTolerance, sampleTag } as never,
      });
    } catch (e) { req.log.error({ err: e, testId: id }, "Audit write failed (pull kept)"); }

    res.json({ status: "pulled", testResult, potencyWithinTolerance: withinTolerance, result: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to pull lab results");
    res.status(500).json({ error: "Failed to pull lab results" });
  }
});

// Session 101 (#A) — VERIFY pulled lab results with a Part 11 e-signature. Only a
// verified, passing result may drive a printed compliance label. Requires an
// approver role, matching initials, and that results have actually been pulled.
router.post("/batch-testing/:id/verify", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning } = (req.body ?? {}) as { initials?: string; signatureMeaning?: string };
    if (!initials || !signatureMeaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return;
    }
    const [row] = await db.select().from(batchTestingTable).where(eq(batchTestingTable.id, id));
    if (!row) { res.status(404).json({ error: "Test result not found" }); return; }
    if (!row.pulledAt && row.pullSource == null) {
      res.status(409).json({ error: "Pull the lab results before verifying them." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required to verify." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Verifying results requires Supervisor / Manager / Quality / Admin. Your role is "${actor.role}".` });
      return;
    }
    if ((actor.initials ?? "").toUpperCase() !== initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }
    const [updated] = await db.update(batchTestingTable).set({
      verifiedByName: actor.fullName,
      verifiedByInitials: initials.trim().toUpperCase(),
      verifiedMeaning: signatureMeaning.trim(),
      verifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(batchTestingTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "batch_testing", rowId: id, operation: "VERIFY_LAB_RESULTS",
        changedBy: actor.id, changedByName: actor.fullName,
        afterState: { verifiedByName: actor.fullName, meaning: signatureMeaning.trim() } as never,
      });
    } catch (e) { req.log.error({ err: e, testId: id }, "Audit write failed (verify kept)"); }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to verify lab results");
    res.status(500).json({ error: "Failed to verify lab results" });
  }
});

router.get("/batch-records/:id/labeling", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [labeling] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!labeling) { res.status(404).json({ error: "Labeling record not found" }); return; }
    res.json(labeling);
  } catch (err) {
    req.log.error({ err }, "Failed to get labeling");
    res.status(500).json({ error: "Failed to get labeling" });
  }
});

router.patch("/batch-records/:id/labeling", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!existing) {
      const [labeling] = await db.insert(batchLabelingTable).values({ ...req.body, batchId: id }).returning();
      res.json(labeling); return;
    }
    const [labeling] = await db.update(batchLabelingTable).set({ ...req.body, updatedAt: new Date() }).where(eq(batchLabelingTable.id, existing.id)).returning();
    res.json(labeling);
  } catch (err) {
    req.log.error({ err }, "Failed to update labeling");
    res.status(500).json({ error: "Failed to update labeling" });
  }
});

// Session 40 (Tier 3 #12b) — Auto-populate the labeling row + checklist for a
// batch. Idempotent: the operator can hit this every time they open the print
// dialog without duplicating rows. The batch_labeling row is created if
// missing (with sane defaults pulled from the batch + selected template), and
// checklist items for the batch's product type are inserted from the
// hardcoded LABEL_CHECKLIST_TEMPLATES set. Existing per-batch responses are
// preserved across re-runs (we look up items by (labelingId, itemNumber) and
// skip any that already exist).
//
// Body (all optional): { templateId, labelVersion, metrcTagNumber, labelNotes }
// Returns: { labeling, items, seededCount }
router.post("/batch-records/:id/labeling/auto-populate", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad batch id" }); return; }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    const { templateId, labelVersion, metrcTagNumber, labelNotes } =
      (req.body ?? {}) as { templateId?: number; labelVersion?: string | null; metrcTagNumber?: string | null; labelNotes?: string | null };

    // Pull the template if one was passed so labelVersion defaults match the
    // chosen template's version. Template is optional — operator may want to
    // seed the checklist before picking a template.
    let template: { id: number; name: string; version: number } | null = null;
    if (typeof templateId === "number" && !Number.isNaN(templateId)) {
      const [row] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, templateId));
      if (row) template = { id: row.id, name: row.name, version: row.version };
    }

    // Session 68 — resolve via the alias map so dropdown values whose
    // label differs from the template key (e.g. "Vape Cartridge" → Vape) and the
    // ingestible aliases (Tincture/Capsule → Edible, Other → Generic) seed a real
    // checklist instead of []. A still-empty result is caught by the fail-closed
    // approval gate below, so an unmapped type can never be approved blank.
    // Follow-up (06-24) — saleType selects the control set: a Bulk/Wholesale
    // batch gets the transfer-label checklist instead of the consumer one.
    // Phase 5 — the question set comes from the facility's STATE, not from the
    // constants in batch_labeling.ts. Michigan's set is seeded onto its rule set
    // at boot from those same constants, so this resolves to identical questions
    // until step 2 replaces the content. A state with no set configured falls
    // back to the code, which is what every facility did before this change.
    const actingFacilityId = getActingFacilityId();
    const stateChecklists = getLabelChecklistsForFacility(actingFacilityId);
    const allSeeds = checklistTemplateFrom(
      stateChecklists ?? LABEL_CHECKLIST_TEMPLATES,
      batch.productType,
      batch.saleType,
    );

    // ⛔ Label-control step 2 (2026-08-31) — THE CHECKLIST IS THE REMAINDER.
    //
    //   the state's requirements for this product type
    //     − what the approved PACKAGING for this product type carries
    //     = what is asked before this print
    //
    // His model: a pouch already carrying the pregnancy and poison-control
    // warnings had those verified ONCE when the design was approved, so asking
    // again before every print is noise that trains people to tick without
    // reading. Nothing links this batch to a design — coverage is derived from
    // the product type, and where several designs are approved for it a
    // requirement is dropped only when EVERY one of them carries it.
    //
    // ⛔ This REPLACES the facility-level assignment read that stood here. One
    // answer per site was the wrong shape: coverage belongs to the artefact that
    // does the carrying. The table itself comes out at step 5.
    //
    // ⛔ NOTHING WITHOUT A KEY IS EVER DROPPED. It cannot have been claimed by a
    // design, and silently removing a compliance question we failed to identify
    // would be the worst failure mode available here.
    const batchState = getFacilityState(batch.facilityId ?? actingFacilityId);
    const coverage = await getPackagingCoverage(batch.productType, batchState, batch);
    // ⛔ Label-control step 4 (2026-08-31) — and what the approved LABEL carries.
    // The batch PULLS its product's one approved template; there is no picker,
    // for the same reason there is none for packaging. Packaging is subtracted
    // FIRST, so a requirement both artefacts carry is reported once, against the
    // pouch — the thing verified earliest and least likely to change.
    const labelCoverage = await getLabelTemplateCoverage(batch);
    const labelKeys = new Set([...labelCoverage.carried].filter((k) => !coverage.keys.has(k)));
    const seeds = allSeeds.filter((it) => !it.key || !(coverage.keys.has(it.key) || labelKeys.has(it.key)));
    const covered = allSeeds.filter((it) => !!it.key && coverage.carried.has(it.key));
    const notApplicable = allSeeds.filter((it) => !!it.key && coverage.notApplicable.has(it.key));
    const coveredByLabel = allSeeds.filter((it) => !!it.key && labelKeys.has(it.key));

    const result = await db.transaction(async (tx) => {
      // Ensure the labeling row exists. We don't blast existing values on
      // re-run — only the missing pieces get defaults. METRC tag, label
      // version, and notes are explicit body params (so the caller can
      // refresh those on demand) while productType always mirrors the batch.
      const [existing] = await tx.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
      let labeling = existing ?? null;
      if (!labeling) {
        const [created] = await tx.insert(batchLabelingTable).values({
          batchId: id,
          productType: batch.productType,
          labelVersion: labelVersion ?? (template ? `${template.name} v${template.version}` : null),
          metrcTagNumber: metrcTagNumber ?? batch.metrcPackageId ?? null,
          labelNotes: labelNotes ?? null,
        }).returning();
        labeling = created ?? null;
      } else {
        const patch: Record<string, unknown> = {};
        if (labelVersion !== undefined) patch.labelVersion = labelVersion;
        else if (!labeling.labelVersion && template) patch.labelVersion = `${template.name} v${template.version}`;
        if (metrcTagNumber !== undefined) patch.metrcTagNumber = metrcTagNumber;
        else if (!labeling.metrcTagNumber && batch.metrcPackageId) patch.metrcTagNumber = batch.metrcPackageId;
        if (labelNotes !== undefined) patch.labelNotes = labelNotes;
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = new Date();
          const [updated] = await tx.update(batchLabelingTable).set(patch).where(eq(batchLabelingTable.id, labeling.id)).returning();
          labeling = updated ?? labeling;
        }
      }

      if (!labeling) throw new Error("Failed to create labeling row");

      // Seed checklist items idempotently. We only INSERT items whose
      // itemNumber isn't already present for this labelingId — re-running
      // never duplicates and never clobbers existing operator responses.
      let existingItems = await tx.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id));
      // Follow-up (06-24) — if the desired checklist no longer matches what was
      // seeded before (e.g. the operator switched the batch's sale type from
      // Retail to Bulk, or vice versa) AND no responses have been recorded yet,
      // wipe and reseed so the new control set takes effect. We refuse to clobber
      // a checklist that already has ANY answer — a sale-type change after the
      // operator has started verifying must be handled deliberately, not silently.
      if (existingItems.length > 0) {
        const desiredTexts = new Set(seeds.map((s) => s.itemText));
        const mismatch =
          existingItems.some((i) => !desiredTexts.has(i.itemText)) ||
          seeds.some((s) => !existingItems.some((i) => i.itemText === s.itemText));
        if (mismatch) {
          const itemIds = existingItems.map((i) => i.id);
          const responses = itemIds.length
            ? await tx.select({ id: checklistResponsesTable.id }).from(checklistResponsesTable).where(inArray(checklistResponsesTable.checklistItemId, itemIds))
            : [];
          if (responses.length === 0) {
            await tx.delete(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id));
            existingItems = [];
          }
        }
      }
      const existingNumbers = new Set(existingItems.map((i) => i.itemNumber));
      const toInsert = seeds.filter((s) => !existingNumbers.has(s.itemNumber));
      if (toInsert.length > 0) {
        await tx.insert(checklistItemsTable).values(toInsert.map((s) => ({
          labelingId: labeling!.id,
          productType: batch.productType,
          itemNumber: s.itemNumber,
          itemText: s.itemText,
          regulationRef: s.regulationRef,
          required: s.required ? "true" : "false",
          control: s.control ?? null,
          requirementKey: s.key ?? null,
        })));
      }

      const allItems = await tx.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id)).orderBy(checklistItemsTable.itemNumber);

      // Audit the auto-populate event — useful when investigating "where did
      // this checklist come from?" months later.
      await tx.insert(auditLogTable).values({
        tableName: "batch_labeling",
        rowId: labeling.id,
        operation: "auto-populate",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: null,
        afterState: { seededCount: toInsert.length, totalItems: allItems.length, templateId: template?.id ?? null } as never,
      });

      // `covered` travels with the answer so a SHORTER checklist can never read
      // as a shorter rule — the batch screen names what the packaging carries
      // and which approved design carries it.
      return {
        labeling,
        items: allItems,
        seededCount: toInsert.length,
        covered: covered.map((c) => ({ key: c.key, itemText: c.itemText, regulationRef: c.regulationRef })),
        notApplicable: notApplicable.map((c) => ({ key: c.key, itemText: c.itemText, regulationRef: c.regulationRef })),
        coveringDesigns: coverage.designs,
        coveredByLabel: coveredByLabel.map((c) => ({ key: c.key, itemText: c.itemText, regulationRef: c.regulationRef })),
        coveringTemplates: labelCoverage.templates,
      };
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to auto-populate labeling");
    res.status(500).json({ error: "Failed to auto-populate labeling" });
  }
});

// Session 67 (Item 5) — labeling approval, reconciled with the API spec + client.
// Path is now /batch-labeling/:id/approve (what the generated client actually
// calls; the old /batch-records/:id/labeling/approve had no matching client and
// the body field name was wrong, so this endpoint was effectively unreachable).
// The signer's IDENTITY comes from the authenticated session (Part 11), not a
// client-supplied userId; the meaning is persisted to its own column instead of
// being mis-stored into approvalName.
router.post("/batch-labeling/:id/approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials?.trim() || !meaning?.trim()) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    // Session 76.2 (OQ DEV-2) — Part 11 role gate. Label approval is an approver
    // act, like NC/FA close, CAPA Gate 1, and label-template approval. Previously
    // only initials-match + checklist-complete were enforced, so an Operator
    // could sign a labeling approval. Restrict to an approver role server-side.
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Approving a batch label requires Supervisor / Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." });
      return;
    }
    const [existing] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!existing) { res.status(404).json({ error: "Labeling record not found" }); return; }

    // Session 67 (Item 5 gate) — every REQUIRED R 420.504 checklist item must be
    // answered Pass or N/A before a Part 11 labeling approval can be signed.
    // Server-side enforcement; the UI also disables the button.
    const checkItems = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, existing.id));

    // Session 68 — FAIL CLOSED on an empty checklist. Previously this gate was
    // skipped entirely when there were no required items, so a batch whose
    // product type seeded zero checklist items (e.g. the old "Vape Cartridge"
    // key mismatch) could be labeling-approved with a Part 11 signature
    // attesting to NOTHING. A batch with no checklist has nothing to verify, so
    // approval is blocked until a checklist is seeded for its product type.
    if (checkItems.length === 0) {
      res.status(409).json({
        error: `No labeling checklist exists for product type "${existing.productType}". Seed the R 420.504 checklist (Start/Refresh Labeling Approval) before approving. If this product type has no template, it cannot be approved until one is added.`,
      });
      return;
    }

    const requiredItems = checkItems.filter((it) => String(it.required) === "true");
    if (requiredItems.length > 0) {
      const reqIds = requiredItems.map((it) => it.id);
      const responses = await db.select().from(checklistResponsesTable)
        .where(inArray(checklistResponsesTable.checklistItemId, reqIds));
      const respByItem = new Map(responses.map((r) => [r.checklistItemId, String(r.response ?? "")]));
      const incomplete = requiredItems.filter((it) => {
        const v = respByItem.get(it.id);
        return v !== "Pass" && v !== "N/A";
      });
      if (incomplete.length > 0) {
        res.status(409).json({
          error: `Complete the labeling checklist before approving - ${incomplete.length} of ${requiredItems.length} required item(s) still need a Pass or N/A.`,
        });
        return;
      }
    }

    const [labeling] = await db.update(batchLabelingTable).set({
      approvedBy: actor.id,
      approvalInitials: initials.trim().toUpperCase(),
      approvalName: actor.fullName,
      approvalMeaning: meaning.trim(),
      approvalDate: new Date(),
      updatedAt: new Date(),
    }).where(eq(batchLabelingTable.id, existing.id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "LABELING_APPROVE",
      changedByName: actor.fullName,
      changedById: actor.id,
      beforeState: existing as unknown as Record<string, unknown>,
      afterState: { ...(labeling as unknown as Record<string, unknown>), signingMeaning: meaning.trim() },
    });
    res.json(labeling);
  } catch (err) {
    req.log.error({ err }, "Failed to approve labeling");
    // Session 67 - surface the real cause to the client so the failure is
    // self-diagnosing in the toast (no Railway log digging needed).
    res.status(500).json({ error: `Failed to approve labeling: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.get("/batch-records/:id/checklist", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [labeling] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!labeling) { res.json([]); return; }
    const items = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id)).orderBy(checklistItemsTable.itemNumber);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Failed to list checklist items");
    res.status(500).json({ error: "Failed to list checklist items" });
  }
});

router.get("/batch-records/:id/checklist-detail", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [labeling] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, id));
    if (!labeling) { res.json({ items: [], responses: [] }); return; }
    const items = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id)).orderBy(checklistItemsTable.itemNumber);
    const itemIds = items.map(i => i.id);
    const responses = itemIds.length > 0
      ? await db.select().from(checklistResponsesTable).where(inArray(checklistResponsesTable.checklistItemId, itemIds))
      : [];
    // What the approved packaging carries, so the screen can say why the list is
    // shorter than the rule. Read live rather than stored: if a design is
    // superseded, the next look tells the truth.
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    const coverage = batch
      ? await getPackagingCoverage(batch.productType, getFacilityState(batch.facilityId ?? getActingFacilityId()), batch)
      : { carried: new Set<string>(), notApplicable: new Set<string>(), keys: new Set<string>(), designs: [] };
    const seedSet = batch
      ? checklistTemplateFrom(
          getLabelChecklistsForFacility(batch.facilityId ?? getActingFacilityId()) ?? LABEL_CHECKLIST_TEMPLATES,
          batch.productType,
          batch.saleType,
        )
      : [];
    const shape = (it: { key: string; itemText: string; regulationRef: string }) =>
      ({ key: it.key, itemText: it.itemText, regulationRef: it.regulationRef });
    const covered = seedSet.filter((it) => !!it.key && coverage.carried.has(it.key)).map(shape);
    const notApplicable = seedSet.filter((it) => !!it.key && coverage.notApplicable.has(it.key)).map(shape);
    // Step 4 — and what the product's one approved label carries. Read live for
    // the same reason: retire the template and the next look asks again.
    // Packaging wins a tie, so nothing is named twice.
    const labelCoverage = batch
      ? await getLabelTemplateCoverage(batch)
      : { carried: new Set<string>(), templates: [] };
    const coveredByLabel = seedSet
      .filter((it) => !!it.key && labelCoverage.carried.has(it.key) && !coverage.keys.has(it.key))
      .map(shape);
    // ⛔ The ingredient tripwire (2026-09-02). Artwork that prints the
    // ingredients and was approved BEFORE this recipe's contents last changed is
    // out of date, and the export route refuses to print it. Reported here so the
    // screen says so before somebody clicks, rather than only at the refusal.
    const staleArtwork = batch
      ? await getStaleIngredientArtwork(batch, getFacilityState(batch.facilityId ?? getActingFacilityId()))
      : [];
    res.json({
      items, responses, covered, notApplicable,
      coveringDesigns: coverage.designs,
      coveredByLabel,
      coveringTemplates: labelCoverage.templates,
      staleArtwork,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load checklist detail");
    res.status(500).json({ error: "Failed to load checklist detail" });
  }
});

router.post("/batch-records/:id/checklist/respond", async (req, res) => {
  try {
    const { checklistItemId, response, notes, respondedBy, respondedByName } = req.body as {
      checklistItemId: number; response: string; notes?: string; respondedBy?: number; respondedByName?: string;
    };
    const existing = await db.select().from(checklistResponsesTable).where(eq(checklistResponsesTable.checklistItemId, checklistItemId));
    let saved;
    if (existing.length > 0) {
      [saved] = await db.update(checklistResponsesTable).set({ response, notes, respondedBy, respondedByName, updatedAt: new Date() }).where(eq(checklistResponsesTable.checklistItemId, checklistItemId)).returning();
    } else {
      [saved] = await db.insert(checklistResponsesTable).values({ checklistItemId, response, notes, respondedBy, respondedByName }).returning();
    }
    // Session 67 (Item 5) — keep the labeling row's checklistCompletePct in sync so
    // the Labeling card % and the approval gate reflect the latest responses.
    const [item] = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.id, checklistItemId));
    if (item) {
      const allItems = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, item.labelingId));
      const required = allItems.filter((i) => String(i.required) === "true");
      const scope = required.length > 0 ? required : allItems;
      const ids = allItems.map((i) => i.id);
      const resps = ids.length > 0
        ? await db.select().from(checklistResponsesTable).where(inArray(checklistResponsesTable.checklistItemId, ids))
        : [];
      const rmap = new Map(resps.map((r) => [r.checklistItemId, String(r.response ?? "")]));
      const passed = scope.filter((i) => { const v = rmap.get(i.id); return v === "Pass" || v === "N/A"; }).length;
      const pct = scope.length > 0 ? Math.round((passed / scope.length) * 100) : 0;
      await db.update(batchLabelingTable).set({ checklistCompletePct: pct, updatedAt: new Date() }).where(eq(batchLabelingTable.id, item.labelingId));
    }
    res.status(existing.length > 0 ? 200 : 201).json(saved);
  } catch (err) {
    req.log.error({ err }, "Failed to save checklist response");
    res.status(500).json({ error: "Failed to save checklist response" });
  }
});

// ── Label data auto-fill (THC/CBD %, mg, ingredients sorted desc) ────────────
//
// Aggregates the most recent passing test result + all batch ingredients into a
// single payload sized for the back-of-package "Label Data" section. Quantities
// in mg are computed from %THC/%CBD assuming the product weight reported on the
// label matches the planned batch weight (front-end can override the basis).

router.get("/batch-records/:id/label-data", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    const tests = await db.select().from(batchTestingTable)
      .where(eq(batchTestingTable.batchId, id))
      .orderBy(desc(batchTestingTable.sequenceNumber));
    // Strict: only a passing result may auto-populate the label.
    const latestTest = tests.find((t) => t.testResult === "Pass") ?? null;

    const ingredients = await db.select().from(batchIngredientsTable)
      .where(eq(batchIngredientsTable.batchId, id));
    // Session 82 (#7) — the label's ingredient list carries ONLY consumable
    // ingredients, in descending order by weight (MI MRA R 420.702(3)). Packaging
    // "Material" rows (pre-roll cones, filters, cartridges, labels) are physical
    // components of the unit but are NOT label ingredients, so they're excluded
    // from this list. Their provenance is still captured on the batch and is
    // verified separately (e.g. the non-hemp cone-material checklist item).
    const ingredientRows = ingredients.filter((i) => (i.kind ?? "Ingredient") === "Ingredient");
    const sortedIngredients = [...ingredientRows].sort((a, b) => {
      const aq = a.actualQuantity ?? a.plannedQuantity ?? 0;
      const bq = b.actualQuantity ?? b.plannedQuantity ?? 0;
      return bq - aq;
    });

    // Session 66 — potency is basis-aware. Session 58 stores edible potency as
    // mg/serving in result_values and leaves the legacy %-by-weight columns null;
    // flower/concentrate stay on % (result_values percent keys, then legacy
    // columns). The original label-data only read the legacy % columns, so edible
    // batches showed no THC/CBD/Total Cannabinoids on label verification. Resolve
    // from result_values first with a fallback to the legacy columns, and tell the
    // client which basis applies so it can render the right unit.
    const rv = (latestTest?.resultValues ?? {}) as Record<string, number | string | null | undefined>;
    const isMgPerServing = rv["potency_basis"] === "mg_per_serving";
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;

    // Percent basis (flower / concentrate): result_values percent keys, then legacy columns.
    const thcPct = isMgPerServing ? null : (num(rv["thc_pct"]) ?? latestTest?.thcPct ?? null);
    const cbdPct = isMgPerServing ? null : (num(rv["cbd_pct"]) ?? latestTest?.cbdPct ?? null);
    const totalCannabinoidsPct = isMgPerServing ? null : (num(rv["total_cannabinoids"]) ?? latestTest?.totalCannabinoids ?? null);
    const thcMgPerGram = thcPct != null ? Math.round(thcPct * 10 * 100) / 100 : null;
    const cbdMgPerGram = cbdPct != null ? Math.round(cbdPct * 10 * 100) / 100 : null;

    // mg/serving basis (edibles): result_values mg-per-serving keys.
    const thcMgPerServing = isMgPerServing ? num(rv["thc_mg_per_serving"]) : null;
    const cbdMgPerServing = isMgPerServing ? num(rv["cbd_mg_per_serving"]) : null;
    const totalCannabinoidsMgPerServing = isMgPerServing ? num(rv["total_cannabinoids_mg_per_serving"]) : null;

    let ldRecipe: typeof recipesTable.$inferSelect | undefined;
    if (batch.recipeId != null) {
      [ldRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, batch.recipeId));
    }
    res.json({
      batchId: id,
      batchNumber: batch.batchNumber,
      productName: batch.productName,
      productType: batch.productType,
      labelNetWeight: batch.labelNetWeight ?? null,
      labelNetWeightUnit: batch.labelNetWeightUnit ?? null,
      recipeNetWeight: ldRecipe?.netWeight ?? null,
      recipeNetWeightUnit: ldRecipe?.netWeightUnit ?? null,
      testing: latestTest ? {
        sequenceNumber: latestTest.sequenceNumber,
        testingAgency: latestTest.testingAgency,
        resultDate: latestTest.resultDate,
        testResult: latestTest.testResult,
        potencyBasis: isMgPerServing ? "mg_per_serving" : "percent",
        thcPct,
        cbdPct,
        totalCannabinoids: totalCannabinoidsPct,
        thcMgPerGram,
        cbdMgPerGram,
        thcMgPerServing,
        cbdMgPerServing,
        totalCannabinoidsMgPerServing,
        coaUrl: latestTest.coaUrl,
        microbialsPass: latestTest.microbialsPass,
        pesticidesPass: latestTest.pesticidesPass,
        heavyMetalsPass: latestTest.heavyMetalsPass,
        residualSolventsPass: latestTest.residualSolventsPass,
      } : null,
      ingredients: sortedIngredients.map((ing) => ({
        id: ing.id,
        ingredientName: ing.ingredientName,
        quantity: ing.actualQuantity ?? ing.plannedQuantity ?? 0,
        unitOfMeasure: ing.unitOfMeasure,
        lotNumber: ing.lotNumber,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute label data");
    res.status(500).json({ error: "Failed to compute label data" });
  }
});

// ─── Labeling — per-package DATA EXPORT (bring-your-own label software) ─────
//
// Governing architecture (Jonathan 2026-07-22): CannaQMS houses NO label
// templates and RENDERS NO labels. Its job is to SUPPLY each package's correct
// VARIABLE data — keyed to the METRC package tag — as a standard-column file
// (CSV/JSON) that the facility's own label program (BarTender/CodeSoft/
// NiceLabel/etc.) merges into its approved template. Field names below are the
// PUBLISHED CONTRACT: the facility maps our column names → their template slots
// ONCE at setup. Do not rename a column without telling the facility.
//
// Field basis: MI CRA R 420.504(1)(a)-(j) (every product) + R 420.403(7) (infused/
// edible product name + ingredients). STATIC content (universal symbol, the
// warning statements, poison-control line, activation-time pictogram) lives on
// the facility's APPROVED template, not in this data file.

// Per-product-type shelf life used to COMPUTE the expiration date.
//
// Expiration = passing TEST result date + N days (Michigan practice, Jonathan
// 2026-07-22): product may sit in bulk until tested, so the shelf-life clock
// starts at the PASSING test date, NOT the production date. No passing test →
// no expiration (and the product can't be sold anyway). The day counts below
// are the editable shelf-life policy — this is the single place to change them.
// Edibles carry a REQUIRED expiration (R 420.403) that must not be altered once
// affixed (R 420.502(4)).
const LABEL_SHELF_LIFE_DAYS: Record<string, number> = {
  Flower: 365,
  "Pre-Roll": 365,
  "Infused Pre-Roll": 365,
  "Vape Cartridge": 365,
  "Dual Chamber Vape Cartridge": 365,
  Concentrate: 365,
  Tincture: 365,
  Topical: 365,
  Edible: 180,
  Capsule: 180,
};
const LABEL_SHELF_LIFE_FALLBACK_DAYS = 365;

function computeExpirationDate(productType: string | null | undefined, baseDate: string | Date | null | undefined, shelfLifeDaysOverride?: number | null): string | null {
  if (!baseDate) return null;
  const base = typeof baseDate === "string" ? new Date(baseDate + "T00:00:00Z") : new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()));
  if (Number.isNaN(base.getTime())) return null;
  const days = shelfLifeDaysOverride != null
    ? shelfLifeDaysOverride
    : ((productType && LABEL_SHELF_LIFE_DAYS[productType]) || LABEL_SHELF_LIFE_FALLBACK_DAYS);
  base.setUTCDate(base.getUTCDate() + days);
  return facilityDateStr(base);
}

// Expand a first–last METRC tag RANGE into individual tags. METRC range tags
// share a fixed leading prefix and differ only in a trailing zero-padded
// counter, so we split the numeric suffix and enumerate. Returns null when the
// range can't be safely enumerated (mismatched prefixes, non-numeric suffix, or
// an implausibly large span) — the caller then emits one row for the range.
function expandMetrcRange(start: string | null, end: string | null, count: number | null): string[] | null {
  if (!start || !end) return null;
  const m1 = start.trim().match(/^(.*?)(\d+)$/);
  const m2 = end.trim().match(/^(.*?)(\d+)$/);
  if (!m1 || !m2 || m1[1] !== m2[1]) return null;
  const width = m1[2].length;
  const a = parseInt(m1[2], 10);
  const b = parseInt(m2[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const n = b - a + 1;
  if (n > 5000) return null; // safety guard against a runaway CSV
  if (count && Number.isFinite(count) && count > 0 && count !== n) {
    // Trust the explicit rangeCount if it disagrees with the span (torn range).
    if (count > 5000) return null;
  }
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(m1[1] + String(i).padStart(width, "0"));
  return out;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The published column contract. Order is stable; add new columns at the END so
// an existing facility mapping never shifts.
// A METRC package quantity is only a valid NET WEIGHT when its unit is an
// actual weight (bulk flower in grams). For count-based products (carts, pre-
// rolls, edibles tracked as "Each") the count is NOT a weight - the per-unit
// size comes from the batch override or the recipe instead.
const WEIGHT_UNITS = new Set(["g","gram","grams","mg","milligram","milligrams","kg","oz","ounce","ounces","lb","lbs"]);
function isWeightUnit(u: string | null | undefined): boolean {
  return WEIGHT_UNITS.has((u ?? "").trim().toLowerCase());
}

const LABEL_EXPORT_COLUMNS = [
  "metrc_package_tag",
  "product_name",
  "product_type",
  "strain",
  "net_weight",
  "net_weight_unit",
  "thc_value",
  "thc_unit",
  "cbd_value",
  "cbd_unit",
  "total_cannabinoids_value",
  "total_cannabinoids_unit",
  "potency_variance_statement",
  "testing_lab",
  "test_analysis_date",
  "date_produced",
  "date_tested",
  "expiration_date",
  "batch_number",
  "producer_name",
  "producer_license",
  "packager_name",
  "packager_license",
  "ingredients",
  "serving_size",
  "serving_strength_mg",
  "servings_per_package",
  "activation_time",
] as const;

router.get("/batch-records/:id/label-export", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const format = (req.query.format === "json" ? "json" : "csv");
    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    // ⛔ THE INGREDIENT TRIPWIRE — his ruling 2026-09-02. This route is the real
    // print: it hands over the data file the label software prints from and logs
    // a print run. Artwork that prints the ingredients and was approved before
    // the recipe's contents last changed is a false statement waiting to go on a
    // package, so the file is refused until somebody has looked and re-approved.
    //
    // ⚠️ The RECIPE edit was never blocked and must not be — a label does not get
    // to stop production changing a recipe. Only the printing stops.
    const stale = await getStaleIngredientArtwork(batch, getFacilityState(batch.facilityId ?? getActingFacilityId()));
    if (stale.length > 0) {
      res.status(409).json({ error: staleArtworkMessage(stale), staleArtwork: stale });
      return;
    }

    // Latest PASSING test only — an unlabelable batch must not export potency.
    const tests = await db.select().from(batchTestingTable)
      .where(eq(batchTestingTable.batchId, id))
      .orderBy(desc(batchTestingTable.sequenceNumber));
    const latestTest = tests.find((t) => t.testResult === "Pass") ?? null;

    // Potency, basis-aware (mirrors the label-data endpoint).
    const rv = (latestTest?.resultValues ?? {}) as Record<string, number | string | null | undefined>;
    const isMgPerServing = rv["potency_basis"] === "mg_per_serving";
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const thcPct = isMgPerServing ? null : (num(rv["thc_pct"]) ?? latestTest?.thcPct ?? null);
    const cbdPct = isMgPerServing ? null : (num(rv["cbd_pct"]) ?? latestTest?.cbdPct ?? null);
    const totalPct = isMgPerServing ? null : (num(rv["total_cannabinoids"]) ?? latestTest?.totalCannabinoids ?? null);
    const thcMgServing = isMgPerServing ? num(rv["thc_mg_per_serving"]) : null;
    const cbdMgServing = isMgPerServing ? num(rv["cbd_mg_per_serving"]) : null;
    const totalMgServing = isMgPerServing ? num(rv["total_cannabinoids_mg_per_serving"]) : null;

    const thcValue = isMgPerServing ? thcMgServing : thcPct;
    const cbdValue = isMgPerServing ? cbdMgServing : cbdPct;
    const totalValue = isMgPerServing ? totalMgServing : totalPct;
    const potencyUnit = isMgPerServing ? "mg/serving" : "%";

    // Ingredients: consumable only, descending order by weight (R 420.403(7)).
    const ingredients = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, id));
    const ingredientsLine = ingredients
      .filter((i) => (i.kind ?? "Ingredient") === "Ingredient")
      .sort((a, b) => (b.actualQuantity ?? b.plannedQuantity ?? 0) - (a.actualQuantity ?? a.plannedQuantity ?? 0))
      .map((i) => i.ingredientName)
      .filter(Boolean)
      .join("; ");

    // Facility (producer / packager). Packager defaults to the producer; a
    // separate packager is a later enhancement.
    const [company] = await db.select().from(companyProfileTable).limit(1);
    const producerName = company?.companyName ?? "";
    const producerLicense = company?.licenseNumber ?? getMetrcConfig()?.licenseNumber ?? "";

    const dateProduced = batch.productionDate ? String(batch.productionDate) : "";
    const dateTested = latestTest?.resultDate ? String(latestTest.resultDate) : "";
    const [productSettings] = await db.select().from(productTypeSettingsTable).where(eq(productTypeSettingsTable.productType, batch.productType ?? ""));
    let labelRecipe: typeof recipesTable.$inferSelect | undefined;
    if (batch.recipeId != null) {
      [labelRecipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, batch.recipeId));
    }
    const expiration = computeExpirationDate(batch.productType, (latestTest?.resultDate as unknown as string) ?? null, productSettings?.shelfLifeDays ?? null);

    // Build the package tag list. One export ROW per package the batch produced,
    // sourced from the active (non-cancelled) METRC tag lineage; ranges expand to
    // one row each. Falls back to the batch's primary package tag, then to a
    // single row with no tag so a dry-run merge still gets the data.
    const tagRows = await db.select().from(batchMetrcTagsTable)
      .where(and(eq(batchMetrcTagsTable.batchId, id), sql`${batchMetrcTagsTable.cancelledAt} IS NULL`))
      .orderBy(asc(batchMetrcTagsTable.recordedAt), asc(batchMetrcTagsTable.id));

    type Pkg = { tag: string; netWeight: string; netWeightUnit: string };
    // Net weight priority: batch per-run override > (bulk) METRC package WEIGHT
    // > recipe default > batch output. A METRC "Each" COUNT is never a weight.
    const batchNW = batch.labelNetWeight != null ? String(batch.labelNetWeight) : "";
    const batchNWUnit = batch.labelNetWeightUnit ?? "";
    const recipeNW = labelRecipe?.netWeight != null ? String(labelRecipe.netWeight) : "";
    const recipeNWUnit = labelRecipe?.netWeightUnit ?? "";
    const defaultNetWeight = batchNW || recipeNW || (batch.outputQuantity != null && isWeightUnit(batch.unitOfMeasure) ? String(batch.outputQuantity) : "");
    const defaultNetUnit = batchNW
      ? (batchNWUnit || recipeNWUnit || batch.unitOfMeasure || "")
      : recipeNW
        ? (recipeNWUnit || batch.unitOfMeasure || "")
        : (batch.unitOfMeasure && isWeightUnit(batch.unitOfMeasure) ? batch.unitOfMeasure : "");
    const packages: Pkg[] = [];
    for (const row of tagRows) {
      const useMetrcWeight = !batchNW && row.quantity != null && isWeightUnit(row.uom);
      const nw = useMetrcWeight ? String(row.quantity) : defaultNetWeight;
      const nu = useMetrcWeight ? (row.uom ?? "") : defaultNetUnit;
      if (row.kind === "range" && (row.rangeStart || row.rangeEnd)) {
        const expanded = expandMetrcRange(row.rangeStart, row.rangeEnd, row.rangeCount ?? null);
        if (expanded) {
          for (const t of expanded) packages.push({ tag: t, netWeight: nw, netWeightUnit: nu });
        } else {
          packages.push({ tag: `${row.rangeStart ?? ""}–${row.rangeEnd ?? ""}`, netWeight: nw, netWeightUnit: nu });
        }
      } else if (row.metrcTag) {
        packages.push({ tag: row.metrcTag, netWeight: nw, netWeightUnit: nu });
      }
    }
    if (packages.length === 0) {
      packages.push({ tag: batch.metrcPackageId ?? "", netWeight: defaultNetWeight, netWeightUnit: defaultNetUnit });
    }

    const rows = packages.map((pkg) => ({
      metrc_package_tag: pkg.tag,
      product_name: batch.productName,
      product_type: batch.productType,
      strain: batch.strainName ?? "",
      net_weight: pkg.netWeight,
      net_weight_unit: pkg.netWeightUnit,
      thc_value: thcValue != null ? String(thcValue) : "",
      thc_unit: thcValue != null ? potencyUnit : "",
      cbd_value: cbdValue != null ? String(cbdValue) : "",
      cbd_unit: cbdValue != null ? potencyUnit : "",
      total_cannabinoids_value: totalValue != null ? String(totalValue) : "",
      total_cannabinoids_unit: totalValue != null ? potencyUnit : "",
      potency_variance_statement: (thcValue != null || cbdValue != null) ? "Actual value may vary from the reported value by 10%." : "",
      testing_lab: latestTest?.testingAgency ?? "",
      test_analysis_date: dateTested,
      date_produced: dateProduced,
      date_tested: dateTested,
      expiration_date: expiration ?? "",
      batch_number: batch.batchNumber,
      producer_name: producerName,
      producer_license: producerLicense,
      packager_name: producerName,
      packager_license: producerLicense,
      ingredients: ingredientsLine,
      serving_size: labelRecipe?.servingSize ?? "",
      serving_strength_mg: labelRecipe?.servingStrengthMg != null ? String(labelRecipe.servingStrengthMg) : "",
      servings_per_package: labelRecipe?.servingsPerPackage != null ? String(labelRecipe.servingsPerPackage) : "",
      activation_time: productSettings?.activationTime ?? "",
    }));

    // #3 - record this download as a print run (pending second-person
    // review). Preview uses /label-data, so this only fires on a real
    // data-file download. Fire-and-forget: a log failure never blocks the file.
    const runActor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (runActor) {
      void db.insert(batchLabelPrintsTable).values({
        batchId: id,
        printedById: runActor.id,
        printedByName: runActor.fullName,
        rowCount: rows.length,
        exportFormat: format,
      }).catch((err: unknown) => req.log.warn({ err, batchId: id }, "Failed to log label print run (non-blocking)"));
    }

    if (format === "json") {
      res.json({ batchId: id, batchNumber: batch.batchNumber, columns: LABEL_EXPORT_COLUMNS, rowCount: rows.length, rows });
      return;
    }

    const header = LABEL_EXPORT_COLUMNS.join(",");
    const body = rows.map((r) => LABEL_EXPORT_COLUMNS.map((c) => csvCell((r as Record<string, unknown>)[c])).join(",")).join("\r\n");
    const csv = header + "\r\n" + body + "\r\n";
    const safeBatch = String(batch.batchNumber).replace(/[^A-Za-z0-9._-]+/g, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="label-data_${safeBatch}.csv"`);
    res.send(csv);
  } catch (err) {
    req.log.error({ err }, "Failed to build label export");
    res.status(500).json({ error: "Failed to build label export" });
  }
});

// #3 - list label print runs for a batch, newest first, with review status.
router.get("/batch-records/:id/label-print-runs", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const runs = await db.select().from(batchLabelPrintsTable)
      .where(eq(batchLabelPrintsTable.batchId, id))
      .orderBy(desc(batchLabelPrintsTable.printedAt));
    res.json(runs);
  } catch (err) {
    req.log.error({ err }, "Failed to list label print runs");
    res.status(500).json({ error: "Failed to list label print runs" });
  }
});

// #3 - per-run second-person label review (21 CFR Part 11). A qualified
// reviewer (Quality/Supervisor/Admin) who did NOT run the print signs off that
// the printed labels were verified. Post-hoc: the run is already logged; this
// flips it from "pending" to "reviewed".
const LABEL_REVIEW_ROLES = new Set(["Quality", "Supervisor", "Admin"]);
router.post("/batch-label-prints/:id/review", async (req, res) => {
  try {
    const runId = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!LABEL_REVIEW_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Label print review requires Quality, Supervisor, or Admin role. Your role is "${actor.role}".` });
      return;
    }
    const { initials, signatureMeaning } = req.body as { initials?: string; signatureMeaning?: string };
    if (!initials?.trim() || !signatureMeaning?.trim()) {
      res.status(400).json({ error: "Initials and signature meaning are required (21 CFR Part 11)." }); return;
    }
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }
    const [run] = await db.select().from(batchLabelPrintsTable).where(eq(batchLabelPrintsTable.id, runId));
    if (!run) { res.status(404).json({ error: "Print run not found." }); return; }
    if (run.reviewStatus === "reviewed") { res.status(409).json({ error: "This print run has already been reviewed." }); return; }
    if (run.printedById != null && run.printedById === actor.id) {
      res.status(403).json({ error: "The reviewer must be a different person than who ran the print (21 CFR Part 11)." }); return;
    }
    const [updated] = await db.update(batchLabelPrintsTable).set({
      reviewStatus: "reviewed",
      reviewedById: actor.id,
      reviewedByName: actor.fullName,
      reviewerInitials: initials.trim(),
      reviewerMeaning: signatureMeaning.trim(),
      reviewedAt: new Date(),
    }).where(eq(batchLabelPrintsTable.id, runId)).returning();
    void writeAuditLog({
      rowId: run.batchId,
      operation: "label_print_review",
      changedById: actor.id,
      changedByName: actor.fullName,
      afterState: { printRunId: runId, reviewerInitials: initials.trim(), meaning: signatureMeaning.trim() },
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to review label print run");
    res.status(500).json({ error: "Failed to review label print run." });
  }
});

// ─── Session 73 — METRC Tag History (tag lineage) ──────────────────────────
//
// A batch accrues a TREE of METRC tags as product changes form and is
// repackaged. The root is the process-start tag (= the Batch Number, frozen);
// every node references its Source/parent tag; a node is either a single new
// tag or a first–last RANGE of sequential child tags. One split can record
// several non-contiguous ranges (tags run out mid-run) — each is its own
// sibling row so complaint lookup naturally checks them all.
//
// These routes are off-spec / raw-fetch (consistent with NC + label-template
// routes), so there is NO orval codegen follow-up. Append-only with the
// universal Cancel pattern (reason + Manager/Quality/Admin approval,
// recoverable, audited) — never hard-delete (Part 11).

// Cancelling a record requires Manager/Quality/Admin (matches the universal
// Cancel pattern used across complaints/CAPAs/documents/etc.).
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

// Audit helper targeting the batch_metrc_tags table (mirrors writeAuditLog /
// writeIngredientAudit so every tag mutation is attributable — Part 11).
async function writeMetrcTagAudit(opts: {
  rowId: number;
  operation: string;
  changedById?: number | null;
  changedByName?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "batch_metrc_tags",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch (err) {
    logger.error({ err, operation: opts.operation, rowId: opts.rowId }, "writeMetrcTagAudit insert failed");
  }
}

// Normalize a quantity that may arrive as number | string | null into the
// string form the numeric column wants, or null. Tags themselves are stored as
// entered, trimmed only (no format enforcement — multi-state by design).
function normalizeQty(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? String(n) : null;
}
function trimTag(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// GET — list the lineage (active rows only; cancelled nodes are hidden but
// recoverable). Ordered oldest-first so the tree renders process-start → leaf.
router.get("/batch-records/:id/metrc-tags", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(batchMetrcTagsTable)
      .where(and(eq(batchMetrcTagsTable.batchId, id), sql`${batchMetrcTagsTable.cancelledAt} IS NULL`))
      .orderBy(asc(batchMetrcTagsTable.recordedAt), asc(batchMetrcTagsTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list METRC tag history");
    res.status(500).json({ error: "Failed to list METRC tag history" });
  }
});

// Robust containment of a (possibly torn/partial) tag within a first–last range.
// METRC range tags share a fixed leading prefix and differ only in a trailing
// (usually numeric, zero-padded) counter, so we cannot rely on equal-length
// lexicographic compare alone — a torn fragment is shorter than the full tag.
// Returns "exact" (confident the tag is inside the range), "partial" (the
// fragment plausibly belongs to this range — surface it for the user to judge),
// or null. Comparison is case-insensitive and whitespace-trimmed.
function rangeContainment(termRaw: string, startRaw: string | null, endRaw: string | null): "exact" | "partial" | null {
  const T = termRaw.trim().toUpperCase();
  let S = (startRaw ?? "").trim().toUpperCase();
  let E = (endRaw ?? "").trim().toUpperCase();
  if (!T || !S || !E) return null;
  if (S > E) { const tmp = S; S = E; E = tmp; } // tolerate first/last entered out of order

  // 1) Full tag, same length as the range bounds → lexicographic containment.
  if (T.length === S.length && S.length === E.length) {
    if (T >= S && T <= E) return "exact";
  }

  // Longest common prefix of the two bounds = the fixed tag head; the remainder
  // is the varying counter.
  let p = 0;
  const maxP = Math.min(S.length, E.length);
  while (p < maxP && S[p] === E[p]) p++;
  const prefix = S.slice(0, p);
  const sSuf = S.slice(p), eSuf = E.slice(p);
  const numeric = (x: string) => x !== "" && /^[0-9]+$/.test(x);

  // 2) Fragment keeps the head (torn from the END) → it lies in/under the shared
  //    prefix, so it belongs to this range's tag family.
  if (prefix && (S.startsWith(T) || E.startsWith(T))) return "partial";
  if (prefix && T.startsWith(prefix)) {
    const tSuf = T.slice(prefix.length);
    if (numeric(tSuf) && numeric(sSuf) && numeric(eSuf)) {
      const n = Number(tSuf), a = Number(sSuf), b = Number(eSuf);
      if (n >= a && n <= b) return T.length === S.length ? "exact" : "partial";
    }
    return "partial";
  }

  // 3) Fragment is just the counter (torn from the FRONT) → compare numerically
  //    against the range's counter span.
  if (numeric(T) && numeric(sSuf) && numeric(eSuf)) {
    const n = Number(T), a = Number(sSuf), b = Number(eSuf);
    if (n >= a && n <= b) return "partial";
  }

  // 4) Last resort — the fragment appears literally inside either bound.
  if (T.length >= 3 && (S.includes(T) || E.includes(T))) return "partial";

  return null;
}

// GET /metrc-tags/lookup?q= — complaint-traceability lookup (Phase 2).
// Takes whatever identifier the complainant could give us and returns a RANKED
// list of candidate source batches for the user to confirm. Real complaints
// arrive with incomplete info (tag torn off the label, label thrown away, only
// the strain remembered), so we match across several tiers:
//   rank 1 EXACT   — full METRC tag = a single node, the batch's process-start
//                    tag (= batchNumber), or confidently inside a recorded range.
//   rank 2 PARTIAL — a torn/partial fragment (>=3 chars) inside a range, or a
//                    substring of any tag field / the batch number.
//   rank 3 PRODUCT — no tag at all: match the product or strain name, so the
//                    user can still find candidate lots (and pick among several
//                    lots of the same strain during the investigation).
// Range containment is computed in JS (see rangeContainment) because torn tags
// are shorter than the stored bounds. Off-spec / raw-fetch — no codegen.
router.get("/metrc-tags/lookup", async (req, res) => {
  try {
    const term = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!term) { res.json([]); return; }

    // SQL handles the parts Postgres does cleanly: exact single tag, the
    // batch-number root, substring partials, and product/strain name.
    const result = await db.execute(sql`
      WITH q AS (SELECT ${term}::text AS term)
      SELECT m.batch_id, m.match_kind, m.matched_on, m.rank,
             br.batch_number, br.product_name, br.strain_name, br.status, br.production_date
      FROM (
        SELECT t.batch_id, 'exact'::text AS match_kind, t.metrc_tag AS matched_on, 1 AS rank
          FROM batch_metrc_tags t, q
          WHERE t.cancelled_at IS NULL AND t.kind = 'single' AND upper(t.metrc_tag) = upper(q.term)
        UNION ALL
        SELECT br0.id, 'exact', br0.batch_number, 1
          FROM batch_records br0, q WHERE upper(br0.batch_number) = upper(q.term)
        UNION ALL
        SELECT t.batch_id, 'partial', COALESCE(t.metrc_tag, t.range_start || '–' || t.range_end), 2
          FROM batch_metrc_tags t, q
          WHERE t.cancelled_at IS NULL AND length(q.term) >= 3
            AND (t.metrc_tag ILIKE '%' || q.term || '%'
              OR t.range_start ILIKE '%' || q.term || '%'
              OR t.range_end ILIKE '%' || q.term || '%')
        UNION ALL
        SELECT br1.id, 'partial', br1.batch_number, 2
          FROM batch_records br1, q
          WHERE length(q.term) >= 3 AND br1.batch_number ILIKE '%' || q.term || '%'
        UNION ALL
        SELECT br2.id, 'product', COALESCE(br2.product_name, br2.strain_name), 3
          FROM batch_records br2, q
          WHERE length(q.term) >= 3
            AND (br2.product_name ILIKE '%' || q.term || '%'
              OR br2.strain_name ILIKE '%' || q.term || '%')
      ) m
      JOIN batch_records br ON br.id = m.batch_id
      ORDER BY m.rank ASC, br.production_date DESC NULLS LAST, br.id DESC
    `);

    type Cand = {
      batchId: number; batchNumber: string; productName: string | null;
      strainName: string | null; status: string | null; productionDate: string | null;
      matchKind: string; rank: number; matchedOn: string[];
    };
    const rankOf: Record<string, number> = { exact: 1, partial: 2, product: 3 };
    const byBatch = new Map<number, Cand>();
    const add = (info: Omit<Cand, "matchedOn" | "matchKind" | "rank">, kind: string, matchedOn: string | null) => {
      const rank = rankOf[kind] ?? 9;
      const existing = byBatch.get(info.batchId);
      if (!existing) {
        byBatch.set(info.batchId, { ...info, matchKind: kind, rank, matchedOn: matchedOn ? [matchedOn] : [] });
      } else {
        if (matchedOn && !existing.matchedOn.includes(matchedOn)) existing.matchedOn.push(matchedOn);
        if (rank < existing.rank) { existing.rank = rank; existing.matchKind = kind; }
      }
    };

    type Row = {
      batch_id: number; match_kind: string; matched_on: string | null; rank: number;
      batch_number: string; product_name: string | null; strain_name: string | null;
      status: string | null; production_date: string | null;
    };
    for (const r of (result.rows ?? []) as Row[]) {
      add({
        batchId: r.batch_id, batchNumber: r.batch_number, productName: r.product_name,
        strainName: r.strain_name, status: r.status, productionDate: r.production_date,
      }, r.match_kind, r.matched_on);
    }

    // Range containment (JS) — handles full in-range tags AND torn fragments.
    const rangeRows = await db
      .select({
        batchId: batchMetrcTagsTable.batchId,
        rangeStart: batchMetrcTagsTable.rangeStart,
        rangeEnd: batchMetrcTagsTable.rangeEnd,
        batchNumber: batchRecordsTable.batchNumber,
        productName: batchRecordsTable.productName,
        strainName: batchRecordsTable.strainName,
        status: batchRecordsTable.status,
        productionDate: batchRecordsTable.productionDate,
      })
      .from(batchMetrcTagsTable)
      .innerJoin(batchRecordsTable, eq(batchMetrcTagsTable.batchId, batchRecordsTable.id))
      .where(and(eq(batchMetrcTagsTable.kind, "range"), sql`${batchMetrcTagsTable.cancelledAt} IS NULL`));
    for (const r of rangeRows) {
      const hit = rangeContainment(term, r.rangeStart, r.rangeEnd);
      if (!hit) continue;
      add({
        batchId: r.batchId, batchNumber: r.batchNumber, productName: r.productName,
        strainName: r.strainName, status: r.status, productionDate: r.productionDate,
      }, hit, `${r.rangeStart} – ${r.rangeEnd}`);
    }

    const out = Array.from(byBatch.values())
      .sort((a, b) => a.rank - b.rank || (b.productionDate ?? "").localeCompare(a.productionDate ?? ""))
      .slice(0, 25);
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "Failed METRC tag lookup");
    res.status(500).json({ error: "Failed to look up METRC tag" });
  }
});

// POST /metrc-tags/reconcile — Session 97. Given a list of METRC package tags
// (e.g. the live active packages from Metrc on the Finished Goods page), report
// which ones CannaQMS has on record — i.e. match a batch's single tag, its
// process-start tag (= batchNumber), or fall inside a recorded tag RANGE. Lets a
// manager see, during a physical count, which Metrc packages trace to a batch here
// and which are unrecorded. Read-only; operator and up.
router.post("/metrc-tags/reconcile", async (req, res) => {
  try {
    const tags: string[] = Array.isArray(req.body?.tags)
      ? (req.body.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : [];
    if (tags.length === 0) { res.json({ results: [] }); return; }

    const singles = await db
      .select({ batchId: batchMetrcTagsTable.batchId, metrcTag: batchMetrcTagsTable.metrcTag, batchNumber: batchRecordsTable.batchNumber })
      .from(batchMetrcTagsTable)
      .innerJoin(batchRecordsTable, eq(batchMetrcTagsTable.batchId, batchRecordsTable.id))
      .where(and(eq(batchMetrcTagsTable.kind, "single"), sql`${batchMetrcTagsTable.cancelledAt} IS NULL`));
    const ranges = await db
      .select({ batchId: batchMetrcTagsTable.batchId, rangeStart: batchMetrcTagsTable.rangeStart, rangeEnd: batchMetrcTagsTable.rangeEnd, batchNumber: batchRecordsTable.batchNumber })
      .from(batchMetrcTagsTable)
      .innerJoin(batchRecordsTable, eq(batchMetrcTagsTable.batchId, batchRecordsTable.id))
      .where(and(eq(batchMetrcTagsTable.kind, "range"), sql`${batchMetrcTagsTable.cancelledAt} IS NULL`));
    // Batch process-start tags (the batchNumber root).
    const roots = await db.select({ batchId: batchRecordsTable.id, batchNumber: batchRecordsTable.batchNumber }).from(batchRecordsTable);
    const singleByTag = new Map<string, { batchId: number; batchNumber: string }>();
    for (const s of singles) if (s.metrcTag) singleByTag.set(s.metrcTag.trim().toUpperCase(), { batchId: s.batchId, batchNumber: s.batchNumber });
    for (const r of roots) if (r.batchNumber) singleByTag.set(r.batchNumber.trim().toUpperCase(), { batchId: r.batchId, batchNumber: r.batchNumber });

    const results = tags.map((tag) => {
      const key = tag.trim().toUpperCase();
      const exact = singleByTag.get(key);
      if (exact) return { tag, recorded: true, matchKind: "exact", batchId: exact.batchId, batchNumber: exact.batchNumber };
      for (const r of ranges) {
        const hit = rangeContainment(tag, r.rangeStart, r.rangeEnd);
        if (hit) return { tag, recorded: true, matchKind: hit, batchId: r.batchId, batchNumber: r.batchNumber };
      }
      return { tag, recorded: false as const };
    });
    res.json({ results });
  } catch (err) {
    req.log.error({ err }, "Failed METRC tag reconcile");
    res.status(500).json({ error: "Failed to reconcile METRC tags" });
  }
});

// POST — record a form-change / repackage node. Body is either:
//   single: { sourceTag?, stageLabel, kind:'single', metrcTag, quantity?, uom? }
//   range : { sourceTag?, stageLabel, kind:'range', ranges:[{rangeStart,rangeEnd,rangeCount?}], quantity?, uom? }
// A range body records ONE row per range (multi-range non-contiguous splits in
// a single call). All rows in a call share sourceTag/stageLabel/quantity/uom.
router.post("/batch-records/:id/metrc-tags", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    const actor = await getOrProvisionCurrentUser(req).catch(() => null);

    const stageLabel = typeof body.stageLabel === "string" ? body.stageLabel.trim() : "";
    if (!stageLabel) { res.status(400).json({ error: "A stage label is required." }); return; }

    // The first downstream node's source defaults to the Batch Number (the
    // process-start tag / implicit root) when the caller doesn't specify one.
    const sourceTag = trimTag(body.sourceTag) ?? (batch.batchNumber ?? null);
    const quantity = normalizeQty(body.quantity);
    const uom = typeof body.uom === "string" && body.uom.trim() ? body.uom.trim() : null;
    const kind = body.kind === "range" || Array.isArray(body.ranges) ? "range" : "single";

    // METRC write-back sync marker. The form-change dialog creates the package in
    // METRC first (POST /metrc/packages/create-finished-goods — the same two-step
    // the finished-goods flow uses) and then calls this record endpoint with
    // metrcCreated:true, so we stamp the "In METRC" timestamp; metrcSyncError carries
    // a plain-language failure to surface instead of silently diverging. Both null on
    // a mirror-only record (no create attempted), keeping legacy callers unchanged.
    const metrcPackageCreatedAt = body.metrcCreated === true ? new Date() : null;
    const metrcSyncError = typeof body.metrcSyncError === "string" && body.metrcSyncError.trim()
      ? body.metrcSyncError.trim() : null;

    const base = {
      batchId: id,
      sourceTag,
      stageLabel,
      quantity,
      uom,
      metrcPackageCreatedAt,
      metrcSyncError,
      recordedByUserId: actor?.id ?? null,
      recordedByName: actor?.fullName ?? null,
    };

    let inserted: Array<typeof batchMetrcTagsTable.$inferSelect> = [];

    if (kind === "range") {
      // Accept an explicit ranges[] array, or a single first/last pair.
      const rawRanges = Array.isArray(body.ranges) && body.ranges.length
        ? (body.ranges as unknown[])
        : [{ rangeStart: body.rangeStart, rangeEnd: body.rangeEnd, rangeCount: body.rangeCount }];
      const values = rawRanges.map((r) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        const start = trimTag(rr.rangeStart);
        const end = trimTag(rr.rangeEnd);
        const countRaw = rr.rangeCount;
        const count = typeof countRaw === "number" ? countRaw
          : typeof countRaw === "string" && countRaw.trim() !== "" ? parseInt(countRaw, 10)
          : null;
        return { start, end, count: Number.isFinite(count ?? NaN) ? (count as number) : null };
      }).filter((r) => r.start && r.end);
      if (!values.length) { res.status(400).json({ error: "Each range needs a first and last tag." }); return; }
      inserted = await db.insert(batchMetrcTagsTable).values(
        values.map((v) => ({ ...base, kind: "range", rangeStart: v.start, rangeEnd: v.end, rangeCount: v.count }))
      ).returning();
    } else {
      const metrcTag = trimTag(body.metrcTag);
      if (!metrcTag) { res.status(400).json({ error: "A METRC tag is required." }); return; }
      inserted = await db.insert(batchMetrcTagsTable).values({ ...base, kind: "single", metrcTag }).returning();
    }

    for (const row of inserted) {
      void writeMetrcTagAudit({
        rowId: row.id,
        operation: "CREATE",
        changedById: actor?.id ?? null,
        changedByName: actor?.fullName ?? null,
        afterState: row as unknown as Record<string, unknown>,
      });
    }
    res.status(201).json(inserted);
  } catch (err) {
    req.log.error({ err }, "Failed to record METRC tag node");
    res.status(500).json({ error: "Failed to record METRC tag node" });
  }
});

// POST cancel — universal Cancel pattern. Manager/Quality/Admin + Part 11
// signature. Recoverable (the row is hidden from the lineage, not deleted).
router.post("/batch-metrc-tags/:tagId/cancel", async (req, res) => {
  try {
    const tagId = parseInt(req.params.tagId);
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!CANCEL_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Cancelling a tag record requires Manager, Quality, or Admin. Your role is "${actor.role}".` }); return;
    }
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(batchMetrcTagsTable).where(eq(batchMetrcTagsTable.id, tagId));
    if (!before) { res.status(404).json({ error: "Tag record not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This tag record is already cancelled." }); return; }

    const [row] = await db.update(batchMetrcTagsTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByUserId: actor.id,
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    }).where(eq(batchMetrcTagsTable.id, tagId)).returning();
    void writeMetrcTagAudit({
      rowId: tagId, operation: "CANCEL", changedById: actor.id, changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>, afterState: row as unknown as Record<string, unknown>,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel METRC tag record");
    res.status(500).json({ error: "Failed to cancel METRC tag record" });
  }
});

// POST uncancel — reverse a Cancel. Admin-only (narrower than Cancel, matching
// the universal pattern). Part 11 signature required.
router.post("/batch-metrc-tags/:tagId/uncancel", async (req, res) => {
  try {
    const tagId = parseInt(req.params.tagId);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (actor.role !== "Admin") {
      res.status(403).json({ error: `Re-instating a tag record is restricted to Admin. Your role is "${actor.role}".` }); return;
    }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(batchMetrcTagsTable).where(eq(batchMetrcTagsTable.id, tagId));
    if (!before) { res.status(404).json({ error: "Tag record not found" }); return; }
    if (!before.cancelledAt) { res.status(409).json({ error: "This tag record is not cancelled." }); return; }

    const [row] = await db.update(batchMetrcTagsTable).set({
      cancelledAt: null, cancelledReason: null, cancelledByUserId: null,
      cancelledByName: null, cancelledByInitials: null, cancelledMeaning: null,
      updatedAt: new Date(),
    }).where(eq(batchMetrcTagsTable.id, tagId)).returning();
    void writeMetrcTagAudit({
      rowId: tagId, operation: "UNCANCEL", changedById: actor.id, changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>, afterState: row as unknown as Record<string, unknown>,
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel METRC tag record");
    res.status(500).json({ error: "Failed to uncancel METRC tag record" });
  }
});

export default router;
