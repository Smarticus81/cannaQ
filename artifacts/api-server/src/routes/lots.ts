import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  lotsTable,
  lotEventsTable,
  batchOutputsTable,
  batchIngredientsTable,
  batchRecordsTable,
  shipmentsTable,
  usersTable,
  auditLogTable,
  inventoryItemsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { getAuth } from "@clerk/express";

const router = Router();

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
const MANAGER_ROLES = new Set(["Manager", "Quality", "Admin"]);

type Actor = { id: number; fullName: string; role: string };

async function getActor(req: Request, res: Response): Promise<Actor | null> {
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentication required for this action." });
    return null;
  }
  const [user] = await db
    .select({ id: usersTable.id, fullName: usersTable.fullName, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user) {
    res.status(403).json({ error: "Your account is not linked to a CannaQMS user. Visit /users/me to provision." });
    return null;
  }
  return user;
}

async function logAudit(rowId: number, op: string, actor: Actor, before: unknown, after: unknown) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "lots",
      rowId,
      operation: op,
      changedBy: actor.id,
      changedByName: actor.fullName,
      beforeState: before as never,
      afterState: after as never,
    });
  } catch { /* never break primary flow */ }
}

// Session 55.1 — next lot number from MAX of the parsed sequence of existing
// lot_number values for this prefix+year, NOT count(*). count(*) both
// string-concatenated (node-postgres returns it as a string, 1 -> "11") and
// collided once the data held an out-of-order high number or after a delete.
// MAX+1 is year-scoped per prefix, monotonic, never reuses a number. The
// unique constraint on lot_number is the backstop.
async function generateLotNumber(prefix: string): Promise<string> {
  const yr = new Date().getFullYear().toString().slice(-2);
  const fullPrefix = `${prefix}-${yr}-`;
  const rows = await db
    .select({ lotNumber: lotsTable.lotNumber })
    .from(lotsTable)
    .where(like(lotsTable.lotNumber, `${fullPrefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = (r.lotNumber ?? "").match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${fullPrefix}${String(maxSeq + 1).padStart(5, "0")}`;
}

// ---------- LIST / CREATE / GET ----------

router.get("/lots", async (req, res) => {
  try {
    const { status, origin } = req.query;
    let rows = await db.select().from(lotsTable).orderBy(desc(lotsTable.createdAt));
    if (status) rows = rows.filter((r) => r.status === status);
    if (origin) rows = rows.filter((r) => r.origin === origin);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list lots");
    res.status(500).json({ error: "Failed to list lots" });
  }
});

router.post("/lots", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const body = req.body ?? {};
    const origin: string = body.origin ?? "received";
    if (!["received", "produced", "split", "merged", "manual"].includes(origin)) {
      res.status(400).json({ error: "Invalid origin." });
      return;
    }
    const originalQuantity = Number(body.originalQuantity);
    if (!Number.isFinite(originalQuantity) || originalQuantity <= 0) {
      res.status(400).json({ error: "originalQuantity must be a positive number." });
      return;
    }
    const prefix = origin === "produced" ? "LOT-P" : origin === "received" ? "LOT-R" : "LOT";
    const lotNumber: string = body.lotNumber || (await generateLotNumber(prefix));

    const [lot] = await db.insert(lotsTable).values({
      lotNumber,
      itemName: body.itemName,
      itemType: body.itemType,
      unitOfMeasure: body.unitOfMeasure,
      originalQuantity,
      currentQuantity: originalQuantity,
      origin,
      status: "Active",
      supplierId: body.supplierId ?? null,
      inventoryItemId: body.inventoryItemId ?? null,
      sourceInspectionId: body.sourceInspectionId ?? null,
      sourceBatchId: body.sourceBatchId ?? null,
      parentLotId: body.parentLotId ?? null,
      metrcPackageId: body.metrcPackageId ?? null,
      expirationDate: body.expirationDate ?? null,
      notes: body.notes ?? null,
      createdBy: actor.id,
      createdByName: actor.fullName,
    }).returning();

    await db.insert(lotEventsTable).values({
      lotId: lot.id,
      eventType: "create",
      quantityDelta: originalQuantity,
      resultingQuantity: originalQuantity,
      reason: `Lot created (${origin})`,
      performedBy: actor.id,
      performedByName: actor.fullName,
    });

    // If this lot is a "produced" output of a batch, also link it via batch_outputs
    if (origin === "produced" && body.sourceBatchId) {
      await db.insert(batchOutputsTable).values({
        batchId: body.sourceBatchId,
        lotId: lot.id,
        quantity: originalQuantity,
        unitOfMeasure: body.unitOfMeasure,
        notes: body.notes ?? null,
      });
    }

    await logAudit(lot.id, "create", actor, null, lot);
    res.status(201).json(lot);
  } catch (err) {
    req.log.error({ err }, "Failed to create lot");
    res.status(500).json({ error: "Failed to create lot" });
  }
});

router.get("/lots/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
    if (!lot) { res.status(404).json({ error: "Lot not found" }); return; }
    res.json(lot);
  } catch (err) {
    req.log.error({ err }, "Failed to get lot");
    res.status(500).json({ error: "Failed to get lot" });
  }
});

// POST /lots/:id/assign-lot-number — give an already-received lot that only has
// the synthetic "RCV-<id>" placeholder a real internal lot number (e.g. for
// FIFO). Anyone can set a lot # at RECEIVING; backfilling one here is limited to
// Manager / Quality / Admin.
router.post("/lots/:id/assign-lot-number", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!MANAGER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Assigning a lot number to a received lot requires Manager, Quality, or Admin role." });
      return;
    }
    const id = Number(req.params.id);
    const newLot = typeof req.body?.lotNumber === "string" ? req.body.lotNumber.trim() : "";
    if (!newLot) { res.status(400).json({ error: "A lot number is required." }); return; }

    const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
    if (!lot) { res.status(404).json({ error: "Lot not found" }); return; }
    if ((lot.lotNumber ?? "").trim()) {
      res.status(409).json({ error: "This lot already has a lot number; you can only assign one to a received lot that doesn't have one yet." });
      return;
    }
    const [dupe] = await db.select({ id: lotsTable.id }).from(lotsTable).where(eq(lotsTable.lotNumber, newLot));
    if (dupe && dupe.id !== id) { res.status(409).json({ error: `Lot number "${newLot}" is already in use.` }); return; }

    const before = { ...lot };
    const [updated] = await db.update(lotsTable).set({ lotNumber: newLot }).where(eq(lotsTable.id, id)).returning();
    // Keep the linked inventory item's lot number in sync so Inventory matches.
    if (lot.inventoryItemId) {
      await db.update(inventoryItemsTable).set({ lotNumber: newLot }).where(eq(inventoryItemsTable.id, lot.inventoryItemId));
    }
    await logAudit(id, "ASSIGN_LOT_NUMBER", actor, before, updated);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to assign lot number");
    res.status(500).json({ error: "Failed to assign lot number." });
  }
});

router.get("/lots/:id/events", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const events = await db.select().from(lotEventsTable)
      .where(eq(lotEventsTable.lotId, id))
      .orderBy(desc(lotEventsTable.createdAt));
    res.json(events);
  } catch (err) {
    req.log.error({ err }, "Failed to load lot events");
    res.status(500).json({ error: "Failed to load lot events" });
  }
});

// ---------- LINEAGE ----------
//
// Backward: walk upward through "what was this made from".
//   lot.sourceBatchId -> batchIngredients(batchId) -> their lot_ids -> recurse
//   lot.parentLotId -> recurse
// Forward: walk downward through "where did this end up".
//   batchIngredients(lot_id = L) -> batch -> batchOutputs(batch_id) -> output lots -> recurse
//   childLots (parentLotId = L) from splits -> recurse
//   Shipments(lot_id = L)

const MAX_DEPTH = 8;

async function loadLot(id: number) {
  const [l] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
  return l ?? null;
}

async function backwardLineage(rootId: number) {
  const visited = new Set<number>();
  type Node = { lot: typeof lotsTable.$inferSelect; viaBatchId?: number | null; parents: Node[] };
  async function walk(id: number, depth: number): Promise<Node | null> {
    if (visited.has(id) || depth > MAX_DEPTH) return null;
    visited.add(id);
    const lot = await loadLot(id);
    if (!lot) return null;
    const node: Node = { lot, parents: [], viaBatchId: lot.sourceBatchId ?? null };
    // From batch ingredients
    if (lot.sourceBatchId) {
      const ings = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.batchId, lot.sourceBatchId));
      for (const ing of ings) {
        if (ing.lotId) {
          const parent = await walk(ing.lotId, depth + 1);
          if (parent) node.parents.push(parent);
        }
      }
    }
    // From split parent
    if (lot.parentLotId) {
      const p = await walk(lot.parentLotId, depth + 1);
      if (p) node.parents.push(p);
    }
    return node;
  }
  return walk(rootId, 0);
}

async function forwardLineage(rootId: number) {
  const visited = new Set<number>();
  type ShipNode = { type: "shipment"; data: typeof shipmentsTable.$inferSelect };
  type LotNode = {
    type: "lot";
    lot: typeof lotsTable.$inferSelect;
    viaBatch?: { id: number; batchNumber: string; productName: string } | null;
    children: Array<LotNode | ShipNode>;
  };
  async function walk(id: number, depth: number): Promise<LotNode | null> {
    if (visited.has(id) || depth > MAX_DEPTH) return null;
    visited.add(id);
    const lot = await loadLot(id);
    if (!lot) return null;
    const node: LotNode = { type: "lot", lot, children: [] };

    // Batches that consumed this lot
    const ings = await db.select().from(batchIngredientsTable).where(eq(batchIngredientsTable.lotId, id));
    const batchIds = Array.from(new Set(ings.map((i) => i.batchId)));
    if (batchIds.length) {
      const batches = await db.select().from(batchRecordsTable).where(inArray(batchRecordsTable.id, batchIds));
      for (const b of batches) {
        const outs = await db.select().from(batchOutputsTable).where(eq(batchOutputsTable.batchId, b.id));
        for (const o of outs) {
          const child = await walk(o.lotId, depth + 1);
          if (child) {
            child.viaBatch = { id: b.id, batchNumber: b.batchNumber, productName: b.productName };
            node.children.push(child);
          }
        }
      }
    }

    // Child lots created via split
    const childLots = await db.select().from(lotsTable).where(eq(lotsTable.parentLotId, id));
    for (const c of childLots) {
      const child = await walk(c.id, depth + 1);
      if (child) node.children.push(child);
    }

    // Shipments
    const ships = await db.select().from(shipmentsTable).where(eq(shipmentsTable.lotId, id));
    for (const s of ships) node.children.push({ type: "shipment", data: s });

    return node;
  }
  return walk(rootId, 0);
}

router.get("/lots/:id/lineage/backward", async (req, res) => {
  try {
    const tree = await backwardLineage(Number(req.params.id));
    if (!tree) { res.status(404).json({ error: "Lot not found" }); return; }
    res.json(tree);
  } catch (err) {
    req.log.error({ err }, "Failed backward lineage");
    res.status(500).json({ error: "Failed to compute lineage" });
  }
});

router.get("/lots/:id/lineage/forward", async (req, res) => {
  try {
    const tree = await forwardLineage(Number(req.params.id));
    if (!tree) { res.status(404).json({ error: "Lot not found" }); return; }
    res.json(tree);
  } catch (err) {
    req.log.error({ err }, "Failed forward lineage");
    res.status(500).json({ error: "Failed to compute lineage" });
  }
});

// ---------- SPLIT (Manager+ e-sig required) ----------

router.post("/lots/:id/split", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!MANAGER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Lot splits require Manager, Quality, or Admin role." });
      return;
    }
    const id = Number(req.params.id);
    const { parts, initials, meaning } = req.body ?? {};
    if (!initials || !meaning) { res.status(400).json({ error: "initials and meaning are required." }); return; }
    if (!Array.isArray(parts) || parts.length < 2) {
      res.status(400).json({ error: "Provide at least two parts." });
      return;
    }
    const totalSplit = parts.reduce((sum: number, p: { quantity: number }) => sum + Number(p.quantity || 0), 0);

    const [parent] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
    if (!parent) { res.status(404).json({ error: "Lot not found" }); return; }
    if (parent.status !== "Active") {
      res.status(409).json({ error: `Cannot split a lot in status ${parent.status}.` });
      return;
    }
    if (totalSplit > parent.currentQuantity + 1e-9) {
      res.status(400).json({ error: `Split total (${totalSplit}) exceeds available quantity (${parent.currentQuantity}).` });
      return;
    }

    const signedAt = new Date();
    const before = { ...parent };

    // Session 76.1 — precompute the split-child lot-number sequence ONCE, before
    // the transaction. generateLotNumber() reads the COMMITTED db, so calling it
    // per child inside the txn handed every auto-numbered child the SAME number
    // (each prior child is still uncommitted/invisible) → duplicate lot_number
    // unique violation → the whole split 500'd ("Failed to split lot"). Assign
    // sequential numbers from a single base instead; the unique index still
    // backstops any cross-request race.
    const splitYr = new Date().getFullYear().toString().slice(-2);
    const splitPrefix = `LOT-S-${splitYr}-`;
    const existingSplits = await db
      .select({ lotNumber: lotsTable.lotNumber })
      .from(lotsTable)
      .where(like(lotsTable.lotNumber, `${splitPrefix}%`));
    let splitBaseSeq = 0;
    for (const r of existingSplits) {
      const m = (r.lotNumber ?? "").match(/-(\d+)$/);
      if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > splitBaseSeq) splitBaseSeq = n; }
    }
    let splitAutoIdx = 0;

    const result = await db.transaction(async (tx) => {
      // Atomic decrement: only proceed if parent qty hasn't changed since we read it
      const newParentQty = parent.currentQuantity - totalSplit;
      const newParentStatus = newParentQty <= 1e-9 ? "Consumed" : parent.status;
      const [updatedParent] = await tx.update(lotsTable)
        .set({ currentQuantity: newParentQty, status: newParentStatus, updatedAt: new Date() })
        .where(and(eq(lotsTable.id, parent.id), eq(lotsTable.currentQuantity, parent.currentQuantity)))
        .returning();
      if (!updatedParent) throw new Error("CONFLICT");

      const newLots: typeof lotsTable.$inferSelect[] = [];
      for (const part of parts) {
        const qty = Number(part.quantity);
        const lotNumber = part.lotNumber || `${splitPrefix}${String(splitBaseSeq + (++splitAutoIdx)).padStart(4, "0")}`;
        const [child] = await tx.insert(lotsTable).values({
          lotNumber,
          itemName: parent.itemName,
          itemType: parent.itemType,
          unitOfMeasure: parent.unitOfMeasure,
          originalQuantity: qty,
          currentQuantity: qty,
          origin: "split",
          status: "Active",
          supplierId: parent.supplierId,
          inventoryItemId: parent.inventoryItemId,
          sourceInspectionId: parent.sourceInspectionId,
          sourceBatchId: parent.sourceBatchId,
          parentLotId: parent.id,
          metrcPackageId: part.metrcPackageId ?? null,
          expirationDate: parent.expirationDate,
          notes: part.notes ?? null,
          createdBy: actor.id,
          createdByName: actor.fullName,
        }).returning();
        newLots.push(child);
        await tx.insert(lotEventsTable).values({
          lotId: child.id,
          eventType: "split-created",
          quantityDelta: qty,
          resultingQuantity: qty,
          relatedLotId: parent.id,
          reason: `Created via split from ${parent.lotNumber}`,
          performedBy: actor.id,
          performedByName: actor.fullName,
          signedInitials: initials,
          signedMeaning: meaning,
          signedAt,
        });
      }
      await tx.insert(lotEventsTable).values({
        lotId: parent.id,
        eventType: "split-out",
        quantityDelta: -totalSplit,
        resultingQuantity: newParentQty,
        reason: `Split into ${parts.length} child lots`,
        performedBy: actor.id,
        performedByName: actor.fullName,
        signedInitials: initials,
        signedMeaning: meaning,
        signedAt,
      });
      return { parent: updatedParent, children: newLots };
    }).catch((e) => {
      if ((e as Error).message === "CONFLICT") return null;
      throw e;
    });
    if (!result) {
      res.status(409).json({ error: "Parent lot was modified by another user — please retry." });
      return;
    }
    await logAudit(parent.id, "split", actor, before, result);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to split lot");
    res.status(500).json({ error: "Failed to split lot" });
  }
});

// ---------- MERGE (Manager+ e-sig required) ----------

router.post("/lots/merge", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!MANAGER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Lot merges require Manager, Quality, or Admin role." });
      return;
    }
    const { sourceLotIds, newLotNumber, initials, meaning, notes } = req.body ?? {};
    if (!initials || !meaning) { res.status(400).json({ error: "initials and meaning are required." }); return; }
    if (!Array.isArray(sourceLotIds) || sourceLotIds.length < 2) {
      res.status(400).json({ error: "Provide at least two source lot ids." });
      return;
    }
    const sources = await db.select().from(lotsTable).where(inArray(lotsTable.id, sourceLotIds));
    if (sources.length !== sourceLotIds.length) { res.status(404).json({ error: "Some source lots not found." }); return; }
    const itemNames = new Set(sources.map((s) => s.itemName));
    if (itemNames.size > 1) { res.status(400).json({ error: "Can only merge lots with the same item name." }); return; }
    const uoms = new Set(sources.map((s) => s.unitOfMeasure));
    if (uoms.size > 1) { res.status(400).json({ error: "Can only merge lots with the same unit of measure." }); return; }
    if (sources.some((s) => s.status !== "Active")) {
      res.status(409).json({ error: "All source lots must be Active." });
      return;
    }
    const totalQty = sources.reduce((s, l) => s + l.currentQuantity, 0);
    const lotNumber = newLotNumber || (await generateLotNumber("LOT-M"));
    const signedAt = new Date();
    const sample = sources[0]!;

    const merged = await db.transaction(async (tx) => {
      // Atomic check-and-consume each source — fails if any source quantity changed
      for (const s of sources) {
        const [updated] = await tx.update(lotsTable)
          .set({ currentQuantity: 0, status: "Consumed", updatedAt: new Date() })
          .where(and(
            eq(lotsTable.id, s.id),
            eq(lotsTable.currentQuantity, s.currentQuantity),
            eq(lotsTable.status, s.status),
          ))
          .returning();
        if (!updated) throw new Error("CONFLICT");
      }
      const [m] = await tx.insert(lotsTable).values({
        lotNumber,
        itemName: sample.itemName,
        itemType: sample.itemType,
        unitOfMeasure: sample.unitOfMeasure,
        originalQuantity: totalQty,
        currentQuantity: totalQty,
        origin: "merged",
        status: "Active",
        supplierId: sample.supplierId,
        inventoryItemId: sample.inventoryItemId,
        notes: notes ?? `Merged from ${sources.map((s) => s.lotNumber).join(", ")}`,
        createdBy: actor.id,
        createdByName: actor.fullName,
      }).returning();
      for (const s of sources) {
        await tx.insert(lotEventsTable).values({
          lotId: s.id,
          eventType: "merged-into",
          quantityDelta: -s.currentQuantity,
          resultingQuantity: 0,
          relatedLotId: m.id,
          reason: `Merged into ${m.lotNumber}`,
          performedBy: actor.id,
          performedByName: actor.fullName,
          signedInitials: initials,
          signedMeaning: meaning,
          signedAt,
        });
      }
      await tx.insert(lotEventsTable).values({
        lotId: m.id,
        eventType: "merge-created",
        quantityDelta: totalQty,
        resultingQuantity: totalQty,
        reason: `Merged from ${sources.length} source lots`,
        performedBy: actor.id,
        performedByName: actor.fullName,
        signedInitials: initials,
        signedMeaning: meaning,
        signedAt,
      });
      return m;
    }).catch((e) => {
      if ((e as Error).message === "CONFLICT") return null;
      throw e;
    });
    if (!merged) {
      res.status(409).json({ error: "One or more source lots were modified concurrently — please retry." });
      return;
    }
    await logAudit(merged.id, "merge", actor, { sources }, merged);
    res.status(201).json(merged);
  } catch (err) {
    req.log.error({ err }, "Failed to merge lots");
    res.status(500).json({ error: "Failed to merge lots" });
  }
});

// ---------- SHIPMENT ----------

router.post("/lots/:id/ship", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Recording a shipment requires Supervisor or above." });
      return;
    }
    const id = Number(req.params.id);
    const { customerName, customerLicense, shippedQuantity, manifestNumber, shippedDate, notes } = req.body ?? {};
    if (!customerName || !shippedQuantity || !shippedDate) {
      res.status(400).json({ error: "customerName, shippedQuantity, and shippedDate are required." });
      return;
    }
    const qty = Number(shippedQuantity);
    const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
    if (!lot) { res.status(404).json({ error: "Lot not found" }); return; }
    if (lot.status !== "Active") { res.status(409).json({ error: `Cannot ship a lot in status ${lot.status}.` }); return; }
    if (qty > lot.currentQuantity + 1e-9) {
      res.status(400).json({ error: `Ship quantity ${qty} exceeds available ${lot.currentQuantity}.` });
      return;
    }
    const newQty = lot.currentQuantity - qty;
    const newStatus = newQty <= 1e-9 ? "Consumed" : lot.status;
    const txResult = await db.transaction(async (tx) => {
      const [updatedLot] = await tx.update(lotsTable)
        .set({ currentQuantity: newQty, status: newStatus, updatedAt: new Date() })
        .where(and(eq(lotsTable.id, id), eq(lotsTable.currentQuantity, lot.currentQuantity)))
        .returning();
      if (!updatedLot) throw new Error("CONFLICT");
      const [ship] = await tx.insert(shipmentsTable).values({
        lotId: id,
        customerName,
        customerLicense: customerLicense ?? null,
        shippedQuantity: qty,
        unitOfMeasure: lot.unitOfMeasure,
        manifestNumber: manifestNumber ?? null,
        shippedDate,
        shippedBy: actor.id,
        shippedByName: actor.fullName,
        notes: notes ?? null,
      }).returning();
      await tx.insert(lotEventsTable).values({
        lotId: id,
        eventType: "ship",
        quantityDelta: -qty,
        resultingQuantity: newQty,
        reason: `Shipped to ${customerName}${manifestNumber ? ` on manifest ${manifestNumber}` : ""}`,
        performedBy: actor.id,
        performedByName: actor.fullName,
      });
      return { lot: updatedLot, ship };
    }).catch((e) => {
      if ((e as Error).message === "CONFLICT") return null;
      throw e;
    });
    if (!txResult) {
      res.status(409).json({ error: "Lot quantity changed concurrently — please retry." });
      return;
    }
    await logAudit(id, "ship", actor, lot, txResult);
    res.status(201).json(txResult);
  } catch (err) {
    req.log.error({ err }, "Failed to record shipment");
    res.status(500).json({ error: "Failed to record shipment" });
  }
});

// ---------- PROMOTE TO INGREDIENT (Supervisor+ e-sig required) ----------
//
// Follow-up #2 (post-Session 79) — release an in-house intermediate (cannabutter,
// distillate, etc.) for downstream use as an ingredient. A produced lot is
// finished-goods by default and excluded from the raw-material Inventory rollup
// + ingredient lot-picker (listInventoryView filters origin = 'produced'). Once
// it passes test, a Supervisor+ signs this disposition, flipping
// available_as_ingredient = true so the lot appears on Inventory and in the
// ingredient lot dropdown exactly like a received raw material. Human-disposed
// + Part 11-signed, consistent with the rest of the QMS (we don't auto-promote
// on test pass). The signed lot_event is the durable release record; the flag
// is recoverable (status filters still drop the lot once it's consumed/recalled).
router.post("/lots/:id/promote-ingredient", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Releasing a produced lot as an ingredient requires Supervisor or above." });
      return;
    }
    const id = Number(req.params.id);
    const { initials, meaning } = req.body ?? {};
    if (!initials || !meaning) {
      res.status(400).json({ error: "initials and meaning are required." });
      return;
    }
    const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, id));
    if (!lot) { res.status(404).json({ error: "Lot not found" }); return; }
    if (lot.origin !== "produced") {
      res.status(409).json({ error: "Only produced (in-house) lots can be released as ingredient inventory." });
      return;
    }
    if (lot.status !== "Active") {
      res.status(409).json({ error: `Cannot release a lot in status ${lot.status} as an ingredient.` });
      return;
    }
    if (lot.availableAsIngredient) {
      res.status(409).json({ error: "This lot is already available as an ingredient." });
      return;
    }
    const signedAt = new Date();
    const before = { ...lot };
    const [updated] = await db.update(lotsTable)
      .set({ availableAsIngredient: true, updatedAt: new Date() })
      .where(eq(lotsTable.id, id))
      .returning();
    await db.insert(lotEventsTable).values({
      lotId: id,
      eventType: "promote-ingredient",
      quantityDelta: 0,
      resultingQuantity: lot.currentQuantity,
      reason: `Released as ingredient: ${meaning}`,
      performedBy: actor.id,
      performedByName: actor.fullName,
      signedInitials: initials,
      signedMeaning: meaning,
      signedAt,
    });
    await logAudit(id, "promote-ingredient", actor, before, updated);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to promote lot to ingredient");
    res.status(500).json({ error: "Failed to release lot as ingredient" });
  }
});

// ---------- RECALL (Manager+ e-sig required) ----------

router.post("/lots/:id/recall", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!MANAGER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Recall requires Manager, Quality, or Admin role." });
      return;
    }
    const id = Number(req.params.id);
    const { reason, initials, meaning } = req.body ?? {};
    if (!reason || !initials || !meaning) {
      res.status(400).json({ error: "reason, initials, and meaning are required." });
      return;
    }
    const tree = await forwardLineage(id);
    if (!tree) { res.status(404).json({ error: "Lot not found" }); return; }

    const lotIds = new Set<number>();
    function collect(node: typeof tree) {
      if (!node) return;
      if (node.type === "lot") {
        lotIds.add(node.lot.id);
        for (const c of node.children) {
          if (c.type === "lot") collect(c);
        }
      }
    }
    collect(tree);

    const signedAt = new Date();
    const ids = Array.from(lotIds);
    const result = await db.transaction(async (tx) => {
      const before = await tx.select().from(lotsTable).where(inArray(lotsTable.id, ids));
      const updated = await tx.update(lotsTable)
        .set({ status: "Recalled", updatedAt: new Date() })
        .where(inArray(lotsTable.id, ids))
        .returning();
      for (const lid of ids) {
        const cur = before.find((b) => b.id === lid);
        await tx.insert(lotEventsTable).values({
          lotId: lid,
          eventType: "recall",
          quantityDelta: 0,
          resultingQuantity: cur?.currentQuantity ?? 0,
          reason: `Recall: ${reason}`,
          performedBy: actor.id,
          performedByName: actor.fullName,
          signedInitials: initials,
          signedMeaning: meaning,
          signedAt,
        });
      }
      // Mark downstream shipments as Recalled too
      const shipUpdate = await tx.update(shipmentsTable)
        .set({ status: "Recalled" })
        .where(inArray(shipmentsTable.lotId, ids))
        .returning();
      return { before, updated, shipments: shipUpdate };
    });
    await logAudit(id, "recall", actor, { affectedLotIds: ids, reason, before: result.before }, { affectedLotIds: ids, lots: result.updated, shipments: result.shipments });
    res.json({ recalledLotIds: ids, count: ids.length, recalledShipments: result.shipments.length });
  } catch (err) {
    req.log.error({ err }, "Failed to recall lot");
    res.status(500).json({ error: "Failed to recall lot" });
  }
});

router.get("/lots/:id/recall-report", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tree = await forwardLineage(id);
    if (!tree) { res.status(404).json({ error: "Lot not found" }); return; }
    const lots: typeof lotsTable.$inferSelect[] = [];
    const shipments: typeof shipmentsTable.$inferSelect[] = [];
    function collect(node: typeof tree) {
      if (!node) return;
      if (node.type === "lot") {
        lots.push(node.lot);
        for (const c of node.children) {
          if (c.type === "lot") collect(c);
          else if (c.type === "shipment") shipments.push(c.data);
        }
      }
    }
    collect(tree);
    const customers = Array.from(new Set(shipments.map((s) => s.customerName)));
    res.json({ rootLotId: id, totalDownstreamLots: lots.length, totalShipments: shipments.length, customers, lots, shipments });
  } catch (err) {
    req.log.error({ err }, "Failed recall report");
    res.status(500).json({ error: "Failed recall report" });
  }
});

export default router;
