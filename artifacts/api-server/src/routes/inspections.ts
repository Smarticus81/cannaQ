import { Router } from "express";
import { db } from "@workspace/db";
import { incomingInspectionsTable, incomingInspectionItemsTable, inventoryItemsTable, suppliersTable, auditLogTable, lotsTable, lotEventsTable, nonConformancesTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { CANNABIS_BLOCKED_FOR_RECEIVING, isProductMaterialSupplierType } from "./suppliers";

// Session 33 (Tier 2 #6) — block material acceptance from cannabis cultivators
// or processors whose license isn't yet confirmed. Per the priority list:
// "prevent acceptance of material from a cannabis supplier in Conditional
// status." Extended here to also cover the new "License Pending" status
// introduced this session — a cannabis supplier on file without a confirmed
// license number shouldn't be on a receiving manifest.
const CANNABIS_SUPPLIER_TYPES = new Set(["Cannabis Cultivator", "Cannabis Processor"]);
async function supplierAcceptanceError(supplierId: number | null | undefined): Promise<string | null> {
  if (!supplierId) return null;
  const [s] = await db
    .select({ status: suppliersTable.status, supplierType: suppliersTable.supplierType, supplierName: suppliersTable.supplierName })
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!s) return null;
  if (!CANNABIS_SUPPLIER_TYPES.has(s.supplierType)) return null;
  if (CANNABIS_BLOCKED_FOR_RECEIVING.has(s.status)) {
    return `Cannot accept material from ${s.supplierName}: cannabis supplier is in status "${s.status}". Material acceptance is blocked until the supplier reaches Approved (license verified) status.`;
  }
  return null;
}

// Feedback 07-05 (SUP-2) — Incoming Inspections are for product-impacting
// materials only. Reject creation against an equipment / service / lab / other
// vendor so users can't open inspections for HVAC, pest control, ovens, mixing
// bowls, etc. (which would then land in inventory). Server-side mirror of the
// dialog's supplier-type filter. Returns an error string, or null when the
// supplier is a valid material supplier (or none is set).
async function supplierTypeError(supplierId: number | null | undefined): Promise<string | null> {
  if (!supplierId) return null;
  const [s] = await db
    .select({ supplierType: suppliersTable.supplierType, supplierName: suppliersTable.supplierName })
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!s) return null;
  if (isProductMaterialSupplierType(s.supplierType)) return null;
  return `Incoming Inspections are for materials that directly impact the product (cannabis inputs, raw materials, product-contact packaging). ${s.supplierName} is a "${s.supplierType}" — equipment and service vendors aren't received through inspections. If this vendor supplies a product material, change its Supplier Type; otherwise track it under Suppliers without an inspection.`;
}

// Roles permitted to sign off when Pass is granted with one or more failed items.
const SUPERVISOR_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

// Session 59 — roles permitted to DELETE a line item. Deleting a line removes a
// receiving record and, when that line had been accepted, pulls its stock back
// out of inventory, so it is not a clerk-level action. Note this deliberately
// excludes Supervisor, who may sign off a Pass but may not erase the line.
//
// Same membership as CANCEL_ROLES below but kept as its own set: they are two
// independent policies that happen to agree today, and one should be able to
// change without silently moving the other.
const ITEM_DELETE_ROLES = new Set(["Manager", "Quality", "Admin"]);

// Potency capture (2026-09-06). A number input posts a STRING, and an empty one
// posts "" — which Number() turns into 0. A COA value of 0% and "no COA recorded"
// are different facts, so anything blank or unparseable becomes NULL, never zero.
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// Step 1 (inventory/lots unification) — the lots table is the single shared
// on-hand ledger. When a received item lands in inventory, also open its lot
// here so the Inventory rollup and Lot Traceability read the same numbers.
// is_cannabis is taken from the inspection's supplier type (cultivator/processor
// = cannabis), which decides whether the lot shows on the cannabis-only Lot view.
// Best-effort: any failure is swallowed so it can NEVER break inventory receiving.
async function openLotForReceivedItem(
  inspectionId: number,
  inventoryItemId: number,
  it: typeof incomingInspectionItemsTable.$inferSelect,
): Promise<void> {
  try {
    // Idempotent: one lot per inventory item.
    const existing = await db.select({ id: lotsTable.id }).from(lotsTable)
      .where(eq(lotsTable.inventoryItemId, inventoryItemId));
    if (existing.length > 0) return;

    // Cannabis flag + item type come from the chosen Material Type (any
    // "Cannabis – …" value = cannabis). Fall back to the supplier type only when
    // Material Type wasn't set (older items / legacy receipts).
    const materialType = it.materialType?.trim() || "";
    let isCannabis: boolean;
    if (materialType) {
      isCannabis = materialType.toLowerCase().startsWith("cannabis");
    } else {
      isCannabis = false;
      const [insp] = await db.select({ supplierId: incomingInspectionsTable.supplierId })
        .from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, inspectionId));
      if (insp?.supplierId) {
        const [s] = await db.select({ supplierType: suppliersTable.supplierType })
          .from(suppliersTable).where(eq(suppliersTable.id, insp.supplierId));
        isCannabis = s ? CANNABIS_SUPPLIER_TYPES.has(s.supplierType) : false;
      }
    }
    const lotItemType = materialType || "Received Material";

    const qty = it.quantityReceived ?? 0;
    // Use the supplier's lot number when given; otherwise a unique synthetic one
    // (RCV-<inventoryItemId>) so the lot_number UNIQUE constraint can't collide.
    const metrcTag = (it.metrcTag && it.metrcTag.trim()) ? it.metrcTag.trim() : null;
    // For cannabis, the METRC tag captured at receiving IS the lot identifier;
    // fall back to it when no vendor/internal lot number was entered.
    const lotNumber = (it.lotNumber && it.lotNumber.trim()) ? it.lotNumber.trim() : (isCannabis ? metrcTag : null);

    const [lot] = await db.insert(lotsTable).values({
      lotNumber,
      metrcPackageId: metrcTag,
      itemName: it.itemName,
      itemType: lotItemType,
      unitOfMeasure: it.quantityUom ?? "ea",
      originalQuantity: qty,
      currentQuantity: qty,
      origin: "received",
      status: "Active",
      inventoryItemId,
      sourceInspectionId: inspectionId,
      isCannabis,
      // BR-1/BR-3 — carry the expiry captured on the receiving line onto the
      // lot so it flows to the inventory picker + batch ingredient dialog.
      expirationDate: it.expiryDate ?? null,
      // Potency (2026-09-06) — carry the COA values captured on the receiving
      // line onto the lot, so the Inventory screen and the ingredient picker can
      // show what a cannabis lot assays at. Only for CANNABIS lines: a
      // non-cannabis material has no THC/CBD and must not display 0%.
      thcPct: isCannabis ? (it.thcPct ?? null) : null,
      cbdPct: isCannabis ? (it.cbdPct ?? null) : null,
      potencySource: isCannabis && (it.thcPct != null || it.cbdPct != null)
        ? (it.potencySource ?? "manual")
        : null,
      potencyTestedAt: isCannabis ? (it.potencyTestedAt ?? null) : null,
      notes: `Auto-created from inspection ${inspectionId}`,
    }).returning({ id: lotsTable.id });

    await db.insert(lotEventsTable).values({
      lotId: lot.id,
      eventType: "create",
      quantityDelta: qty,
      resultingQuantity: qty,
      reason: "Lot created (received)",
    });
  } catch {
    // Never break the inventory propagation if lot creation hiccups.
  }
}

const router = Router();

// Use max(id) + 1 instead of count(*) so deleted rows don't compress numbering
// and concurrent inserts can't both pick the same value (DB unique on
// inspection_number is the final guard; we retry once on collision).
async function generateInspectionNumber(): Promise<string> {
  const [row] = await db.select({ maxId: sql<number>`coalesce(max(${incomingInspectionsTable.id}), 0)` }).from(incomingInspectionsTable);
  const seq = (row?.maxId ?? 0) + 1;
  return `INS-${String(seq).padStart(4, "0")}`;
}

// Propagate any items with result = "Pass" to inventory_items, regardless of
// the parent inspection's state. Session 33 (Tier 2 #8) shifts this from
// "whole-inspection Pass triggers all-items propagation" to "item-level Pass
// triggers immediate propagation." Whole-inspection Pass becomes an aggregate
// summary — still useful, but no longer the gate on inventory creation.
//
// Idempotent via the UNIQUE constraint on inventory_items.source_inspection_item_id.
// A line item lands in inventory when it PASSED, or when it FAILED but was
// dispositioned "Use As Is" (accepted under concession). RTV / Scrap / Rework
// never create a lot.
function acceptedForInventory(it: { result: string; disposition?: string | null }): boolean {
  return it.result === "Pass" || (it.result === "Fail" && it.disposition === "Use As Is");
}

async function propagateAcceptedItemsToInventory(inspectionId: number): Promise<number> {
  const items = await db.select().from(incomingInspectionItemsTable)
    .where(eq(incomingInspectionItemsTable.inspectionId, inspectionId));
  let created = 0;
  for (const it of items) {
    if (!acceptedForInventory(it)) continue;
    // Skip if this exact line item is already mirrored to inventory.
    const existing = await db.select({ id: inventoryItemsTable.id }).from(inventoryItemsTable)
      .where(eq(inventoryItemsTable.sourceInspectionItemId, it.id));
    if (existing.length > 0) continue;
    const [invItem] = await db.insert(inventoryItemsTable).values({
      itemName: it.itemName,
      itemType: it.materialType ?? "Received Material",
      lotNumber: it.lotNumber,
      quantity: it.quantityReceived ?? 0,
      unitOfMeasure: it.quantityUom ?? "ea",
      sourceInspectionItemId: it.id,
      notes: `Auto-added from inspection ${inspectionId}` + (it.result === "Fail" && it.disposition === "Use As Is" ? " — UAI concession" : "") + (it.notes ? ` — ${it.notes}` : ""),
    }).returning({ id: inventoryItemsTable.id });
    await openLotForReceivedItem(inspectionId, invItem.id, it);
    created++;
  }
  return created;
}

// Session 33 — single-item propagation helper used by the item POST/PATCH
// endpoints. Mirrors the bulk variant but only touches the one row, which
// keeps the per-request work bounded as inspections grow.
async function propagateSingleItemToInventory(
  inspectionId: number,
  it: typeof incomingInspectionItemsTable.$inferSelect,
): Promise<boolean> {
  if (!acceptedForInventory(it)) return false;
  const existing = await db.select({ id: inventoryItemsTable.id }).from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.sourceInspectionItemId, it.id));
  if (existing.length > 0) return false;
  const [invItem] = await db.insert(inventoryItemsTable).values({
    itemName: it.itemName,
    itemType: "Received Material",
    lotNumber: it.lotNumber,
    quantity: it.quantityReceived ?? 0,
    unitOfMeasure: it.quantityUom ?? "ea",
    sourceInspectionItemId: it.id,
    notes: `Auto-added from inspection ${inspectionId}` + (it.result === "Fail" && it.disposition === "Use As Is" ? " — UAI concession" : "") + (it.notes ? ` — ${it.notes}` : ""),
  }).returning({ id: inventoryItemsTable.id });
  await openLotForReceivedItem(inspectionId, invItem.id, it);
  return true;
}

// Session 59 — the mirror image of propagate. Passing a line item creates an
// inventory row and opens its lot; changing that line back to Fail (or switching
// a "Use As Is" concession to RTV / Scrap / Rework) has to take them back out,
// or rejected material sits in usable stock — the exact thing incoming
// inspection exists to prevent. Propagation is insert-only, so nothing did this
// and the row simply stayed at full quantity, drawable into a batch.
//
// The LOT is deleted along with the inventory row rather than left behind:
// lots.lot_number is UNIQUE, so an orphan would make a later re-Pass collide and
// silently fail to open a new lot (openLotForReceivedItem swallows its errors),
// leaving inventory and the lot ledger disagreeing. Re-Passing the line then
// re-inserts both through the normal propagate path.

// How much of the mirrored lot a batch has already taken, or null when nothing
// has been drawn. Deliberately checked BEFORE the edit is written, so a refusal
// can be a 409 the operator actually sees — the deferred worker below has
// already answered 200 and could only write the refusal to the server log.
async function drawnDownLotForItem(
  itemId: number,
): Promise<{ lotNumber: string | null; consumed: number } | null> {
  const [inv] = await db.select({ id: inventoryItemsTable.id }).from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.sourceInspectionItemId, itemId)).limit(1);
  if (!inv) return null;
  const lots = await db.select().from(lotsTable).where(eq(lotsTable.inventoryItemId, inv.id));
  for (const l of lots) {
    const consumed = (l.originalQuantity ?? 0) - (l.currentQuantity ?? 0);
    if (consumed > 0) return { lotNumber: l.lotNumber, consumed };
  }
  return null;
}

// Removes the inventory row and lot a line item created. Call only after
// drawnDownLotForItem has come back null.
async function withdrawItemFromInventory(
  itemId: number,
): Promise<{ invId: number; itemName: string; quantity: number } | null> {
  const [inv] = await db.select().from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.sourceInspectionItemId, itemId)).limit(1);
  if (!inv) return null;
  await db.delete(lotsTable).where(eq(lotsTable.inventoryItemId, inv.id));
  await db.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, inv.id));
  return { invId: inv.id, itemName: inv.itemName, quantity: inv.quantity };
}

// Session 57 (06-04 bug #2) — re-sync an existing inventory row when a Pass
// item's received quantity (or lot / uom / name) is edited AFTER it was first
// propagated. The propagate helpers above are insert-only and idempotent: they
// skip whenever a row already exists for the line item, so a corrected weight
// never reached inventory (the operator received material, Passed it, then
// revised the weight and inventory kept the original number).
//
// We apply the DELTA of quantityReceived to inventory.quantity rather than
// overwriting it, so any amount already consumed by a batch is preserved:
//   inv.quantity += (newReceived - oldReceived)   (clamped at 0)
// e.g. received 100 → batch took 30 (inv 70) → operator corrects receipt to 120
//      → inv becomes 90, not 120. Descriptive fields (lot, uom, name) are
// mirrored so the inventory row stays accurate. Returns the before/after
// quantity for the audit trail, or null when there is no row or nothing changed.
async function resyncInventoryForItem(
  before: typeof incomingInspectionItemsTable.$inferSelect,
  after: typeof incomingInspectionItemsTable.$inferSelect,
): Promise<{ invId: number; beforeQty: number; afterQty: number } | null> {
  const [inv] = await db.select().from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.sourceInspectionItemId, after.id)).limit(1);
  if (!inv) return null;
  const oldReceived = before.quantityReceived ?? 0;
  const newReceived = after.quantityReceived ?? 0;
  const delta = newReceived - oldReceived;
  const descChanged =
    (after.lotNumber ?? null) !== (before.lotNumber ?? null) ||
    (after.quantityUom ?? null) !== (before.quantityUom ?? null) ||
    after.itemName !== before.itemName;
  if (delta === 0 && !descChanged) return null;
  const [updated] = await db.update(inventoryItemsTable).set({
    quantity: sql`GREATEST(${inventoryItemsTable.quantity} + ${delta}, 0)`,
    lotNumber: after.lotNumber,
    unitOfMeasure: after.quantityUom ?? inv.unitOfMeasure,
    itemName: after.itemName,
    updatedAt: new Date(),
  }).where(eq(inventoryItemsTable.id, inv.id))
    .returning({ before: sql<number>`${inv.quantity}`.as("before"), after: inventoryItemsTable.quantity });
  return { invId: inv.id, beforeQty: updated?.before ?? inv.quantity, afterQty: updated?.after ?? inv.quantity };
}

router.get("/incoming-inspections", async (req, res) => {
  try {
    let inspections = await db.select().from(incomingInspectionsTable).orderBy(incomingInspectionsTable.createdAt);
    // Session 52.1 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled inspections (the Cancelled view). Cancel is the no-hard-delete
    // pattern — mirrors non_conformances.ts.
    const cancelled = req.query.cancelled === "true";
    inspections = cancelled
      ? inspections.filter((r) => (r as { cancelledAt?: Date | null }).cancelledAt)
      : inspections.filter((r) => !(r as { cancelledAt?: Date | null }).cancelledAt);
    res.json(inspections.reverse());
  } catch (err) {
    req.log.error({ err }, "Failed to list inspections");
    res.status(500).json({ error: "Failed to list inspections" });
  }
});

router.post("/incoming-inspections", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Session 33 (Tier 2 #6) — supplier-state gate.
    const supplierIdRaw = body.supplierId;
    const supplierId = typeof supplierIdRaw === "number" ? supplierIdRaw
      : (typeof supplierIdRaw === "string" && supplierIdRaw ? parseInt(supplierIdRaw, 10) : null);
    if (supplierId) {
      // Feedback 07-05 (SUP-2) — reject non-material (equipment/service/lab) suppliers first.
      const typeErr = await supplierTypeError(supplierId);
      if (typeErr) { res.status(409).json({ error: typeErr }); return; }
      const err = await supplierAcceptanceError(supplierId);
      if (err) { res.status(409).json({ error: err }); return; }
    }

    const inspectionNumber = await generateInspectionNumber();
    // Session 97 (Slice 1) — persist the supplier as a real FK. Override the raw
    // body value with the parsed integer (or null) so a string id from the client
    // can't hit the integer column, and the inspection→supplier-score link is now
    // by id, not just the mirrored name.
    const [inspection] = await db.insert(incomingInspectionsTable).values({ ...body, supplierId, inspectionNumber } as typeof incomingInspectionsTable.$inferInsert).returning();
    res.status(201).json(inspection);
  } catch (err) {
    req.log.error({ err }, "Failed to create inspection");
    res.status(500).json({ error: "Failed to create inspection" });
  }
});

// GET /incoming-inspections/item-name-options — distinct item names from prior
// receiving lines AND the inventory_items catalog (incl. the starter set), powering
// an autocomplete on the Item Name field so users reuse
// the canonical name ("Mouthpiece") instead of near-duplicates ("Mouthpieces")
// that split inventory. MUST be registered BEFORE /:id so it isn't captured as an id.
//
// Each entry now carries the item's TYPE as well, so the forms can fill Material /
// Item Type automatically once a known name is chosen. The type already existed on
// both tables and was simply being discarded here. Nothing is inferred or guessed:
// the answer is whatever the facility recorded for that item, which keeps the
// filled-in value explainable on a Part 11 record.
//
// The catalog rows also carry their UNIT, so the forms can fill UoM from how the
// item is actually stocked rather than from a per-type default that is null for
// every non-cannabis type. Unit comes from the CATALOG ONLY, never from receiving
// history: a receiving line's UoM is what one clerk recorded that day, while the
// catalog's is how the item is stocked, and the two are allowed to differ.
//
// Response shape: [{ itemName, itemType, unitOfMeasure }] — itemType and
// unitOfMeasure are null when the name has only ever appeared without one.
router.get("/incoming-inspections/item-name-options", async (req, res) => {
  try {
    // Names come from two sources so receiving reuses a canonical name instead of
    // minting a near-duplicate: (1) item names used on prior receiving lines, and
    // (2) the inventory_items catalog — which includes the pre-loaded starter set.
    const [inspRows, catRows] = await Promise.all([
      db
        .selectDistinct({
          itemName: incomingInspectionItemsTable.itemName,
          itemType: incomingInspectionItemsTable.materialType,
        })
        .from(incomingInspectionItemsTable),
      db
        .selectDistinct({
          itemName: inventoryItemsTable.itemName,
          itemType: inventoryItemsTable.itemType,
          unitOfMeasure: inventoryItemsTable.unitOfMeasure,
        })
        .from(inventoryItemsTable),
    ]);

    // Catalog entries are written LAST so they win on collision: the catalog is how
    // the facility deliberately set the item up, whereas a receiving line is one
    // clerk's entry on one day. A name only present in receiving history still
    // contributes its type rather than coming back bare.
    const byName = new Map<string, { itemName: string; itemType: string | null; unitOfMeasure: string | null }>();
    for (const r of [...inspRows, ...catRows]) {
      const itemName = (r.itemName ?? "").trim();
      if (!itemName) continue;
      const itemType = (r.itemType ?? "").trim() || null;
      // Read as an optional field rather than narrowing with `in`: the two
      // selects have different shapes, and `in` collapses the union to {}.
      const unitOfMeasure = ((r as { unitOfMeasure?: string | null }).unitOfMeasure ?? "").trim() || null;
      const existing = byName.get(itemName);
      // Fields are merged rather than the row replaced wholesale, so a later
      // entry that is missing one of them can't erase a value already found.
      byName.set(itemName, {
        itemName,
        itemType: itemType ?? existing?.itemType ?? null,
        unitOfMeasure: unitOfMeasure ?? existing?.unitOfMeasure ?? null,
      });
    }

    const options = Array.from(byName.values()).sort((a, b) => a.itemName.localeCompare(b.itemName));
    res.json(options);
  } catch (err) {
    req.log.error({ err }, "Failed to list item-name options");
    res.status(500).json({ error: "Failed to list item-name options" });
  }
});

router.get("/incoming-inspections/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [inspection] = await db.select().from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, id));
    if (!inspection) { res.status(404).json({ error: "Inspection not found" }); return; }
    res.json(inspection);
  } catch (err) {
    req.log.error({ err }, "Failed to get inspection");
    res.status(500).json({ error: "Failed to get inspection" });
  }
});

router.patch("/incoming-inspections/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [prev] = await db.select().from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, id));
    if (!prev) { res.status(404).json({ error: "Inspection not found" }); return; }
    // Session 52.1.1 — a cancelled inspection is read-only (Re-open via /uncancel first).
    if ((prev as { cancelledAt?: Date | null }).cancelledAt) {
      res.status(409).json({ error: "This inspection is cancelled and read-only. Re-open it first (Admin)." }); return;
    }

    // Closed inspections are immutable except for re-open by privileged role
    // (out of scope here — block all PATCHes once Closed).
    if (prev.result === "Closed") {
      res.status(409).json({ error: "Inspection is Closed and cannot be modified." });
      return;
    }

    const nextResult: string | undefined = req.body?.result;
    const isStateChange = typeof nextResult === "string" && nextResult !== prev.result;

    // Pull current items once for all the state-transition guards below.
    const itemsForGuards = isStateChange
      ? await db.select({ id: incomingInspectionItemsTable.id, result: incomingInspectionItemsTable.result })
          .from(incomingInspectionItemsTable)
          .where(eq(incomingInspectionItemsTable.inspectionId, id))
      : [];

    // Pass-transition guards: must have items, none Pending. If any item is
    // Fail, require Supervisor+ sign-off (Part 11 e-sig) per QMS requirement.
    const transitioningToPass = nextResult === "Pass" && prev.result !== "Pass";
    let supervisorApproval: { name: string; initials: string; meaning: string } | null = null;
    if (transitioningToPass) {
      if (itemsForGuards.length === 0) {
        res.status(409).json({ error: "Cannot Pass an inspection with no line items." });
        return;
      }
      if (itemsForGuards.some(it => it.result === "Pending")) {
        res.status(409).json({ error: "Cannot Pass an inspection while some line items are Pending." });
        return;
      }
      const anyFailed = itemsForGuards.some(it => it.result === "Fail");
      if (anyFailed) {
        const actor = await getOrProvisionCurrentUser(req);
        if (!actor) { res.status(401).json({ error: "Authentication required to approve a Pass with failed items." }); return; }
        const initials = String(req.body?.approverInitials ?? "").trim().toUpperCase();
        const meaning = String(req.body?.approverMeaning ?? "").trim();
        if (!initials || !meaning) {
          res.status(400).json({ error: "Pass requires Supervisor+ approval: approverInitials and approverMeaning are required because one or more line items failed." });
          return;
        }
        if (!SUPERVISOR_ROLES.has(actor.role)) {
          res.status(403).json({ error: `Pass requires Supervisor / Manager / Quality / Admin role when any line item is Fail. Your role is "${actor.role}".` });
          return;
        }
        if ((actor.initials ?? "").toUpperCase() !== initials) {
          res.status(400).json({ error: "Initials do not match the signed-in user." });
          return;
        }
        supervisorApproval = { name: actor.fullName, initials, meaning };
      }
    }

    // Session 56 (06-04 compliance) — Inspector-only close. An inspection may
    // only be moved to Closed by the user listed as its Inspector (inspectedBy).
    // This is an identity match, stricter than the role gates elsewhere: the
    // operator observed an inspection closed by someone other than the listed
    // Inspector. If no Inspector is on file there is no one to match, so require
    // one be assigned first.
    const transitioningToClosed = nextResult === "Closed" && prev.result !== "Closed";
    if (transitioningToClosed) {
      const actor = await getOrProvisionCurrentUser(req);
      if (!actor) { res.status(401).json({ error: "Authentication required to close an inspection." }); return; }
      // Match the acting user to the listed Inspector. Prefer the user-id link
      // (inspectedBy), but the create dialog still captures the Inspector as
      // free-text (inspectedByName) and never sets the id — so fall back to a
      // case-insensitive name match. Without this fallback every close would
      // 409, since inspectedBy is null on UI-created inspections. Converting the
      // Inspector field to a strict user-id picker (as S54 did for NC Reported
      // By) is the proper follow-up. If neither id nor name is on file there is
      // no Inspector to match against.
      const hasId = prev.inspectedBy != null;
      const inspectorName = (prev.inspectedByName ?? "").trim();
      const hasName = inspectorName.length > 0;
      if (!hasId && !hasName) {
        res.status(409).json({ error: "Assign an Inspector to this inspection before it can be closed." });
        return;
      }
      const idMatches = hasId && actor.id === prev.inspectedBy;
      const nameMatches = hasName && actor.fullName.trim().toLowerCase() === inspectorName.toLowerCase();
      if (!idMatches && !nameMatches) {
        res.status(403).json({ error: `Only the listed Inspector (${hasName ? inspectorName : "the assigned inspector"}) may close this inspection. You are signed in as ${actor.fullName}.` });
        return;
      }
    }

    // Fail / Conditional require a rationale (Part 11 traceability). The audit
    // log captures full history; we also mirror it onto the row for easy display.
    let rationaleSnapshot: { text: string; byName: string; at: Date } | null = null;
    if (isStateChange && (nextResult === "Fail" || nextResult === "Conditional")) {
      const rationale = String(req.body?.rationale ?? "").trim();
      if (!rationale) {
        res.status(400).json({ error: `Moving to ${nextResult} requires a rationale (per QMS).` });
        return;
      }
      const actor = await getOrProvisionCurrentUser(req);
      const byName = actor?.fullName ?? "Unknown";
      rationaleSnapshot = { text: rationale, byName, at: new Date() };
    }

    // Strip non-column fields from the body before update. The cancelled_*
    // fields are managed only by /cancel + /uncancel (Session 52.1) — never by
    // a field edit. Mirrors the non_conformances.ts PATCH strip.
    const {
      approverInitials: _ai, approverMeaning: _am, rationale: _r,
      cancelledAt: _ca, cancelledReason: _cr, cancelledByName: _cbn,
      cancelledByInitials: _cbi, cancelledMeaning: _cm,
      ...persistBody
    } = (req.body ?? {}) as Record<string, unknown>;
    const updatePayload: Record<string, unknown> = { ...persistBody, updatedAt: new Date() };
    if (rationaleSnapshot) {
      updatePayload.stateRationale = rationaleSnapshot.text;
      updatePayload.stateRationaleByName = rationaleSnapshot.byName;
      updatePayload.stateRationaleAt = rationaleSnapshot.at;
    }
    if (supervisorApproval) {
      updatePayload.passApproverName = supervisorApproval.name;
      updatePayload.passApproverInitials = supervisorApproval.initials;
      updatePayload.passApproverMeaning = supervisorApproval.meaning;
      updatePayload.passApprovedAt = new Date();
    }

    const [inspection] = await db.update(incomingInspectionsTable)
      .set(updatePayload as never)
      .where(eq(incomingInspectionsTable.id, id))
      .returning();

    // Audit-log the state transition with rationale/approval payload for Part 11.
    if (isStateChange) {
      const actor = await getOrProvisionCurrentUser(req);
      try {
        await db.insert(auditLogTable).values({
          tableName: "incoming_inspections",
          rowId: id,
          operation: `TRANSITION_TO_${nextResult?.toUpperCase()}`,
          changedBy: actor?.id ?? null,
          changedByName: actor?.fullName ?? null,
          beforeState: { result: prev.result } as never,
          afterState: {
            result: nextResult,
            rationale: rationaleSnapshot?.text ?? null,
            supervisorApproval: supervisorApproval
              ? { name: supervisorApproval.name, initials: supervisorApproval.initials, meaning: supervisorApproval.meaning }
              : null,
          } as never,
        });
      } catch (e) {
        req.log.error({ err: e, inspectionId: id }, "Audit log write failed (state change kept)");
      }
    } else {
      // Session 100 — audit plain field edits too (previously only state
      // transitions were logged), attributed to the signed-in user (Part 11)
      // so the change no longer renders as "System".
      const editActor = await getOrProvisionCurrentUser(req).catch(() => null);
      try {
        await db.insert(auditLogTable).values({
          tableName: "incoming_inspections",
          rowId: id,
          operation: "UPDATE",
          changedBy: editActor?.id ?? null,
          changedByName: editActor?.fullName ?? null,
          beforeState: prev as never,
          afterState: (inspection ?? null) as never,
        });
      } catch (e) {
        req.log.error({ err: e, inspectionId: id }, "Audit log write failed (edit kept)");
      }
    }

    // If transitioning to Pass, auto-add accepted items to Inventory.
    let addedToInventory = 0;
    if (inspection && prev.result !== "Pass" && inspection.result === "Pass") {
      try {
        addedToInventory = await propagateAcceptedItemsToInventory(id);
      } catch (e) {
        req.log.error({ err: e, inspectionId: id }, "Inventory propagation failed (state change kept)");
      }
    }
    res.json({ ...inspection, addedToInventory });
  } catch (err) {
    req.log.error({ err }, "Failed to update inspection");
    res.status(500).json({ error: "Failed to update inspection" });
  }
});

// ── Inspection Items (line items per delivery) ────────────────────────────────

router.get("/incoming-inspections/:id/items", async (req, res) => {
  try {
    const inspectionId = parseInt(req.params.id);
    const items = await db.select().from(incomingInspectionItemsTable)
      .where(eq(incomingInspectionItemsTable.inspectionId, inspectionId))
      .orderBy(incomingInspectionItemsTable.createdAt);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Failed to list inspection items");
    res.status(500).json({ error: "Failed to list inspection items" });
  }
});

// NC-1 (2026-07-12) — reverse side of the NC↔inspection link. An NC stores its
// origin as sourceInspectionId; this surfaces "NCs raised from this inspection"
// on the inspection so the cross-reference reads both ways (NC→INS was already
// shown on the NC page; INS→NC was missing).
router.get("/incoming-inspections/:id/non-conformances", async (req, res) => {
  try {
    const inspectionId = parseInt(req.params.id);
    const ncs = await db
      .select({
        id: nonConformancesTable.id,
        ncNumber: nonConformancesTable.ncNumber,
        title: nonConformancesTable.title,
        severity: nonConformancesTable.severity,
        status: nonConformancesTable.status,
        createdAt: nonConformancesTable.createdAt,
      })
      .from(nonConformancesTable)
      .where(eq(nonConformancesTable.sourceInspectionId, inspectionId))
      .orderBy(nonConformancesTable.createdAt);
    res.json(ncs);
  } catch (err) {
    req.log.error({ err }, "Failed to list NCs for inspection");
    res.status(500).json({ error: "Failed to list non-conformances for inspection" });
  }
});

router.post("/incoming-inspections/:id/items", async (req, res) => {
  try {
    const inspectionId = parseInt(req.params.id);
    const [parent] = await db.select({ id: incomingInspectionsTable.id, result: incomingInspectionsTable.result, cancelledAt: incomingInspectionsTable.cancelledAt }).from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, inspectionId));
    if (!parent) { res.status(404).json({ error: "Inspection not found" }); return; }
    // Session 52.2.1 — a cancelled inspection is read-only.
    if (parent.cancelledAt) { res.status(409).json({ error: "This inspection is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (parent.result === "Closed") { res.status(409).json({ error: "Cannot add an item to a Closed inspection (21 CFR Part 11). Re-open it first (Admin)." }); return; }
    const body = req.body ?? {};
    if (!body.itemName || typeof body.itemName !== "string" || !body.itemName.trim()) {
      res.status(400).json({ error: "itemName is required" }); return;
    }
    // Cannabis materials must carry their METRC package tag from receiving.
    if (typeof body.materialType === "string" && body.materialType.toLowerCase().startsWith("cannabis") && !(typeof body.metrcTag === "string" && body.metrcTag.trim())) {
      res.status(400).json({ error: "A METRC package tag is required for cannabis materials." }); return;
    }
    const [item] = await db.insert(incomingInspectionItemsTable).values({
      inspectionId,
      itemName: body.itemName.trim(),
      materialType: body.materialType ?? null,
      supplierItemCode: body.supplierItemCode ?? null,
      lotNumber: body.lotNumber ?? null,
      metrcTag: body.metrcTag ?? null,
      strainType: body.strainType ?? null,
      // Potency off the COA (2026-09-06). Stored on the receiving line and copied
      // onto the lot when the line is accepted (openLotForReceivedItem).
      thcPct: numOrNull(body.thcPct),
      cbdPct: numOrNull(body.cbdPct),
      potencySource: body.potencySource ?? null,
      potencyTestedAt: body.potencyTestedAt ?? null,
      expiryDate: body.expiryDate ?? null,
      quantityReceived: body.quantityReceived ?? null,
      quantityUom: body.quantityUom ?? null,
      result: body.result ?? "Pass",
      notes: body.notes ?? null,
    }).returning();
    // Session 33 (Tier 2 #8) — item-level Pass triggers inventory propagation
    // immediately, regardless of parent inspection state. Previously this
    // required parent.result === "Pass", which left material stranded while
    // CoAs were still pending on other items in the same delivery. The
    // whole-inspection Pass is still a meaningful aggregate (means "every
    // line resolved, any Fails Part 11-signed") but it no longer gates
    // inventory creation.
    if (acceptedForInventory(item)) {
      try { await propagateSingleItemToInventory(inspectionId, item); }
      catch (e) { req.log.error({ err: e, inspectionId, itemId: item.id }, "Inventory propagation on item POST failed"); }
    }
    res.status(201).json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to create inspection item");
    res.status(500).json({ error: "Failed to create inspection item" });
  }
});

router.patch("/incoming-inspections/:inspectionId/items/:itemId", async (req, res) => {
  try {
    const inspectionId = parseInt(req.params.inspectionId);
    const itemId = parseInt(req.params.itemId);
    // Session 52.2.1 — a cancelled inspection is read-only.
    {
      const [parent] = await db.select({ cancelledAt: incomingInspectionsTable.cancelledAt, result: incomingInspectionsTable.result }).from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, inspectionId));
      if (parent?.cancelledAt) { res.status(409).json({ error: "This inspection is cancelled and read-only. Re-open it first (Admin)." }); return; }
      if (parent?.result === "Closed") { res.status(409).json({ error: "Cannot edit an item on a Closed inspection (21 CFR Part 11). Re-open it first (Admin)." }); return; }
    }
    // Session 57 — capture the pre-edit item so we can compute the inventory
    // delta when a received weight is revised after Pass (06-04 bug #2).
    const [before] = await db.select().from(incomingInspectionItemsTable)
      .where(and(
        eq(incomingInspectionItemsTable.id, itemId),
        eq(incomingInspectionItemsTable.inspectionId, inspectionId),
      ));
    if (!before) { res.status(404).json({ error: "Inspection item not found" }); return; }
    const body = { ...req.body };
    delete body.id;
    delete body.inspectionId;
    delete body.createdAt;
    // Session 59 — this edit may un-accept a line that is already mirrored into
    // inventory. Refuse up front when a batch has drawn on its lot: removing the
    // lot would break that batch's record, and that wants a deliberate
    // Non-Conformance rather than a quiet edit on the receiving screen.
    {
      const wouldBe = {
        result: typeof body.result === "string" ? body.result : before.result,
        disposition: "disposition" in body ? (body.disposition as string | null) : before.disposition,
      };
      if (acceptedForInventory(before) && !acceptedForInventory(wouldBe)) {
        const drawn = await drawnDownLotForItem(before.id);
        if (drawn) {
          res.status(409).json({
            error: `Can't reject "${before.itemName}" — ${drawn.consumed} ${before.quantityUom ?? ""}`.replace(/\s+/g, " ").trim()
              + ` has already been drawn from lot ${drawn.lotNumber ?? "(no lot number)"} into production.`
              + " Removing it from inventory now would break that batch's record."
              + " Raise a Non-Conformance against the affected batch instead.",
          });
          return;
        }
      }
    }
    const [item] = await db.update(incomingInspectionItemsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(and(
        eq(incomingInspectionItemsTable.id, itemId),
        eq(incomingInspectionItemsTable.inspectionId, inspectionId),
      )).returning();
    if (!item) { res.status(404).json({ error: "Inspection item not found" }); return; }
    // Answer the operator's edit immediately. Session 58.1 — inventory
    // propagation / re-sync is deferred to AFTER the response so a slow or
    // row-locked inventory_items write can never stall (or appear to "hang")
    // the item save. The work is best-effort + audited on the persistent
    // server; any failure is logged, never surfaced to the edit.
    res.json(item);
    // Session 33 (Tier 2 #8) — item-level Pass propagates to inventory; toggling
    // to Pass inserts, and Session 57 re-syncs an edited weight/lot into the
    // existing row (propagate is insert-only and skips when a row exists).
    if (acceptedForInventory(item)) {
      void (async () => {
        try {
          const created = await propagateSingleItemToInventory(inspectionId, item);
          if (!created) {
            const resync = await resyncInventoryForItem(before, item);
            if (resync) {
              const actor = await getOrProvisionCurrentUser(req).catch(() => null);
              await db.insert(auditLogTable).values({
                tableName: "inventory_items",
                rowId: resync.invId,
                operation: "RESYNC_FROM_INSPECTION_EDIT",
                changedBy: actor?.id ?? null,
                changedByName: actor?.fullName ?? null,
                beforeState: { quantity: resync.beforeQty, sourceInspectionItemId: item.id },
                afterState: { quantity: resync.afterQty, sourceInspectionItemId: item.id },
              }).catch(() => { /* audit must never break the flow */ });
            }
          }
        } catch (e) { req.log.error({ err: e, inspectionId, itemId: item.id }, "Deferred inventory propagation/re-sync failed"); }
      })();
    } else if (acceptedForInventory(before)) {
      // Session 59 — the line was accepted and no longer is. Take back the
      // inventory row and lot the earlier acceptance created. The drawn-down
      // case was already refused above, so anything reaching here is untouched
      // stock and safe to remove.
      void (async () => {
        try {
          const withdrawn = await withdrawItemFromInventory(item.id);
          if (!withdrawn) return;
          const actor = await getOrProvisionCurrentUser(req).catch(() => null);
          await db.insert(auditLogTable).values({
            tableName: "inventory_items",
            rowId: withdrawn.invId,
            operation: "WITHDRAWN_ON_INSPECTION_REJECT",
            changedBy: actor?.id ?? null,
            changedByName: actor?.fullName ?? null,
            beforeState: { itemName: withdrawn.itemName, quantity: withdrawn.quantity, sourceInspectionItemId: item.id },
            afterState: { removed: true, result: item.result, disposition: item.disposition ?? null },
          }).catch(() => { /* audit must never break the flow */ });
        } catch (e) { req.log.error({ err: e, inspectionId, itemId: item.id }, "Deferred inventory withdrawal failed"); }
      })();
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update inspection item");
    res.status(500).json({ error: "Failed to update inspection item" });
  }
});

router.delete("/incoming-inspections/:inspectionId/items/:itemId", async (req, res) => {
  try {
    const inspectionId = parseInt(req.params.inspectionId);
    const itemId = parseInt(req.params.itemId);
    // Session 52.2.1 — a cancelled inspection is read-only.
    // Session 55 — a Closed inspection is also read-only (21 CFR Part 11). The
    // client `locked = isClosed || isCancelled` already disables this delete
    // button; this adds the matching finalized-parent server guard so a line
    // item can't be deleted from a finalized inspection via the API.
    {
      const [parent] = await db.select({ cancelledAt: incomingInspectionsTable.cancelledAt, result: incomingInspectionsTable.result }).from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, inspectionId));
      if (parent?.cancelledAt) { res.status(409).json({ error: "This inspection is cancelled and read-only. Re-open it first (Admin)." }); return; }
      if (parent?.result === "Closed") { res.status(409).json({ error: "Cannot delete an item from a Closed inspection (21 CFR Part 11)." }); return; }
    }
    // Session 59 — deleting a line item is Manager / Quality / Admin only.
    // Checked before anything else so an unauthorised caller is refused whatever
    // state the record is in.
    {
      const actor = await getOrProvisionCurrentUser(req);
      if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
      if (!ITEM_DELETE_ROLES.has(actor.role)) {
        res.status(403).json({ error: `Deleting a line item requires Manager, Quality, or Admin. Your role is "${actor.role}".` });
        return;
      }
    }
    // Session 59 — deleting the LINE has to take its inventory back out too,
    // for the same reason failing it does. Passing a line creates an inventory
    // row and lot; deleting the line used to leave both behind, and with the
    // line gone nothing pointed at them any more — stock in inventory with no
    // receiving record explaining where it came from.
    const [before] = await db.select().from(incomingInspectionItemsTable)
      .where(and(
        eq(incomingInspectionItemsTable.id, itemId),
        eq(incomingInspectionItemsTable.inspectionId, inspectionId),
      ));
    if (!before) { res.status(404).json({ error: "Inspection item not found" }); return; }
    if (acceptedForInventory(before)) {
      const drawn = await drawnDownLotForItem(before.id);
      if (drawn) {
        res.status(409).json({
          error: `Can't delete "${before.itemName}" — ${drawn.consumed} ${before.quantityUom ?? ""}`.replace(/\s+/g, " ").trim()
            + ` has already been drawn from lot ${drawn.lotNumber ?? "(no lot number)"} into production.`
            + " Deleting the line would leave that batch pointing at a receipt that no longer exists."
            + " Raise a Non-Conformance against the affected batch instead.",
        });
        return;
      }
    }

    const result = await db.delete(incomingInspectionItemsTable)
      .where(and(
        eq(incomingInspectionItemsTable.id, itemId),
        eq(incomingInspectionItemsTable.inspectionId, inspectionId),
      )).returning({ id: incomingInspectionItemsTable.id });
    if (result.length === 0) { res.status(404).json({ error: "Inspection item not found" }); return; }

    // Untouched stock at this point — the drawn-down case was refused above.
    if (acceptedForInventory(before)) {
      try {
        const withdrawn = await withdrawItemFromInventory(before.id);
        if (withdrawn) {
          const actor = await getOrProvisionCurrentUser(req).catch(() => null);
          await db.insert(auditLogTable).values({
            tableName: "inventory_items",
            rowId: withdrawn.invId,
            operation: "WITHDRAWN_ON_INSPECTION_ITEM_DELETE",
            changedBy: actor?.id ?? null,
            changedByName: actor?.fullName ?? null,
            beforeState: { itemName: withdrawn.itemName, quantity: withdrawn.quantity, sourceInspectionItemId: before.id },
            afterState: { removed: true, reason: "inspection line item deleted" },
          }).catch(() => { /* audit must never break the flow */ });
        }
      } catch (e) {
        req.log.error({ err: e, inspectionId, itemId }, "Inventory withdrawal after line-item delete failed");
      }
    }
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Failed to delete inspection item");
    res.status(500).json({ error: "Failed to delete inspection item" });
  }
});

// Manual re-sync: re-run inventory propagation for an existing Pass inspection.
// Repairs records where items were stranded (e.g. INS-0004) because they were
// added/edited outside the original inspection-level Pass transition.
router.post("/incoming-inspections/:id/resync-inventory", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [parent] = await db.select().from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, id));
    if (!parent) { res.status(404).json({ error: "Inspection not found" }); return; }
    if (parent.result !== "Pass") {
      res.status(409).json({ error: `Cannot re-sync inventory for an inspection in state "${parent.result}". Mark it Pass first.` });
      return;
    }
    const added = await propagateAcceptedItemsToInventory(id);
    res.json({ inspectionId: id, addedToInventory: added });
  } catch (err) {
    req.log.error({ err }, "Failed to resync inventory");
    res.status(500).json({ error: "Failed to resync inventory" });
  }
});

// ── Session 52.1 — soft Cancel / Re-open (Part 11) ───────────────────────────
//
// QMS records are never hard-deleted. Cancel retains the row, is recoverable
// (/uncancel, Admin-only), and requires a Manager/Quality/Admin actor + a
// rationale + a Part 11 e-signature (initials matching the signed-in user +
// meaning). Cancel is permitted ONLY while the inspection is in-process; a
// Closed inspection cannot be cancelled (409 — Re-open it first, or open a new
// inspection). Mirrors the non_conformances.ts reference implementation. Audit
// rows are written directly via db.insert(auditLogTable) (no writeAuditLog
// helper in this route), matching the existing TRANSITION audit writes above.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.post("/incoming-inspections/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!CANCEL_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Cancelling a record requires Manager, Quality, or Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, id));
    if (!before) { res.status(404).json({ error: "Inspection not found" }); return; }
    if ((before as { cancelledAt?: Date | null }).cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }
    if (before.result === "Closed") {
      res.status(409).json({ error: "A Closed inspection cannot be cancelled. Re-open it first (Admin), or open a new inspection." }); return;
    }

    const [inspection] = await db.update(incomingInspectionsTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(incomingInspectionsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "incoming_inspections",
        rowId: id,
        operation: "CANCEL",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: before as never,
        afterState: inspection as never,
      });
    } catch (e) {
      req.log.error({ err: e, inspectionId: id }, "Audit log write failed (cancel kept)");
    }
    res.json(inspection);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel inspection");
    res.status(500).json({ error: "Failed to cancel inspection" });
  }
});

// POST /incoming-inspections/:id/uncancel — reverse a Cancel. Admin-ONLY
// (Session 52 decision — narrower than Cancel). Part 11 signature required.
// Clears the cancel fields and returns the inspection to active use.
router.post("/incoming-inspections/:id/uncancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (actor.role !== "Admin") {
      res.status(403).json({ error: `Re-opening a record is restricted to Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(incomingInspectionsTable).where(eq(incomingInspectionsTable.id, id));
    if (!before) { res.status(404).json({ error: "Inspection not found" }); return; }
    if (!(before as { cancelledAt?: Date | null }).cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [inspection] = await db.update(incomingInspectionsTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(incomingInspectionsTable.id, id)).returning();
    try {
      await db.insert(auditLogTable).values({
        tableName: "incoming_inspections",
        rowId: id,
        operation: "UNCANCEL",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: before as never,
        afterState: inspection as never,
      });
    } catch (e) {
      req.log.error({ err: e, inspectionId: id }, "Audit log write failed (uncancel kept)");
    }
    res.json(inspection);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel inspection");
    res.status(500).json({ error: "Failed to uncancel inspection" });
  }
});

export default router;
