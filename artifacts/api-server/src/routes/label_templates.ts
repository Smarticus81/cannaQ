import { Router, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import { db } from "@workspace/db";
import {
  labelStaticBlocksTable,
  labelTemplatesTable,
  batchRecordsTable,
  recipesTable,
  batchTestingTable,
  batchIngredientsTable,
  batchLabelingTable,
  batchLabelPrintsTable,
  checklistItemsTable,
  checklistResponsesTable,
  auditLogTable,
  attachmentsTable,
  labelTemplateKeyFor,
  checklistTemplateFrom,
  type ChecklistTemplateItem,
  type LabelTemplate,
  type LabelStaticBlock,
  type RegionConfig,
  type ChecklistItem,
} from "@workspace/db";
import { eq, and, desc, ne, sql, inArray } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { facilityDateStr } from "../lib/facilityDate";
import { getLabelChecklistsForFacility, getFacilityState } from "../lib/regulatoryRules";
import { getStaleIngredientArtwork, staleArtworkMessage } from "../lib/ingredientTripwire";
import { getApplicablePackagingDesigns, getPackagingCoverage } from "../lib/packagingCoverage";
import { getActingFacilityId } from "../middlewares/facilityContext";

// Roles allowed to sign approvals / retire / delete. Mirrors the
// APPROVER_ROLES set in capas.ts (Session 35) — kept inline rather than
// extracted to a shared module to avoid a cross-route import churn.
const APPROVERS = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// Session 39 — Part 11 surface check (initials + meaning + role). Returns
// null on success or an { status, error } pair to res.status().json().
function checkSignature(
  actor: { id: number; role: string; initials: string | null; fullName: string },
  initials: string | undefined,
  meaning: string | undefined,
): { status: number; error: string } | null {
  if (!initials?.trim() || !meaning?.trim()) {
    return { status: 400, error: "Initials and signing meaning required (21 CFR Part 11)." };
  }
  if (!APPROVERS.has(actor.role)) {
    return { status: 403, error: "Only Supervisor, Manager, Quality, or Admin can sign this approval." };
  }
  if (actor.initials && initials.trim().toUpperCase() !== actor.initials.toUpperCase()) {
    return { status: 400, error: "Initials do not match your account. Sign with your own initials." };
  }
  return null;
}

const router = Router();

async function writeAudit(opts: {
  table: string;
  rowId: number;
  operation: string;
  changedById?: number | null;
  changedByName?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  required?: boolean;
  reqLog?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      tableName: opts.table,
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch (err) {
    // For Part 11-style required audit trails on sensitive transitions
    // (approve/delete) we MUST surface the failure so the caller can fail-closed.
    if (opts.required) {
      opts.reqLog?.error({ err, table: opts.table, rowId: opts.rowId, operation: opts.operation }, "Required audit write failed");
      throw err;
    }
    opts.reqLog?.warn({ err, table: opts.table, rowId: opts.rowId, operation: opts.operation }, "Audit write failed (non-critical)");
  }
}

// ── Static blocks ────────────────────────────────────────────────────────────

router.get("/label-static-blocks", async (req, res) => {
  try {
    const productType = typeof req.query["productType"] === "string" ? req.query["productType"] : null;
    const rows = productType
      ? await db.select().from(labelStaticBlocksTable).where(eq(labelStaticBlocksTable.productType, productType)).orderBy(labelStaticBlocksTable.name)
      : await db.select().from(labelStaticBlocksTable).orderBy(labelStaticBlocksTable.productType, labelStaticBlocksTable.name);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list static blocks");
    res.status(500).json({ error: "Failed to list static blocks" });
  }
});

router.post("/label-static-blocks", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { productType, name, body, regulationRef } = req.body ?? {};
    if (!productType || !name || !body) { res.status(400).json({ error: "productType, name, body are required" }); return; }
    const [row] = await db.insert(labelStaticBlocksTable).values({
      productType, name, body,
      regulationRef: regulationRef ?? null,
    }).returning();
    if (row) await writeAudit({ table: "label_static_blocks", rowId: row.id, operation: "create", changedById: actor.id, changedByName: actor.fullName, afterState: row as unknown as Record<string, unknown> });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create static block");
    res.status(500).json({ error: "Failed to create static block" });
  }
});

router.patch("/label-static-blocks/:id", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [before] = await db.select().from(labelStaticBlocksTable).where(eq(labelStaticBlocksTable.id, id));
    if (!before) { res.status(404).json({ error: "Not found" }); return; }
    // Editing locks the previous approval — bump version, clear approval.
    const next: Partial<LabelStaticBlock> = {
      ...req.body,
      version: (before.version ?? 1) + 1,
      approvedById: null,
      approvedByName: null,
      approvalDate: null,
      updatedAt: new Date(),
    };
    const [updated] = await db.update(labelStaticBlocksTable).set(next).where(eq(labelStaticBlocksTable.id, id)).returning();
    if (updated) await writeAudit({ table: "label_static_blocks", rowId: id, operation: "update", changedById: actor.id, changedByName: actor.fullName, beforeState: before as unknown as Record<string, unknown>, afterState: updated as unknown as Record<string, unknown> });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update static block");
    res.status(500).json({ error: "Failed to update static block" });
  }
});

router.delete("/label-static-blocks/:id", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!APPROVERS.has(actor.role)) { res.status(403).json({ error: "Approver role required" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    // Wrap state mutation + required audit insert in a single tx so a failed
    // audit roll back the soft-delete (Part 11 fail-closed guarantee).
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(labelStaticBlocksTable).where(eq(labelStaticBlocksTable.id, id));
      if (!before) return;
      await tx.update(labelStaticBlocksTable).set({ isActive: false, updatedAt: new Date() }).where(eq(labelStaticBlocksTable.id, id));
      await tx.insert(auditLogTable).values({
        tableName: "label_static_blocks", rowId: id, operation: "soft-delete",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: before as unknown as Record<string, unknown>, afterState: null,
      });
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to delete static block");
    res.status(500).json({ error: "Failed to delete static block" });
  }
});

router.post("/label-static-blocks/:id/approve", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!APPROVERS.has(actor.role)) { res.status(403).json({ error: "Approver role required" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(labelStaticBlocksTable).set({
        approvedById: actor.id,
        approvedByName: actor.fullName,
        approvalDate: new Date(),
        updatedAt: new Date(),
      }).where(eq(labelStaticBlocksTable.id, id)).returning();
      if (row) {
        await tx.insert(auditLogTable).values({
          tableName: "label_static_blocks", rowId: id, operation: "approve",
          changedBy: actor.id, changedByName: actor.fullName,
          beforeState: null, afterState: row as unknown as Record<string, unknown>,
        });
      }
      return row;
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to approve static block");
    res.status(500).json({ error: "Failed to approve static block" });
  }
});

// ── Templates ────────────────────────────────────────────────────────────────

router.get("/label-templates", async (req, res) => {
  try {
    const productType = typeof req.query["productType"] === "string" ? req.query["productType"] : null;
    const rows = productType
      ? await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.productType, productType)).orderBy(desc(labelTemplatesTable.isDefault), labelTemplatesTable.name)
      : await db.select().from(labelTemplatesTable).orderBy(labelTemplatesTable.productType, desc(labelTemplatesTable.isDefault), labelTemplatesTable.name);
    // 2026-09-01 — Preview now opens the uploaded proof rather than a picture the
    // app draws for itself, so the card has to know whether there IS one. Without
    // this the button looks alive and opens an error.
    const ids = rows.map((r) => r.id);
    const proofs = ids.length
      ? await db.select({ parentId: attachmentsTable.parentId }).from(attachmentsTable).where(and(
          eq(attachmentsTable.parentTable, "label_templates"),
          eq(attachmentsTable.status, "Active"),
          inArray(attachmentsTable.parentId, ids),
        ))
      : [];
    const withProof = new Set(proofs.map((p) => p.parentId));
    res.json(rows.map((r) => ({ ...r, hasProof: withProof.has(r.id) })));
  } catch (err) {
    req.log.error({ err }, "Failed to list templates");
    res.status(500).json({ error: "Failed to list templates" });
  }
});

router.get("/label-templates/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [row] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get template");
    res.status(500).json({ error: "Failed to get template" });
  }
});

/**
 * Open the approved label PROOF.
 *
 * 2026-09-01 — this is what the Preview button now opens. It used to open a PDF
 * the app drew itself from a list of stacked text bands, which was a guess at the
 * label rather than the label: under the bring-your-own-proof model the operator's
 * uploaded artwork IS the approved label, so showing anything else is showing
 * something nobody approved.
 *
 * Redirects to the stored file rather than streaming it, so the one storage route
 * keeps doing the serving and this stays a lookup.
 */
router.get("/label-templates/:id/proof", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [proof] = await db.select().from(attachmentsTable).where(and(
      eq(attachmentsTable.parentTable, "label_templates"),
      eq(attachmentsTable.parentId, id),
      eq(attachmentsTable.status, "Active"),
    )).orderBy(desc(attachmentsTable.id));
    if (!proof) {
      res.status(404).json({ error: "No label proof has been uploaded for this template yet. Open Edit and attach the PDF of the approved label." });
      return;
    }
    res.redirect(`/api/storage${proof.objectPath}`);
  } catch (err) {
    req.log.error({ err }, "Failed to open a label proof");
    res.status(500).json({ error: "Failed to open the proof for this template" });
  }
});

router.post("/label-templates", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { productType, name, widthIn, heightIn, regions } = req.body ?? {};
    if (!productType || !name) { res.status(400).json({ error: "productType, name are required" }); return; }
    // Session 39 — stamp originator at create so the segregation-of-duties
    // check on the regulatory/marketing approvals can refuse to let the same
    // user sign their own template.
    const [row] = await db.insert(labelTemplatesTable).values({
      productType, name,
      widthIn: typeof widthIn === "number" ? widthIn : 2.0,
      heightIn: typeof heightIn === "number" ? heightIn : 4.0,
      regions: Array.isArray(regions) ? regions : [],
      status: "draft",
      createdById: actor.id,
      createdByName: actor.fullName,
    }).returning();
    if (row) await writeAudit({ table: "label_templates", rowId: row.id, operation: "create", changedById: actor.id, changedByName: actor.fullName, afterState: row as unknown as Record<string, unknown> });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create template");
    res.status(500).json({ error: "Failed to create template" });
  }
});

/**
 * Save As — copy a template into a new Draft.
 *
 * 2026-09-01. Building a product's label meant starting from an empty template
 * and laying out twelve regions again, because the only fully-formed labels in
 * the system are the seeded defaults and there was no way to take a copy. The
 * flow people actually want is: open the generic one, save it as the cookie's,
 * change what differs.
 *
 * ⛔ WHAT IS NOT COPIED, and why. Everything copied describes the ARTWORK;
 * everything left behind is a CLAIM somebody signed for:
 *   - product links  — the copy is a new label, not a second label for the same
 *     product, and one product may hold only one approved label;
 *   - coverage       — what a sticker carries is a statement about THAT sticker,
 *     verified by the signature on it. Inheriting it would launder an unsigned
 *     claim through a copy;
 *   - approvals      — the copy is a Draft and must be signed on its own;
 *   - the proof file — the approved artwork of the label it came from;
 *   - isDefault      — there is one default per type and copying must not move it.
 *
 * Allowed from ANY status, retired included: taking a copy of a retired label is
 * the only way back from a retirement, and it creates a new row rather than
 * reviving a terminal one.
 */
router.post("/label-templates/:id/duplicate", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [src] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!src) { res.status(404).json({ error: "Not found" }); return; }
    const name = String((req.body as { name?: unknown })?.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "A name for the new template is required." }); return; }
    if (name.toLowerCase() === (src.name ?? "").trim().toLowerCase()) {
      res.status(409).json({ error: "Give the copy a different name — two labels with the same name cannot be told apart on a shelf or in the record." });
      return;
    }

    const [row] = await db.insert(labelTemplatesTable).values({
      facilityId: src.facilityId,
      productType: src.productType,
      name,
      widthIn: src.widthIn,
      heightIn: src.heightIn,
      regions: src.regions,
      formatSpec: src.formatSpec,
      fieldList: src.fieldList,
      version: 1,
      status: "draft",
      isDefault: false,
      createdById: actor.id,
      createdByName: actor.fullName,
    }).returning();

    if (row) {
      await writeAudit({
        table: "label_templates", rowId: row.id, operation: "duplicate",
        changedById: actor.id, changedByName: actor.fullName,
        afterState: { copiedFrom: src.id, copiedFromName: src.name, name },
      });
    }
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to copy a label template");
    res.status(500).json({ error: "Failed to copy this template" });
  }
});

// ---------------------------------------------------------------------------
// Label Studio, grouped BY PRODUCT (2026-08-31)
// ---------------------------------------------------------------------------
//
// ⛔ A PRODUCT IS A RECIPE. `recipes` says so in as many words — "a recipe = a
// finished product" — with a product type, a product name, a subtype and its own
// version lineage. There is no separate product catalogue to build, and building
// one would leave two lists of products to keep in step by hand.
//
// Cherry and Grape can share a label where their ingredients read the same in the
// same order; Raspberry Orange needs its own. So the relationship is many-to-many
// and it lives on the TEMPLATE, as a list of recipe LINEAGES.
// ---------------------------------------------------------------------------

/**
 * The products of one type, for the Label Studio grouping.
 *
 * Only the HEAD of each lineage — the row nothing supersedes — because a product
 * is the lineage, not each of its versions. ⛔ Retired products stay in the system
 * and are found only when asked for (his ruling): `includeInactive=1`.
 */
router.get("/label-studio/products", async (req, res) => {
  try {
    const productType = typeof req.query["productType"] === "string" ? req.query["productType"] : null;
    if (!productType) { res.status(400).json({ error: "productType is required" }); return; }
    const includeInactive = req.query["includeInactive"] === "1" || req.query["includeInactive"] === "true";
    const rows = await db.select().from(recipesTable).where(eq(recipesTable.productType, productType));
    const products = rows
      .filter((r) => r.supersededByRecipeId == null)
      .filter((r) => includeInactive || r.isActive)
      .map((r) => ({
        // Older rows predate lineage and are backfilled to their own id; fall
        // back the same way rather than dropping the product off the screen.
        lineageId: r.lineageId ?? r.id,
        recipeId: r.id,
        productName: r.productName,
        subtype: r.subtype,
        version: r.version,
        isActive: r.isActive,
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
    res.json({ productType, products });
  } catch (err) {
    req.log.error({ err }, "Failed to list the products for Label Studio");
    res.status(500).json({ error: "Failed to list the products for this type" });
  }
});

/**
 * Set which products a template is for.
 *
 * Its own endpoint rather than the generic PATCH: that one treats every write as
 * a layout edit and knocks the template back to draft, clearing both approvals.
 * Naming the products a label is used for changes nothing that is printed, so it
 * must not throw away a signature.
 */
router.put("/label-templates/:id/products", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [before] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!before) { res.status(404).json({ error: "Not found" }); return; }
    if (before.status === "retired") {
      res.status(409).json({ error: "Retired templates cannot be edited." });
      return;
    }
    const raw = (req.body as { productLineageIds?: unknown })?.productLineageIds;
    if (!Array.isArray(raw)) { res.status(400).json({ error: "productLineageIds must be an array." }); return; }
    const wanted = [...new Set(raw.map((v) => Number(v)).filter((v) => Number.isFinite(v)))];

    // ⛔ HIS RULING 2026-08-31 — a template may not be linked to a product of a
    // different type. The grouping would lie, and a Flower label would be
    // offered for an edible.
    if (wanted.length > 0) {
      const recipes = await db.select().from(recipesTable);
      const typeByLineage = new Map<number, string>();
      for (const r of recipes) typeByLineage.set(r.lineageId ?? r.id, r.productType);
      const wrong = wanted.filter((l) => (typeByLineage.get(l) ?? before.productType) !== before.productType);
      if (wrong.length > 0) {
        res.status(409).json({ error: `This is a ${before.productType} template, so it can only be used by ${before.productType} products.` });
        return;
      }
    }

    // ⛔ The one-approved-template-per-product rule, enforced from this side too.
    // The gate on /meets-requirements stops a SECOND label being approved for a
    // product; without this, adding a product to an already-approved template
    // would walk around it and leave two approved labels for one product — the
    // exact state the batch's subtraction cannot resolve.
    if (before.status === "approved" && wanted.length > 0) {
      const others = await db.select().from(labelTemplatesTable).where(and(
        eq(labelTemplatesTable.status, "approved"),
        ne(labelTemplatesTable.id, id),
      ));
      const taken = new Set(wanted);
      const clash = others.find((o) => (o.productLineageIds ?? []).some((l) => taken.has(l)));
      if (clash) {
        res.status(409).json({
          error: `"${clash.name}" v${clash.version} is already the approved label for one of those products, and a product can only have one. Retire it first.`,
        });
        return;
      }
    }

    const [updated] = await db.update(labelTemplatesTable)
      .set({ productLineageIds: wanted, updatedAt: new Date() })
      .where(eq(labelTemplatesTable.id, id)).returning();
    if (updated) await writeAudit({ table: "label_templates", rowId: id, operation: "update", changedById: actor.id, changedByName: actor.fullName, beforeState: before as unknown as Record<string, unknown>, afterState: updated as unknown as Record<string, unknown> });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to set the products for a template");
    res.status(500).json({ error: "Failed to set the products for this template" });
  }
});

// ---------------------------------------------------------------------------
// What the STICKER carries — label-control step 4 (2026-08-31)
// ---------------------------------------------------------------------------
//
//   the state's requirements for the batch's product type
//     - what the approved PACKAGING for that type carries or calls N/A   (step 2)
//     - what the approved LABEL TEMPLATE for that PRODUCT carries        (here)
//     = what is verified before this print
//
// A template declares a plain LIST of requirement keys. Unlike a packaging
// design it has no target to choose: it is the end of the chain, so a
// requirement is either printed on the sticker or it is not.
//
// The state is the one the template's facility sits in. A template belongs to a
// site (facilityId), unlike a packaging design, which is corporate and carries
// its own list of states.
// ---------------------------------------------------------------------------

/** Deciding what a label carries is the same authority that decides it for packaging. */
const COVERAGE_ROLES = new Set(["Admin", "Quality", "Manager"]);

type TemplateRequirement = {
  key: string;
  itemText: string;
  regulationRef: string;
  /** "Packaging" (fixed artwork) or "Labeling" (changes with the batch). */
  control: string | null;
  required: boolean;
  /** Whether this template claims to carry it. */
  carried: boolean;
  /** False for anything that changes with the batch — those can never be claimed. */
  claimable: boolean;
};

/**
 * The requirements a template could carry, with what it currently claims.
 *
 * ⚠️ Resolution goes through `checklistTemplateFrom` so the product-type
 * vocabulary bridge applies, exactly as it does on a batch and on a design.
 * `configured` false means the state has no rule set loaded — which must be SAID,
 * because rendering it as "no requirements" would read as compliance.
 */
function resolveTemplateRequirements(tpl: {
  productType: string;
  facilityId: number | null;
  coverageKeys: string[] | null;
}): { requirements: TemplateRequirement[]; configured: boolean } {
  const sets = getLabelChecklistsForFacility(tpl.facilityId ?? getActingFacilityId());
  if (!sets) return { requirements: [], configured: false };
  const items = checklistTemplateFrom(sets, tpl.productType, null) as ChecklistTemplateItem[];
  const claimed = new Set(tpl.coverageKeys ?? []);
  const requirements: TemplateRequirement[] = [];
  for (const it of items) {
    if (!it.key) continue;
    requirements.push({
      key: it.key,
      itemText: it.itemText,
      regulationRef: it.regulationRef,
      control: it.control ?? null,
      required: it.required,
      carried: claimed.has(it.key),
      claimable: (it.control ?? null) === "Packaging",
    });
  }
  return { requirements, configured: true };
}

/**
 * What the approved PACKAGING already answers for this template's products.
 *
 * ⛔ ONE DIRECTION ONLY — his ruling 2026-09-02: "We go package approval, then
 * label approval. No label then package." The pouch's answers are shown on the
 * label; the label's are never shown on the pouch. Reversing it would put back
 * the thing he removed on 09-01, when a packaging design could declare that the
 * LABEL carried something.
 *
 * ⛔ INTERSECTED across the template's products. One label may cover Cherry and
 * Grape; if Cherry's pouch carries a requirement and Grape's does not, the label
 * still has to carry it, or Grape prints without it. Same rule the per-print
 * check uses, and it degrades safely.
 *
 * A template with no products (the legacy generic ones, kept working per his
 * answer (a) on 09-02) resolves to nothing — there is no product whose pouch we
 * could look up, so nothing is greyed and the full list stays tickable.
 */
async function packagingAnswersFor(tpl: {
  facilityId: number | null;
  productLineageIds: number[] | null;
}): Promise<{ keys: Set<string>; designs: Array<{ id: number; designName: string; version: string }> }> {
  const lineages = tpl.productLineageIds ?? [];
  if (lineages.length === 0) return { keys: new Set(), designs: [] };
  const state = getFacilityState(tpl.facilityId ?? getActingFacilityId());
  const allRecipes = await db.select().from(recipesTable);
  const currentByLineage = new Map<number, typeof allRecipes[number]>();
  for (const r of allRecipes) {
    if (r.supersededByRecipeId != null) continue;
    currentByLineage.set(r.lineageId ?? r.id, r);
  }
  let keys: Set<string> | null = null;
  const designs = new Map<number, { id: number; designName: string; version: string }>();
  for (const lineage of lineages) {
    const recipe = currentByLineage.get(lineage);
    // A product we cannot resolve answers nothing, which empties the
    // intersection — the safe direction, since the alternative is greying out a
    // requirement on a guess.
    if (!recipe) return { keys: new Set(), designs: [] };
    const cov = await getPackagingCoverage(recipe.productType, state, { recipeId: recipe.id });
    for (const d of cov.designs) designs.set(d.id, d);
    if (keys === null) keys = new Set(cov.keys);
    else for (const k of [...keys]) if (!cov.keys.has(k)) keys.delete(k);
  }
  const settled = keys ?? new Set<string>();
  return {
    keys: settled,
    // Only name the designs when something actually came of them.
    designs: settled.size > 0 ? [...designs.values()] : [],
  };
}

/** Coverage is frozen once the Quality signature is on it. Draft is the only editable state. */
function coverageLocked(status: string | null | undefined): boolean {
  return status !== "draft";
}

router.get("/label-templates/:id/coverage", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [tpl] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!tpl) { res.status(404).json({ error: "Not found" }); return; }
    const { requirements, configured } = resolveTemplateRequirements(tpl);
    // ⛔ The pouch is approved first, so its answers are already settled. Marking
    // them here means the list you tick is only what is actually left, which is
    // the correlation he asked for on 09-01: "a yes in any of the label or
    // package checklist, it is removed from the related label/package."
    const packaging = await packagingAnswersFor(tpl);
    res.json({
      templateId: id,
      productType: tpl.productType,
      status: tpl.status,
      locked: coverageLocked(tpl.status),
      configured,
      brandOnly: tpl.brandOnly ?? false,
      requirements: requirements.map((r) => ({ ...r, answeredByPackaging: packaging.keys.has(r.key) })),
      packagingDesigns: packaging.designs,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to resolve a template's coverage");
    res.status(500).json({ error: "Failed to resolve what this label carries" });
  }
});

/**
 * Set what the label carries.
 *
 * Its own endpoint, like `/products`, rather than the generic PATCH: that one
 * treats every write as a layout edit and knocks the template back to draft.
 * Saying what an unchanged sticker already prints is not a re-draw.
 */
router.put("/label-templates/:id/coverage", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!COVERAGE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Deciding what a label carries requires Admin / Quality / Manager. Your role is "${actor.role}".` });
      return;
    }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [before] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!before) { res.status(404).json({ error: "Not found" }); return; }
    if (coverageLocked(before.status)) {
      res.status(409).json({
        error: before.status === "retired"
          ? "Retired templates cannot be edited."
          : "This template is approved, so what it carries is frozen under the signature that approved it. Edit the label to raise a new version.",
      });
      return;
    }
    const body = (req.body ?? {}) as { keys?: unknown; brandOnly?: unknown };
    const raw = body.keys;
    if (!Array.isArray(raw)) { res.status(400).json({ error: "keys must be an array." }); return; }
    const wanted = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
    // A brand-only sticker carries nothing by definition, so the two cannot
    // both be true. Refused rather than silently preferring one.
    const brandOnly = body.brandOnly === true;
    if (brandOnly && wanted.length > 0) {
      res.status(409).json({
        error: "A brand-only sticker carries nothing. Untick it, or clear what this label carries.",
      });
      return;
    }

    const { requirements, configured } = resolveTemplateRequirements(before);
    if (!configured) {
      res.status(409).json({ error: "This facility's state has no label rule set loaded, so there is nothing to claim against yet." });
      return;
    }
    const byKey = new Map(requirements.map((r) => [r.key, r]));
    const unknown = wanted.filter((k) => !byKey.has(k));
    if (unknown.length > 0) {
      res.status(400).json({ error: "That requirement is not imposed on this product type in this state." });
      return;
    }
    // ⛔ THE RULE THAT KEEPS THIS SAFE, and it is the design's rule verbatim.
    // Fixed artwork can be verified once; a value that changes with the batch
    // cannot. A sticker having a THC *field* does not verify this batch's
    // *number* — which is also why the per-print check can never end up empty.
    const notFixed = wanted.filter((k) => !byKey.get(k)!.claimable);
    if (notFixed.length > 0) {
      res.status(409).json({
        error: "That one changes with every batch, so printing a field for it is not verifying it. It stays on the per-print check.",
      });
      return;
    }

    const [updated] = await db.update(labelTemplatesTable)
      .set({ coverageKeys: wanted.sort(), brandOnly, updatedAt: new Date() })
      .where(eq(labelTemplatesTable.id, id)).returning();
    if (updated) {
      await writeAudit({
        table: "label_templates", rowId: id, operation: "coverage",
        changedById: actor.id, changedByName: actor.fullName,
        beforeState: { coverageKeys: before.coverageKeys ?? [], brandOnly: before.brandOnly ?? false },
        afterState: { coverageKeys: updated.coverageKeys ?? [], brandOnly: updated.brandOnly ?? false },
      });
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to set what a label carries");
    res.status(500).json({ error: "Failed to record what this label carries" });
  }
});

router.patch("/label-templates/:id", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [before] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!before) { res.status(404).json({ error: "Not found" }); return; }
    // Session 39 — retired templates are terminal; no further edits.
    if (before.status === "retired") {
      res.status(409).json({ error: "Retired templates cannot be edited. Clone or create a new template instead." });
      return;
    }
    // Reject lifecycle-controlled column writes from the generic PATCH body —
    // status / approver columns / retire columns / originator only move
    // through the dedicated lifecycle endpoints, never via direct field
    // assignment. Same fail-closed pattern as the per-approver columns on
    // the CAPA gate routes.
    const body: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>;
    const blocked = [
      "status",
      "regulatoryApproverId", "regulatoryApproverName", "regulatoryApproverInitials", "regulatoryApprovedAt", "regulatoryApproverMeaning",
      "marketingApproverId", "marketingApproverName", "marketingApproverInitials", "marketingApprovedAt", "marketingApproverMeaning",
      "retiredById", "retiredByName", "retiredAt", "retireReason",
      "createdById", "createdByName",
      "approvedById", "approvedByName", "approvalDate",
    ];
    for (const key of blocked) {
      if (key in body) { delete body[key]; }
    }
    // Editing layout invalidates the previous approval bundle — status falls
    // back to draft, both approver slots clear, retire fields clear (defensive
    // — retired is rejected above), and the legacy approval columns clear.
    const next: Partial<LabelTemplate> = {
      ...body,
      version: (before.version ?? 1) + 1,
      status: "draft",
      regulatoryApproverId: null,
      regulatoryApproverName: null,
      regulatoryApproverInitials: null,
      regulatoryApprovedAt: null,
      regulatoryApproverMeaning: null,
      marketingApproverId: null,
      marketingApproverName: null,
      marketingApproverInitials: null,
      marketingApprovedAt: null,
      marketingApproverMeaning: null,
      approvedById: null,
      approvedByName: null,
      approvalDate: null,
      updatedAt: new Date(),
    };
    // If isDefault is being set true, clear other defaults for this product type.
    if (next.isDefault === true) {
      await db.update(labelTemplatesTable).set({ isDefault: false }).where(and(eq(labelTemplatesTable.productType, before.productType), eq(labelTemplatesTable.isDefault, true)));
    }
    const [updated] = await db.update(labelTemplatesTable).set(next).where(eq(labelTemplatesTable.id, id)).returning();
    if (updated) await writeAudit({ table: "label_templates", rowId: id, operation: "update", changedById: actor.id, changedByName: actor.fullName, beforeState: before as unknown as Record<string, unknown>, afterState: updated as unknown as Record<string, unknown> });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update template");
    res.status(500).json({ error: "Failed to update template" });
  }
});

// Session 39 — hard DELETE is only allowed on drafts that were never signed.
// Anything past draft must move through the /retire endpoint instead so the
// audit trail (and any prior label PDFs that reference the template) stay
// intact. Retired templates can be hard-deleted by an approver if cleanup
// is intentional, but the common case is "Retire" leaves the row.
router.delete("/label-templates/:id", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!APPROVERS.has(actor.role)) { res.status(403).json({ error: "Approver role required" }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [before] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!before) { res.status(404).json({ error: "Not found" }); return; }
    if (before.status !== "draft" && before.status !== "retired") {
      res.status(409).json({
        error: `Templates in status "${before.status}" cannot be deleted. Use /retire to move them to the terminal retired state.`,
      });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
      await tx.insert(auditLogTable).values({
        tableName: "label_templates", rowId: id, operation: "delete",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: before as unknown as Record<string, unknown>, afterState: null,
      });
    });
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to delete template");
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ── Session 39 (Tier 3 #12a) — Template lifecycle endpoints ─────────────────
//
// Draft → Regulatory Approved → Marketing Approved → Approved, plus a Retire
// transition usable from any non-retired state. Distinct signers on the two
// approvals (Reg ≠ Mktg, and neither may be the originator) — mirrors the
// CAPA Gate 1 segregation-of-duties pattern (Session 24 / Session 35).
//
// Legacy `/approve` (single-signer) is rejected with 410 Gone — any old
// clients fail fast against the new flow rather than silently bypassing the
// segregation-of-duties check.

router.post("/label-templates/:id/approve", async (_req, res) => {
  res.status(410).json({
    error: "The single-step approval endpoint has been retired (Session 39, Tier 3 #12a). Use POST /label-templates/:id/regulatory-approve followed by POST /label-templates/:id/marketing-approve. The two approvals must be signed by distinct users, neither of whom is the template originator.",
  });
});

// 2026-07-22 — Bring-your-own-label model: a label TEMPLATE is approved by a
// SINGLE Quality "meets state requirements" sign-off (Jonathan's decision),
// replacing the old two-step regulatory→marketing flow for new templates. The
// old endpoints below stay for legacy rows until the designer is retired
// (increment #4). Guardrails: the format spec + at least one variable field
// must be recorded and an approved proof must be attached, so nobody signs off
// on an empty template. Reuses the regulatoryApprover* columns as the
// meets-requirements signer and stamps the legacy approvedBy* summary so the
// existing "approvalDate != null = ready" checks keep working.
const MEETS_REQ_ROLES = new Set(["Quality", "Admin"]);
router.post("/label-templates/:id/meets-requirements", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { initials, signatureMeaning, packagingOrderOverrideReason } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; packagingOrderOverrideReason?: string;
    };
    const sigCheck = checkSignature(actor, initials, signatureMeaning);
    if (sigCheck) { res.status(sigCheck.status).json({ error: sigCheck.error }); return; }
    if (!MEETS_REQ_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Quality (or Admin) can sign the 'meets state requirements' approval." });
      return;
    }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const [tpl] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!tpl) { res.status(404).json({ error: "Not found" }); return; }
    if (tpl.status !== "draft") {
      res.status(409).json({ error: `The meets-requirements sign-off is only available from the "draft" state (current: "${tpl.status}").` });
      return;
    }
    // Segregation of duties: the originator cannot sign their own template.
    if (tpl.createdById && tpl.createdById === actor.id) {
      res.status(409).json({ error: "You created this template. Per 21 CFR Part 11, the originator cannot sign its approval (segregation of duties)." });
      return;
    }
    // Don't allow signing an empty template.
    const fieldList = tpl.fieldList as unknown;
    const hasFields = Array.isArray(fieldList) && fieldList.length > 0;
    if (tpl.formatSpec == null || !hasFields) {
      res.status(422).json({ error: "Record the format spec and at least one variable field before signing 'meets requirements'." });
      return;
    }
    const proofs = await db.select({ id: attachmentsTable.id }).from(attachmentsTable).where(and(
      eq(attachmentsTable.parentTable, "label_templates"),
      eq(attachmentsTable.parentId, id),
      eq(attachmentsTable.status, "Active"),
    ));
    if (proofs.length === 0) {
      res.status(422).json({ error: "Upload the approved label proof before signing 'meets requirements'." });
      return;
    }

    // ⛔ A LABEL MUST NAME ITS PRODUCTS — his ruling 2026-09-02:
    // "Let's get rid of a generic label. We have no idea what they will put on a
    // package, so we would just be putting meaningless info onto a label that
    // doesn't meet the size needs of the customer."
    //
    // ⚠️ A POUCH may still cover a whole product type — the cartridge pouch is
    // shared across every strain. Only the LABEL loses the generic option, and
    // the asymmetry is the point: one physical pouch, many labels.
    //
    // ⚠️ Templates ALREADY approved without products keep working, his answer (a)
    // to the same question. This gate only runs at the moment of signing, so
    // nothing already printing stops, and the generic fallback in
    // lib/labelTemplateCoverage.ts stays for exactly those rows. ⛔ Do not remove
    // that fallback thinking this replaced it.
    if ((tpl.productLineageIds ?? []).length === 0) {
      res.status(422).json({
        error: "This label does not say which products it is for, and a label can no longer be approved for a whole product type. Open Products and choose them first.",
      });
      return;
    }

    // ⛔ PACKAGE FIRST, THEN LABEL — his ruling 2026-09-02, HALF-REFUSED.
    // A label for a product with no approved packaging can still be signed, but
    // only with a written reason, which is kept on the record. His words:
    // "Let's half refuse. If they want to create a label first, they can provide
    // a rationale."
    const templateState = getFacilityState(tpl.facilityId ?? getActingFacilityId());
    const allRecipes = await db.select().from(recipesTable);
    const currentByLineage = new Map<number, typeof allRecipes[number]>();
    for (const r of allRecipes) {
      if (r.supersededByRecipeId != null) continue;
      currentByLineage.set(r.lineageId ?? r.id, r);
    }
    const unpackaged: string[] = [];
    for (const lineage of tpl.productLineageIds ?? []) {
      const recipe = currentByLineage.get(lineage);
      if (!recipe) continue;
      const designs = await getApplicablePackagingDesigns(recipe.productType, templateState, { recipeId: recipe.id });
      if (designs.length === 0) unpackaged.push(recipe.productName);
    }
    const overrideReason = (packagingOrderOverrideReason ?? "").trim();
    if (unpackaged.length > 0 && !overrideReason) {
      res.status(409).json({
        requiresPackagingOverride: true,
        products: unpackaged,
        error: `The packaging is approved first, then the label — what the pouch carries decides what is left for the label to carry. ${unpackaged.join(", ")} has no approved packaging design yet. Approve the packaging first, or give a written reason for signing the label ahead of it.`,
      });
      return;
    }
    // Cleared when it is not needed, so a reason can never sit on a label that
    // was signed in the right order.
    const packagingOverride = unpackaged.length > 0
      ? {
          packagingOrderOverrideReason: overrideReason,
          packagingOrderOverrideById: actor.id,
          packagingOrderOverrideByName: actor.fullName,
          packagingOrderOverrideAt: new Date(),
        }
      : {
          packagingOrderOverrideReason: null,
          packagingOrderOverrideById: null,
          packagingOrderOverrideByName: null,
          packagingOrderOverrideAt: null,
        };

    // ⛔ NOTHING TICKED IN CARRIES IS REFUSED — his ruling 2026-09-02, out of his
    // own question on 09-01: "Why would we ever allow that?"
    //
    // This signature says the label meets state requirements. Signing it while
    // it claims to print none of them is signing a blank claim. And the list
    // FREEZES at approval, so an empty one left empty by accident is empty for
    // good — which is exactly what the card's next-step text was written to
    // stop, with nothing behind it until now.
    //
    // The one way through is to say it out loud: tick "brand-only sticker".
    // That is the real case — a logo or strain name on the side of a jar,
    // sitting BESIDE the compliance label and carrying nothing itself.
    //
    // ⚠️ Only refused when there is something to tick. A state with no rule set
    // loaded, or a product type with no fixed-artwork requirement, would
    // otherwise leave a template nobody could ever approve.
    if (!tpl.brandOnly && (tpl.coverageKeys ?? []).length === 0) {
      const { requirements, configured } = resolveTemplateRequirements(tpl);
      // ⚠️ 2026-09-02 — anything the approved PACKAGING already answers does not
      // count as something left to tick. Without this, a label whose pouch
      // carries everything could never be signed: the screen would show nothing
      // tickable and the gate would still demand a tick.
      const packaging = await packagingAnswersFor(tpl);
      if (configured && requirements.some((r) => r.claimable && !packaging.keys.has(r.key))) {
        res.status(422).json({
          error: "This label does not say it prints anything. Open Fixed Content and tick what it prints, or tick \"brand-only sticker\" if it carries no state requirement. Its fixed content is frozen by this signature and cannot be added afterwards.",
        });
        return;
      }
    }

    // ⛔ ONE APPROVED TEMPLATE PER PRODUCT — his ruling 2026-08-31, and the thing
    // that makes step 4's subtraction exact.
    //
    //   one label  <- MANY products   (Cherry and Grape share Gummy Label v3)  allowed
    //   one product <- MANY labels    (Cherry having two at once)              refused
    //
    // Every product therefore resolves to EXACTLY ONE approved template, so the
    // batch pulls it with no picker and no default, and the checklist subtracts
    // one label's coverage rather than an intersection across several. Same
    // instinct as document control: one revision in force at a time. The way out
    // is to retire the one that stands, not to sign a second beside it.
    //
    // A template naming no products is generic and conflicts with nothing —
    // there is no product for two labels to fight over.
    const wantedLineages = new Set(tpl.productLineageIds ?? []);
    if (wantedLineages.size > 0) {
      const others = await db.select().from(labelTemplatesTable).where(and(
        eq(labelTemplatesTable.status, "approved"),
        ne(labelTemplatesTable.id, id),
      ));
      const clash = others.find((o) => (o.productLineageIds ?? []).some((l) => wantedLineages.has(l)));
      if (clash) {
        res.status(409).json({
          error: `"${clash.name}" v${clash.version} is already the approved label for one of these products, and a product can only have one. Retire it first, or take that product off this template.`,
        });
        return;
      }
    }

    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(labelTemplatesTable).set({
        ...packagingOverride,
        status: "approved",
        regulatoryApproverId: actor.id,
        regulatoryApproverName: actor.fullName,
        regulatoryApproverInitials: (actor.initials ?? initials!.trim()).toUpperCase(),
        regulatoryApprovedAt: now,
        regulatoryApproverMeaning: signatureMeaning!.trim(),
        approvedById: actor.id,
        approvedByName: actor.fullName,
        approvalDate: now,
        updatedAt: now,
      }).where(and(eq(labelTemplatesTable.id, id), eq(labelTemplatesTable.status, "draft"))).returning();
      if (row) {
        await tx.insert(auditLogTable).values({
          tableName: "label_templates", rowId: id, operation: "meets_requirements_approve",
          changedBy: actor.id, changedByName: actor.fullName,
          beforeState: { status: tpl.status } as never,
          afterState: {
            status: row.status,
            signer: actor.fullName,
            signatureMeaning: signatureMeaning!.trim(),
            ...(overrideReason ? { packagingOrderOverrideReason: overrideReason, signedAheadOfPackagingFor: unpackaged } : {}),
          } as never,
        });
      }
      return row;
    });
    if (!updated) { res.status(409).json({ error: "Template status changed; refresh and try again." }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to record meets-requirements approval");
    res.status(500).json({ error: "Failed to record meets-requirements approval" });
  }
});

router.post("/label-templates/:id/retire", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!APPROVERS.has(actor.role)) { res.status(403).json({ error: "Approver role required to retire a template." }); return; }
    const id = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(id)) { res.status(400).json({ error: "Bad id" }); return; }
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim()) { res.status(400).json({ error: "A retire reason is required (audit trail)." }); return; }
    const [tpl] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, id));
    if (!tpl) { res.status(404).json({ error: "Not found" }); return; }
    if (tpl.status === "retired") {
      res.status(409).json({ error: "Template is already retired." });
      return;
    }
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(labelTemplatesTable).set({
        status: "retired",
        retiredById: actor.id,
        retiredByName: actor.fullName,
        retiredAt: now,
        retireReason: reason.trim(),
        // Retiring clears the "production ready" summary so the existing
        // draft-watermark gate in buildRenderedLabel will refuse to render
        // production PDFs against retired templates.
        approvedById: null,
        approvedByName: null,
        approvalDate: null,
        // Also clear the default flag — a retired default would silently
        // become an unset default; force a fresh selection.
        isDefault: false,
        updatedAt: now,
      }).where(and(eq(labelTemplatesTable.id, id), ne(labelTemplatesTable.status, "retired"))).returning();
      if (row) {
        await tx.insert(auditLogTable).values({
          tableName: "label_templates", rowId: id, operation: "retire",
          changedBy: actor.id, changedByName: actor.fullName,
          beforeState: { status: tpl.status, isDefault: tpl.isDefault } as never,
          afterState: { status: row.status, reason: reason.trim() } as never,
        });
      }
      return row;
    });
    if (!updated) { res.status(409).json({ error: "Template was retired by another user; refresh." }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to retire template");
    res.status(500).json({ error: "Failed to retire template" });
  }
});

// ── Session 39 (Tier 3 #12c) — Pre-print verification gate ─────────────────
//
// Production print is blocked until 100% of the batch's required pre-print
// checklist items are answered with "Pass". The check evaluates only items
// where `required = "true"` (string-typed in the schema; matches the seed
// data and the existing UI which writes the same string). Items without a
// response, or with any response other than "Pass", are reported back in the
// `pending` array so the frontend can list exactly what's blocking the print.
//
// Gate is skipped on `?draft=1` previews — those are the QA-walkthrough path
// and intentionally bypass production checks (DRAFT watermark on the PDF).

type PrePrintPending = {
  itemId: number;
  itemNumber: number;
  itemText: string;
  regulationRef: string;
  currentResponse: string | null;
};

async function checkPrePrintChecklist(batchId: number): Promise<
  | { ok: true }
  | { ok: false; status: 409; pending: PrePrintPending[]; totalRequired: number; passing: number }
> {
  const [labeling] = await db.select().from(batchLabelingTable).where(eq(batchLabelingTable.batchId, batchId));
  // No labeling record yet → no checklist has been built; treat as 0/0
  // failing closed because the operator must seed the checklist before
  // printing. UI prompts the operator to open the Labeling tab.
  if (!labeling) {
    return { ok: false, status: 409, pending: [], totalRequired: 0, passing: 0 };
  }
  const items = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.labelingId, labeling.id));
  const requiredItems = items.filter((i: ChecklistItem) => i.required === "true");
  if (requiredItems.length === 0) {
    // No required items configured → nothing to verify; allow print.
    return { ok: true };
  }
  const itemIds = requiredItems.map((i) => i.id);
  const responses = await db
    .select()
    .from(checklistResponsesTable)
    .where(inArray(checklistResponsesTable.checklistItemId, itemIds));
  const responseByItemId = new Map<number, string>();
  for (const r of responses) responseByItemId.set(r.checklistItemId, r.response);

  const pending: PrePrintPending[] = [];
  let passing = 0;
  for (const item of requiredItems) {
    const resp = responseByItemId.get(item.id) ?? null;
    if (resp === "Pass") {
      passing += 1;
    } else {
      pending.push({
        itemId: item.id,
        itemNumber: item.itemNumber,
        itemText: item.itemText,
        regulationRef: item.regulationRef,
        currentResponse: resp,
      });
    }
  }
  if (pending.length === 0) return { ok: true };
  // Sort by itemNumber so the UI list is stable and matches the visible
  // checklist order.
  pending.sort((a, b) => a.itemNumber - b.itemNumber);
  return { ok: false, status: 409, pending, totalRequired: requiredItems.length, passing };
}

// ── Render: merge batch + template ───────────────────────────────────────────

interface RenderedRegion {
  id: string;
  kind: string;
  enabled: boolean;
  order: number;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  align?: "left" | "center" | "right";
  // Fully-resolved display lines per region. The frontend & PDF renderer just
  // print these in order.
  lines: string[];
  label?: string;
}

interface RenderedLabel {
  template: LabelTemplate;
  batchId: number;
  batchNumber: string;
  productName: string;
  productType: string;
  strainName: string | null;
  regions: RenderedRegion[];
  approval: {
    templateApproved: boolean;
    blocksApproved: boolean;
    unapprovedBlockNames: string[];
    isDraft: boolean;
  };
}

async function buildRenderedLabel(batchId: number, templateId: number): Promise<RenderedLabel | { error: string; status: number }> {
  const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, batchId));
  if (!batch) return { error: "Batch not found", status: 404 };

  const [template] = await db.select().from(labelTemplatesTable).where(eq(labelTemplatesTable.id, templateId));
  if (!template) return { error: "Template not found", status: 404 };

  const tests = await db.select().from(batchTestingTable)
    .where(eq(batchTestingTable.batchId, batchId))
    .orderBy(desc(batchTestingTable.sequenceNumber));
  const latestTest = tests.find((t) => t.testResult === "Pass") ?? null;
  const ingredients = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, batchId));
  const sortedIngredients = [...ingredients].sort((a, b) => {
    const aq = a.actualQuantity ?? a.plannedQuantity ?? 0;
    const bq = b.actualQuantity ?? b.plannedQuantity ?? 0;
    return bq - aq;
  });

  const thcPct = latestTest?.thcPct ?? null;
  const cbdPct = latestTest?.cbdPct ?? null;
  const thcMgPerGram = thcPct != null ? Math.round(thcPct * 10 * 100) / 100 : null;
  const cbdMgPerGram = cbdPct != null ? Math.round(cbdPct * 10 * 100) / 100 : null;

  // Resolve all referenced static blocks once.
  const regions = (template.regions as RegionConfig[]) ?? [];
  const blockIds = regions.map((r) => r.staticBlockId).filter((id): id is number => typeof id === "number");
  const blockMap = new Map<number, LabelStaticBlock>();
  if (blockIds.length > 0) {
    const blocks = await db.select().from(labelStaticBlocksTable);
    for (const b of blocks) blockMap.set(b.id, b);
  }

  const fmtDate = (d: Date | string | null | undefined): string => {
    if (!d) return "—";
    const dt = typeof d === "string" ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return "—";
    return facilityDateStr(dt);
  };

  const rendered: RenderedRegion[] = regions
    .filter((r) => r.enabled !== false)
    .sort((a, b) => a.order - b.order)
    .map((r) => {
      const lines: string[] = [];
      switch (r.kind) {
        case "brand-header":
          lines.push(r.customText ?? "CannaQ Cannabis");
          break;
        case "product-info":
          lines.push(batch.productName);
          if (batch.productType) lines.push(batch.productType);
          break;
        case "strain":
          if (batch.strainName) lines.push(`Strain: ${batch.strainName}`);
          break;
        case "thc-cbd":
          if (thcPct != null) lines.push(`Total THC: ${thcPct.toFixed(2)}%  (${thcMgPerGram} mg/g)`);
          else lines.push("Total THC: —");
          if (cbdPct != null) lines.push(`Total CBD: ${cbdPct.toFixed(2)}%  (${cbdMgPerGram} mg/g)`);
          else lines.push("Total CBD: —");
          break;
        case "net-weight":
          if (batch.outputQuantity != null) lines.push(`Net Wt: ${batch.outputQuantity} ${batch.unitOfMeasure ?? "g"}`);
          else lines.push("Net Wt: —");
          break;
        case "dates":
          lines.push(`Date Produced: ${fmtDate(batch.productionDate)}`);
          if (latestTest?.resultDate) lines.push(`Date Tested: ${fmtDate(latestTest.resultDate as unknown as Date)}`);
          else lines.push("Date Tested: —");
          break;
        case "batch-metrc":
          lines.push(`Batch: ${batch.batchNumber}`);
          if (batch.metrcPackageId) lines.push(`METRC: ${batch.metrcPackageId}`);
          break;
        case "static-block": {
          const block = r.staticBlockId != null ? blockMap.get(r.staticBlockId) : undefined;
          if (block) {
            if (r.label ?? block.name) lines.push((r.label ?? block.name).toUpperCase());
            for (const ln of block.body.split(/\r?\n/)) lines.push(ln);
          } else if (r.customText) {
            lines.push(r.customText);
          }
          break;
        }
        case "divider":
          lines.push("────────────────────");
          break;
        case "spacer":
          lines.push("");
          break;
      }
      return {
        id: r.id,
        kind: r.kind,
        enabled: true,
        order: r.order,
        ...(r.fontSize !== undefined ? { fontSize: r.fontSize } : {}),
        ...(r.fontWeight !== undefined ? { fontWeight: r.fontWeight } : {}),
        ...(r.align !== undefined ? { align: r.align } : {}),
        lines,
        ...(r.label !== undefined ? { label: r.label } : {}),
      };
    });

  // Append ingredients line at end of any product-info region for edibles is
  // common — we expose the sorted list in the payload for any custom region a
  // future template wants to bind.
  void sortedIngredients;

  // Compute approval status across the template + any referenced static blocks.
  const referencedBlocks = regions
    .filter((r) => r.enabled !== false && r.kind === "static-block" && typeof r.staticBlockId === "number")
    .map((r) => blockMap.get(r.staticBlockId as number))
    .filter((b): b is LabelStaticBlock => !!b);
  const unapprovedBlockNames = referencedBlocks.filter((b) => !b.approvalDate).map((b) => b.name);
  const templateApproved = !!template.approvalDate;
  const blocksApproved = unapprovedBlockNames.length === 0;

  return {
    template,
    batchId,
    batchNumber: batch.batchNumber,
    productName: batch.productName,
    productType: batch.productType,
    strainName: batch.strainName,
    regions: rendered,
    approval: {
      templateApproved,
      blocksApproved,
      unapprovedBlockNames,
      isDraft: !(templateApproved && blocksApproved),
    },
  };
}

// ⛔ 2026-09-01 — THE SAMPLE PREVIEW RENDERER IS GONE.
// `GET /label-templates/:id/preview.pdf` drew a picture of the label from a list
// of stacked text bands and fake batch data. Under the bring-your-own-proof model
// the operator's uploaded PDF is the approved label, so that drawing was a guess
// at something nobody had approved — and it is what printed the warning blocks on
// top of each other. Preview now opens the proof: see /label-templates/:id/proof.
//
// ⚠️ `buildRenderedLabel` and `GET /batch-records/:id/label.pdf` BELOW are still
// here on purpose. The batch screen's Label Data panel still calls that one, so
// deleting it would take a button away with nothing behind it. It goes once we
// decide what that button should do instead.


// ── Step 1 (2026-08-13) — PRODUCTION label PDF for a batch ────────────────────
// Renders a batch's live data through its APPROVED product-type template and
// emits a real (non-DRAFT) label. The renderer already computed isDraft; nothing
// exposed a production print, so this is the missing piece. Production is gated
// on: an approved template for the product type, all referenced warning blocks
// approved (isDraft === false), AND the R 420.504 pre-print checklist passing.
// `?draft=1` bypasses the gates and stamps DRAFT (QA / walkthrough preview).
router.get("/batch-records/:id/label.pdf", async (req: Request, res: Response) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    const batchId = parseInt(String(req.params["id"] ?? ""));
    if (Number.isNaN(batchId)) { res.status(400).json({ error: "batchId required" }); return; }
    const forceDraft = req.query["draft"] === "1" || req.query["draft"] === "true";

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, batchId));
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

    // Pick the batch's product-type template (prefer the default). Production
    // needs an APPROVED one; a draft preview may use any non-retired template.
    // Alias the batch's productType to the Label Studio template key before
    // querying — a "Vape Cartridge" batch has to find the "Vape" template.
    const templateKey = labelTemplateKeyFor(batch.productType);
    // A product type Label Studio has no template type for at all — "Other", or a
    // new type nobody mapped. Say so plainly instead of sending someone to build a
    // template for a type the screen does not offer.
    if (!templateKey) {
      res.status(409).json({
        error: `Label Studio has no template type for "${batch.productType ?? "—"}". Set the batch's product type, or map this type to a label template type.`,
      });
      return;
    }
    const candidates = await db.select().from(labelTemplatesTable)
      .where(and(eq(labelTemplatesTable.productType, templateKey), ne(labelTemplatesTable.status, "retired")));
    const pool = forceDraft ? candidates : candidates.filter((t) => t.approvalDate != null);
    const template = pool.find((t) => t.isDefault) ?? pool[0] ?? null;
    if (!template) {
      // Name the template type actually searched for. Saying "Vape Cartridge" sent
      // people looking for a template of that name; the one to create is "Vape".
      const named = templateKey === (batch.productType ?? "").trim()
        ? `"${templateKey}"`
        : `"${templateKey}" (for ${batch.productType})`;
      res.status(409).json({ error: forceDraft
        ? `No label template exists for product type ${named}. Create one in Label Studio.`
        : `No approved label template for product type ${named}. Approve one in Label Studio before printing.` });
      return;
    }

    // ⛔ The ingredient tripwire (2026-09-02) — the same refusal the label-data
    // export gives, because this is the other way a real label reaches paper.
    // A DRAFT print is deliberately still allowed: it is watermarked and is how
    // somebody checks the artwork against the changed recipe in the first place.
    if (!forceDraft) {
      const stale = await getStaleIngredientArtwork(batch, getFacilityState(batch.facilityId ?? getActingFacilityId()));
      if (stale.length > 0) {
        res.status(409).json({ error: staleArtworkMessage(stale), staleArtwork: stale });
        return;
      }
    }

    // Production gate: the R 420.504 pre-print checklist must pass.
    if (!forceDraft) {
      const gate = await checkPrePrintChecklist(batchId);
      if (!gate.ok) {
        res.status(409).json({
          error: "Label print blocked — complete the R 420.504 verification checklist on the Labeling tab first.",
          pending: gate.pending, totalRequired: gate.totalRequired, passing: gate.passing,
        });
        return;
      }
    }

    const result = await buildRenderedLabel(batchId, template.id);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }

    const isDraft = forceDraft || result.approval.isDraft;
    // Refuse a production print when the design isn't fully approved.
    if (!forceDraft && result.approval.isDraft) {
      res.status(409).json({
        error: result.approval.unapprovedBlockNames.length
          ? `Label not production-ready — approve these warning block(s) in Label Studio: ${result.approval.unapprovedBlockNames.join(", ")}.`
          : "Label not production-ready — the template is not approved. Approve it in Label Studio.",
      });
      return;
    }

    const widthPt = result.template.widthIn * 72;
    const heightPt = result.template.heightIn * 72;
    const doc = new PDFDocument({ size: [widthPt, heightPt], margins: { top: 8, bottom: 8, left: 8, right: 8 } });
    res.setHeader("Content-Type", "application/pdf");
    const safeBatch = String(result.batchNumber).replace(/[^A-Za-z0-9._-]+/g, "_");
    res.setHeader("Content-Disposition", `inline; filename="label_${safeBatch}${isDraft ? "-DRAFT" : ""}.pdf"`);
    doc.pipe(res);

    if (isDraft) {
      doc.save();
      doc.fillColor("#dc2626", 0.15);
      doc.font("Helvetica-Bold").fontSize(Math.max(widthPt, heightPt) * 0.18);
      doc.rotate(-30, { origin: [widthPt / 2, heightPt / 2] });
      doc.text("DRAFT", 0, heightPt / 2 - 20, { width: widthPt, align: "center" });
      doc.restore();
      doc.fillColor("black", 1);
    }

    let y = 12;
    for (const region of result.regions) {
      const fontSize = region.fontSize ?? 9;
      const align = region.align ?? "left";
      const isBold = region.fontWeight === "bold" || region.kind === "brand-header" || region.kind === "static-block";
      doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      for (const line of region.lines) {
        if (line === "") { y += fontSize * 0.5; continue; }
        // ⛔ 2026-09-01 — ADVANCE BY WHAT WAS ACTUALLY DRAWN, not by one line.
        // `doc.text` is given a width, so it WRAPS: a warning that runs to four
        // visual lines was still only moving the cursor down one, and the next
        // block printed on top of it. On the Edible label the pregnancy warning,
        // the keep-out-of-reach block and the onset warning all collided into an
        // unreadable stack. `heightOfString` measures the same wrap the draw does,
        // with the same width and align, so the two can no longer disagree.
        const opts = { width: widthPt - 16, align };
        const drawn = doc.heightOfString(line, opts);
        doc.text(line, 8, y, opts);
        y += drawn + 2;
      }
      y += 3;
    }
    doc.end();

    // Log a real production print as a print run (needs second-person review).
    if (!isDraft) {
      void db.insert(batchLabelPrintsTable).values({
        batchId, printedById: user.id, printedByName: user.fullName, rowCount: 1, exportFormat: "pdf",
      }).catch((err: unknown) => req.log.warn({ err, batchId }, "Failed to log label print run (non-blocking)"));
    }
  } catch (err) {
    req.log.error({ err }, "Failed to render batch label");
    if (!res.headersSent) res.status(500).json({ error: "Failed to render batch label" });
  }
});

router.get("/batch-records/:id/print-history", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const batchId = parseInt(req.params["id"] ?? "");
    if (Number.isNaN(batchId)) { res.status(400).json({ error: "Bad batch id" }); return; }
    const rows = await db
      .select()
      .from(batchLabelPrintsTable)
      .where(eq(batchLabelPrintsTable.batchId, batchId))
      .orderBy(desc(batchLabelPrintsTable.printedAt))
      .limit(50);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list print history");
    res.status(500).json({ error: "Failed to list print history" });
  }
});

export default router;
