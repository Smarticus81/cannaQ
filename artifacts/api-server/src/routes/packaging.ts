import { Router } from "express";
import { db } from "@workspace/db";
import {
  packagingDesignsTable,
  auditLogTable,
  COVERAGE_TARGETS,
  checklistTemplateFrom,
  recipesTable,
  type ChecklistTemplateItem,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import {
  getLabelChecklistsForState,
  getCachedRegulatoryStates,
  normalizeState,
} from "../lib/regulatoryRules";

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
      tableName: "packaging_designs",
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

router.get("/packaging-designs", async (req, res) => {
  try {
    const rows = await db.select().from(packagingDesignsTable).orderBy(packagingDesignsTable.createdAt);
    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list packaging designs");
    res.status(500).json({ error: "Failed to list packaging designs" });
  }
});

router.post("/packaging-designs", async (req, res) => {
  try {
    const [design] = await db.insert(packagingDesignsTable).values(req.body).returning();
    void writeAuditLog({
      rowId: design.id,
      operation: "INSERT",
      changedByName: (req.body as Record<string, unknown>).createdByName as string ?? null,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.status(201).json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to create packaging design");
    res.status(500).json({ error: "Failed to create packaging design" });
  }
});

// The products a design of this type could be for.
//
// ⛔ MUST STAY ABOVE /packaging-designs/:id. Express matches in order, so below
// it this URL is read as an id of "products" and parseInt gives NaN.
router.get("/packaging-designs/products", async (req, res) => {
  try {
    const productType = typeof req.query["productType"] === "string" ? req.query["productType"] : null;
    if (!productType) { res.status(400).json({ error: "productType is required" }); return; }
    const rows = await db.select().from(recipesTable).where(eq(recipesTable.productType, productType));
    const products = rows
      .filter((r) => r.supersededByRecipeId == null)
      .filter((r) => r.isActive)
      .map((r) => ({
        // Rows that predate lineage are backfilled to their own id; fall back
        // the same way rather than dropping the product off the screen.
        lineageId: r.lineageId ?? r.id,
        productName: r.productName,
        subtype: r.subtype,
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
    res.json({ productType, products });
  } catch (err) {
    req.log.error({ err }, "Failed to list the products for a packaging design");
    res.status(500).json({ error: "Failed to list the products for this type" });
  }
});

router.get("/packaging-designs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [design] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!design) { res.status(404).json({ error: "Packaging design not found" }); return; }
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to get packaging design");
    res.status(500).json({ error: "Failed to get packaging design" });
  }
});

router.patch("/packaging-designs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    const [design] = await db.update(packagingDesignsTable).set({ ...req.body, updatedAt: new Date() }).where(eq(packagingDesignsTable.id, id)).returning();
    if (!design) { res.status(404).json({ error: "Packaging design not found" }); return; }
    // Session 100 — attribute the edit to the signed-in user (Part 11) instead
    // of leaving changedByName null, which renders as "System".
    const auditActor = await getOrProvisionCurrentUser(req).catch(() => null);
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: auditActor?.id ?? null,
      changedByName: auditActor?.fullName ?? null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to update packaging design");
    res.status(500).json({ error: "Failed to update packaging design" });
  }
});

// 2026-07-22 — Retail packaging is approved ONCE before the initial order and
// requires TWO Part 11 e-signatures: Quality (compliance / meets state
// requirements) + Manager (business sign-off). This slot-based endpoint signs
// one slot at a time; the design becomes "Approved" only when BOTH are signed,
// and the two signatures must be from two different people (segregation of
// duties). Additive alongside the legacy single /approve above, which the UI
// stops calling once the two-signer flow ships (increment #2c).
const QUALITY_SLOT_ROLES = new Set(["Quality", "Admin"]);
const MANAGER_SLOT_ROLES = new Set(["Manager", "Admin"]);
router.post("/packaging-designs/:id/sign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { slot, initials, signatureMeaning } = req.body as {
      slot?: string; initials?: string; signatureMeaning?: string;
    };
    if (slot !== "quality" && slot !== "manager") {
      res.status(400).json({ error: "slot must be 'quality' or 'manager'." }); return;
    }
    if (!initials || !signatureMeaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)" }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const allowed = slot === "quality" ? QUALITY_SLOT_ROLES : MANAGER_SLOT_ROLES;
    if (!allowed.has(actor.role)) {
      res.status(403).json({ error: slot === "quality"
        ? "Only Quality (or Admin) can sign the Quality approval."
        : "Only a Manager (or Admin) can sign the Manager approval." });
      return;
    }
    // Initials must match the signer's account (Part 11 attribution).
    if (actor.initials && initials.trim().toUpperCase() !== actor.initials.trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match your account. Sign with your own initials." }); return;
    }
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!before) { res.status(404).json({ error: "Packaging design not found" }); return; }
    if (before.status === "Approved") {
      res.status(409).json({ error: "This packaging design is already fully approved." }); return;
    }
    // The two sign-offs must be different people.
    const otherSignerId = slot === "quality" ? before.managerApproverId : before.qualityApproverId;
    if (otherSignerId && otherSignerId === actor.id) {
      res.status(409).json({ error: "The Quality and Manager approvals must be signed by two different people (21 CFR Part 11 segregation of duties)." });
      return;
    }

    // ⛔ 2026-08-31 — the checklist gate now runs HERE, not only on the button.
    // Both signatures cover what the design claims its packaging carries, so a
    // signature must not be obtainable while that claim is unverified — or while
    // it is unanswerable because no state has been named.
    const states0 = before.approvedStates ?? [];
    if (states0.length === 0) {
      res.status(409).json({ error: "Tick the states this design is approved for on Where Verified before signing." });
      return;
    }
    const resolved = resolveRequirements(before);
    const missingSets = resolved.stateStatus.filter((s) => !s.configured).map((s) => s.state);
    if (missingSets.length > 0) {
      res.status(409).json({
        error: `No rule set is loaded for ${missingSets.join(", ")}, so there is nothing to check this design against. An administrator adds a state's rules in Settings -> Regulatory.`,
      });
      return;
    }
    const ticked = new Set(before.checklistItems ?? []);
    const unverified = packagingKeysOf(resolved.requirements).filter((k) => !ticked.has(k));
    if (unverified.length > 0) {
      res.status(409).json({
        error: `Packaging Compliance is not complete — ${unverified.length} requirement${unverified.length === 1 ? "" : "s"} this packaging claims to carry ${unverified.length === 1 ? "has" : "have"} not been verified.`,
      });
      return;
    }
    const now = new Date();
    const signedInitials = (actor.initials ?? initials.trim()).toUpperCase();
    const slotFields = slot === "quality" ? {
      qualityApproverId: actor.id,
      qualityApproverName: actor.fullName,
      qualityApproverInitials: signedInitials,
      qualityApproverMeaning: signatureMeaning.trim(),
      qualityApprovedAt: now,
    } : {
      managerApproverId: actor.id,
      managerApproverName: actor.fullName,
      managerApproverInitials: signedInitials,
      managerApproverMeaning: signatureMeaning.trim(),
      managerApprovedAt: now,
    };
    const qualitySigned = slot === "quality" ? true : !!before.qualityApproverId;
    const managerSigned = slot === "manager" ? true : !!before.managerApproverId;
    const status = qualitySigned && managerSigned ? "Approved" : "Partially Approved";
    const [design] = await db.update(packagingDesignsTable).set({ ...slotFields, status, updatedAt: now }).where(eq(packagingDesignsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: slot === "quality" ? "APPROVE_QUALITY" : "APPROVE_MANAGER",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to sign packaging approval");
    res.status(500).json({ error: "Failed to sign packaging approval" });
  }
});

// ---------------------------------------------------------------------------
// Label-control step 1 (2026-08-31) — a design's STATES and its COVERAGE
// ---------------------------------------------------------------------------
//
// A packaging design is corporate: it is approved for a list of states, and it
// declares which of those states' labelling requirements the packaging itself
// carries. The batch's per-print checklist is then the REMAINDER — what no
// approved artefact carries.
//
// ⛔ This replaces the FACILITY-level assignment (facility_requirement_assignments,
// GET/PUT /api/label-requirements), which stored one answer per site. Coverage
// belongs to the artefact that does the carrying, not to the building it sits in.
// That table and its routes come out at step 5.
// ---------------------------------------------------------------------------

/** Who may decide where a requirement is met — same set that may edit a facility. */
const COVERAGE_ROLES = new Set(["Admin", "Quality", "Manager"]);

/** A design is frozen once it is approved, so its coverage freezes with it. */
function coverageLocked(status: string | null | undefined): boolean {
  return status === "Approved" || status === "Superseded";
}

type ResolvedRequirement = {
  key: string;
  itemText: string;
  regulationRef: string;
  /** "Packaging" (fixed) or "Labeling" (per batch). Null on a rule set written before the field. */
  control: string | null;
  required: boolean;
  /** Which of the design's states impose this one. */
  states: string[];
  target: string;
  /** Optional free text — today, why a NotApplicable answer was given. */
  note: string | null;
};

/**
 * Every requirement the design's states impose ON ITS PRODUCT TYPE, deduped by
 * key, with where the operator currently meets each.
 *
 * ⚠️ Resolution goes through `checklistTemplateFrom`, so the product-type
 * vocabulary bridge ("Vape Cartridge" -> "Vape") applies here exactly as it does
 * on a batch. Resolving it any other way is how a design ends up listing nothing.
 */
function resolveRequirements(design: {
  productType: string;
  approvedStates: string[] | null;
  requirementTargets: Record<string, string> | null;
  requirementNotes?: Record<string, string> | null;
}): { requirements: ResolvedRequirement[]; stateStatus: Array<{ state: string; configured: boolean; itemCount: number }> } {
  const states = design.approvedStates ?? [];
  const stored = design.requirementTargets ?? {};
  const notes = design.requirementNotes ?? {};
  const byKey = new Map<string, ResolvedRequirement>();
  const stateStatus: Array<{ state: string; configured: boolean; itemCount: number }> = [];

  for (const state of states) {
    const sets = getLabelChecklistsForState(state);
    if (!sets) {
      // ⛔ A state with no rule set loaded must SAY so. Rendering it as "no
      // requirements" would read as compliance, which is the one thing silence
      // must never mean here.
      stateStatus.push({ state, configured: false, itemCount: 0 });
      continue;
    }
    const items = checklistTemplateFrom(sets, design.productType, null) as ChecklistTemplateItem[];
    stateStatus.push({ state, configured: true, itemCount: items.length });
    for (const it of items) {
      if (!it.key) continue;
      const found = byKey.get(it.key);
      if (found) {
        if (!found.states.includes(state)) found.states.push(state);
        continue;
      }
      byKey.set(it.key, {
        key: it.key,
        itemText: it.itemText,
        regulationRef: it.regulationRef,
        control: it.control ?? null,
        required: it.required,
        states: [state],
        // ⛔ A stored "LabelStudio" is legacy (the answer was removed 2026-09-01)
        // and reads as "Labeling", which is what it always behaved as — it never
        // subtracted anything. No migration needed; it decays on the next save.
        target: normalizeTarget(stored[it.key]),
        note: notes[it.key] ?? null,
      });
    }
  }
  return { requirements: [...byKey.values()], stateStatus };
}

/**
 * Fold a stored target onto the three answers that exist now.
 *
 * "LabelStudio" was a fourth answer until 2026-09-01 — a packaging design saying
 * the LABEL carries something. That is the label's own statement to make, and
 * having it in two places meant they could disagree with nothing to reconcile
 * them. Only "Packaging" and "NotApplicable" ever discharged anything, so an old
 * "LabelStudio" row folds onto "Labeling" and behaves exactly as it always did.
 */
function normalizeTarget(stored: string | undefined): string {
  if (!stored || stored === "LabelStudio") return "Labeling";
  return stored;
}

/** The keys this design claims its packaging carries, limited to ones still imposed. */
function packagingKeysOf(requirements: ResolvedRequirement[]): string[] {
  return requirements.filter((r) => r.target === "Packaging").map((r) => r.key);
}

/**
 * Recompute the stored checklist after coverage changes.
 *
 * Ticks are kept ONLY for requirements still marked "Packaging" — otherwise
 * moving one off the packaging would leave its tick behind and inflate the
 * percentage. 100% with nothing to verify is correct, not vacuous: a design that
 * declares it carries nothing has discharged nothing, and everything it did not
 * claim is still asked before every print.
 */
function recomputeChecklist(
  requirements: ResolvedRequirement[],
  checklistItems: string[] | null,
): { checklistItems: string[]; checklistCompletePct: number } {
  const pkg = new Set(packagingKeysOf(requirements));
  const kept = (checklistItems ?? []).filter((k) => pkg.has(k));
  const pct = pkg.size === 0 ? 100 : Math.round((kept.length / pkg.size) * 100);
  return { checklistItems: kept, checklistCompletePct: pct };
}

router.get("/packaging-designs/:id/requirements", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [design] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!design) { res.status(404).json({ error: "Packaging design not found" }); return; }
    const { requirements, stateStatus } = resolveRequirements(design);
    res.json({
      designId: id,
      productType: design.productType,
      states: design.approvedStates ?? [],
      availableStates: getCachedRegulatoryStates(),
      targets: COVERAGE_TARGETS,
      stateStatus,
      requirements,
      checklistItems: design.checklistItems ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to resolve the design's requirements");
    res.status(500).json({ error: "Failed to resolve the requirements for this design" });
  }
});

router.put("/packaging-designs/:id/states", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!COVERAGE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Changing the states a design is approved for requires Admin / Quality / Manager. Your role is "${actor.role}".` });
      return;
    }
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!before) { res.status(404).json({ error: "Packaging design not found" }); return; }
    if (coverageLocked(before.status)) {
      res.status(409).json({ error: "This design is approved, so what it is approved for cannot change. Raise a new version." });
      return;
    }
    const raw = (req.body as { states?: unknown })?.states;
    if (!Array.isArray(raw)) { res.status(400).json({ error: "states must be an array." }); return; }
    const states = [...new Set(raw.map((s) => normalizeState(String(s))).filter((s): s is string => !!s))].sort();

    // Dropping a state can orphan a requirement only it imposed. Prune both the
    // decision and its tick so the checklist never counts something the design
    // is no longer answerable for.
    const { requirements } = resolveRequirements({ productType: before.productType, approvedStates: states, requirementTargets: before.requirementTargets ?? null });
    const live = new Set(requirements.map((r) => r.key));
    const targets: Record<string, string> = {};
    for (const [k, v] of Object.entries(before.requirementTargets ?? {})) if (live.has(k)) targets[k] = v;
    const notes: Record<string, string> = {};
    for (const [k, v] of Object.entries(before.requirementNotes ?? {})) if (live.has(k)) notes[k] = v;
    const { requirements: after } = resolveRequirements({ productType: before.productType, approvedStates: states, requirementTargets: targets });
    const checklist = recomputeChecklist(after, before.checklistItems ?? null);

    const [design] = await db.update(packagingDesignsTable)
      .set({ approvedStates: states, requirementTargets: targets, requirementNotes: notes, ...checklist, updatedAt: new Date() })
      .where(eq(packagingDesignsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to set the design's states");
    res.status(500).json({ error: "Failed to set the states for this design" });
  }
});

// ---------------------------------------------------------------------------
// WHICH PRODUCTS a design is for — 2026-09-02
// ---------------------------------------------------------------------------
//
// His ruling 09-01, from the domain: an edible pouch is specific to the edible
// and its flavour, because it prints the ingredients; cartridges share one pouch
// across every strain. So a design says which products it is for, in the same
// field and with the same two meanings a label template already uses:
//
//   empty     — every product of this type   (the cartridge pouch)
//   populated — only those products          (the cookie pouch)
//
// ⛔ NO one-approved-per-product gate here, unlike labels. A product wears one
// label but can sit in a pouch inside a carton, and coverage across several
// approved designs INTERSECTS, so more designs can only ever ask MORE questions.
// ---------------------------------------------------------------------------

router.put("/packaging-designs/:id/products", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!COVERAGE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Changing the products a design is for requires Admin / Quality / Manager. Your role is "${actor.role}".` });
      return;
    }
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!before) { res.status(404).json({ error: "Packaging design not found" }); return; }
    // ⛔ LOCKED AT APPROVAL, like the states beside it and unlike a label's
    // product list. Which products a pouch is for decides which batches stop
    // being asked its requirements, and the two signatures verified those
    // requirements against the scope as it stood. Narrowing or widening it
    // afterwards would move coverage under a signature nobody re-gave.
    if (coverageLocked(before.status)) {
      res.status(409).json({ error: "This design is approved, so the products it is for cannot change — the approval verified its requirements against those products. Raise a new version." });
      return;
    }
    const raw = (req.body as { productLineageIds?: unknown })?.productLineageIds;
    if (!Array.isArray(raw)) { res.status(400).json({ error: "productLineageIds must be an array." }); return; }
    const wanted = [...new Set(raw.map((v) => Number(v)).filter((v) => Number.isFinite(v)))];

    // ⛔ A design may not name a product of a different type — the grouping would
    // lie, and an Edible pouch would be offered for a cartridge. Same rule the
    // label templates live under.
    if (wanted.length > 0) {
      const recipes = await db.select().from(recipesTable);
      const typeByLineage = new Map<number, string>();
      for (const r of recipes) typeByLineage.set(r.lineageId ?? r.id, r.productType);
      const wrong = wanted.filter((l) => (typeByLineage.get(l) ?? before.productType) !== before.productType);
      if (wrong.length > 0) {
        res.status(409).json({ error: `This is a ${before.productType} design, so it can only be used by ${before.productType} products.` });
        return;
      }
    }

    const [design] = await db.update(packagingDesignsTable)
      .set({ productLineageIds: wanted, updatedAt: new Date() })
      .where(eq(packagingDesignsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to set the products for a design");
    res.status(500).json({ error: "Failed to set the products for this design" });
  }
});

router.put("/packaging-designs/:id/requirements/:key", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const key = String(req.params.key ?? "").trim();
    const target = String((req.body as { target?: unknown })?.target ?? "");
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!COVERAGE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Deciding where a requirement is met requires Admin / Quality / Manager. Your role is "${actor.role}".` });
      return;
    }
    // A client still holding the retired "LabelStudio" value is not an error —
    // it means "not the packaging", which is what Labeling already says.
    const wanted = target === "LabelStudio" ? "Labeling" : target;
    if (!(COVERAGE_TARGETS as readonly string[]).includes(wanted)) {
      res.status(400).json({ error: `target must be one of: ${COVERAGE_TARGETS.join(", ")}` });
      return;
    }
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!before) { res.status(404).json({ error: "Packaging design not found" }); return; }
    if (coverageLocked(before.status)) {
      res.status(409).json({ error: "This design is approved, so its coverage is frozen under the signatures that approved it. Raise a new version to change it." });
      return;
    }
    const { requirements } = resolveRequirements(before);
    const req0 = requirements.find((r) => r.key === key);
    if (!req0) {
      res.status(400).json({ error: "That requirement is not imposed by any state this design is approved for." });
      return;
    }
    // ⛔ THE RULE THAT KEEPS THIS SAFE. Fixed artwork can be verified once; a
    // value that changes with the batch cannot. A sticker having a THC *field*
    // does not verify this batch's *number*, so a Labeling requirement may never
    // be parked on the packaging — which is also why the per-print check can
    // never end up empty.
    if ((wanted === "Packaging" || wanted === "NotApplicable") && req0.control !== "Packaging") {
      res.status(409).json({
        error: wanted === "Packaging"
          ? "That one changes with every batch, so it cannot be verified once on the packaging. It stays on the per-print check."
          : "That one changes with every batch, so whether it applies is a question for the print in front of you, not for the design. Answer it N/A on the batch instead.",
      });
      return;
    }
    const targets: Record<string, string> = { ...(before.requirementTargets ?? {}) };
    // "Labeling" is the default, so storing it would give absence two meanings.
    if (wanted === "Labeling") delete targets[key];
    else targets[key] = wanted;

    // The note explains a NotApplicable answer, so it goes when the answer does.
    const rawNote = (req.body as { note?: unknown })?.note;
    const notes: Record<string, string> = { ...(before.requirementNotes ?? {}) };
    if (wanted !== "NotApplicable") delete notes[key];
    else if (typeof rawNote === "string") {
      const trimmed = rawNote.trim();
      if (trimmed) notes[key] = trimmed.slice(0, 500);
      else delete notes[key];
    }

    const { requirements: after } = resolveRequirements({ productType: before.productType, approvedStates: before.approvedStates ?? null, requirementTargets: targets });
    const checklist = recomputeChecklist(after, before.checklistItems ?? null);

    const [design] = await db.update(packagingDesignsTable)
      .set({ requirementTargets: targets, requirementNotes: notes, ...checklist, updatedAt: new Date() })
      .where(eq(packagingDesignsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to set where a requirement is met");
    res.status(500).json({ error: "Failed to record where that requirement is met" });
  }
});

router.put("/packaging-designs/:id/checklist/:key", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const key = String(req.params.key ?? "").trim();
    const verified = (req.body as { verified?: unknown })?.verified === true;
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const [before] = await db.select().from(packagingDesignsTable).where(eq(packagingDesignsTable.id, id));
    if (!before) { res.status(404).json({ error: "Packaging design not found" }); return; }
    if (coverageLocked(before.status)) {
      res.status(409).json({ error: "This design is approved — its checklist is frozen under the signatures that approved it." });
      return;
    }
    const { requirements } = resolveRequirements(before);
    if (!packagingKeysOf(requirements).includes(key)) {
      res.status(400).json({ error: "That requirement is not one this packaging claims to carry, so there is nothing to verify here." });
      return;
    }
    const set = new Set(before.checklistItems ?? []);
    if (verified) set.add(key); else set.delete(key);
    const checklist = recomputeChecklist(requirements, [...set]);

    const [design] = await db.update(packagingDesignsTable)
      .set({ ...checklist, updatedAt: new Date() })
      .where(eq(packagingDesignsTable.id, id)).returning();
    void writeAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: design as unknown as Record<string, unknown>,
    });
    res.json(design);
  } catch (err) {
    req.log.error({ err }, "Failed to record a packaging compliance tick");
    res.status(500).json({ error: "Failed to record that verification" });
  }
});

export default router;
