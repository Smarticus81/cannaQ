import { Router } from "express";
import { db } from "@workspace/db";
import { inventoryItemsTable, lotsTable, lotEventsTable, batchIngredientsTable, auditLogTable } from "@workspace/db";
import { and, eq, or, inArray, sql } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { listInventoryView } from "../lib/inventoryView";
import { getTrackingProviderForFacility } from "../lib/trackingProvider";

const router = Router();

// Session 79 (Step 2) — Inventory now reads the shared lot ledger via
// listInventoryView() (Active, non-produced lots) instead of inventory_items
// directly, so the Inventory screen and Lot Traceability agree by construction.
// inventory_items remains the raw-material catalog (name/type/UoM/reorder/
// supplier) each lot links to; quantities are read live off the lots.
router.get("/inventory", async (req, res) => {
  try {
    const items = await listInventoryView();
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory");
    res.status(500).json({ error: "Failed to list inventory" });
  }
});

router.post("/inventory", async (req, res) => {
  try {
    // Manual inventory creation is restricted to Admins. The canonical path is
    // Incoming Inspection → Pass, which auto-adds items with chain-of-custody
    // metadata (sourceInspectionItemId). Admin-only here mirrors the UI gate.
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") {
      res.status(403).json({ error: "Manual inventory items can only be created by Admins. Use the Incoming Inspection flow." });
      return;
    }
    // Session 79 (Step 2) — the Inventory screen reads the shared lot ledger, so
    // a manual catalog row needs a matching on-hand lot to be visible. Create
    // both atomically: the inventory_items catalog row (reorder/supplier) AND a
    // linked Active lot carrying the quantity. is_cannabis is inferred from the
    // item type (the manual form has no Material Type field).
    const body = req.body ?? {};
    const qty = Number(body.quantity ?? 0);
    const itemType: string = body.itemType ?? "Other";
    const isCannabis = typeof itemType === "string" && itemType.toLowerCase().startsWith("cannabis");
    const item = await db.transaction(async (tx) => {
      const [inv] = await tx.insert(inventoryItemsTable).values(body).returning();
      const lotNumber = (body.lotNumber && String(body.lotNumber).trim()) ? String(body.lotNumber).trim() : `MAN-${inv.id}`;
      const [lot] = await tx.insert(lotsTable).values({
        lotNumber,
        itemName: inv.itemName,
        itemType: inv.itemType,
        unitOfMeasure: inv.unitOfMeasure,
        originalQuantity: qty,
        currentQuantity: qty,
        origin: "manual",
        status: "Active",
        isCannabis,
        supplierId: inv.supplierId ?? null,
        inventoryItemId: inv.id,
        notes: inv.notes ?? null,
        createdBy: actor.id,
        createdByName: actor.fullName,
      }).returning();
      await tx.insert(lotEventsTable).values({
        lotId: lot.id,
        eventType: "create",
        quantityDelta: qty,
        resultingQuantity: qty,
        reason: "Lot created (manual inventory add)",
        performedBy: actor.id,
        performedByName: actor.fullName,
      });
      return inv;
    });
    res.status(201).json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to create inventory item");
    res.status(500).json({ error: "Failed to create inventory item" });
  }
});

// Session 106 (2026-07-14) — one-click demo inventory seed. Drops a few
// raw-material cannabis lots straight onto the Inventory screen so a batch has
// input stock to consume. Mirrors the POST /inventory transaction exactly
// (inventory_items catalog row + linked Active lot + create lot-event), and is
// idempotent (skips a lot whose lot_number already exists), so it is safe to
// re-hit. Admin-only. MUST be registered before "/inventory/:id" so the ":id"
// route does not capture "seed-demo".
router.get("/inventory/seed-demo", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") {
      res.status(403).json({ error: "Admin only." });
      return;
    }
    // Session 108 (2026-07-16) — itemName MUST match the BOM ingredient line so
    // the batch ingredient lot-picker (which pairs a line to a lot by canonical
    // name, or by itemType being contained in the line name) actually surfaces
    // these lots. The Infused Pre-Roll recipe lines are "Cannabis Distillate" and
    // "THCa Diamonds / Kief"; the old seed names ("Distillate"/"Kief") matched
    // neither by name nor by type, so distillate + kief never appeared and the
    // batch couldn't advance to Testing. Shake/Trim already matched "Cannabis
    // Flower (ground)" via its "Cannabis Flower" type. Lot numbers bumped to -02
    // so a re-seed creates the corrected lots even when the old -01 lots exist
    // (the loop below skips a lot_number that already exists). Distillate unit is
    // grams to match the recipe line (was mL).
    const seeds = [
      { lotNumber: "SEED-DIST-02", itemName: "Cannabis Distillate", itemType: "Cannabis Concentrate", unitOfMeasure: "g", quantity: 1000 },
      { lotNumber: "SEED-KIEF-02", itemName: "THCa Diamonds / Kief", itemType: "Cannabis Concentrate", unitOfMeasure: "g", quantity: 10000 },
      { lotNumber: "SEED-SHAKE-01", itemName: "Shake/Trim", itemType: "Cannabis Flower", unitOfMeasure: "g", quantity: 25000 },
    ];
    const seeded: Array<{ item: string; status: string; lotId: number | null }> = [];
    for (const s of seeds) {
      const [existing] = await db.select().from(lotsTable).where(and(eq(lotsTable.itemName, s.itemName), eq(lotsTable.status, "Active")));
      if (existing) {
        seeded.push({ item: s.itemName, status: "already exists (skipped)", lotId: existing.id });
        continue;
      }
      const lot = await db.transaction(async (tx) => {
        const [inv] = await tx.insert(inventoryItemsTable).values({
          itemName: s.itemName,
          itemType: s.itemType,
          unitOfMeasure: s.unitOfMeasure,
          quantity: s.quantity,
        }).returning();
        const [newLot] = await tx.insert(lotsTable).values({
          lotNumber: s.lotNumber,
          itemName: s.itemName,
          itemType: s.itemType,
          unitOfMeasure: s.unitOfMeasure,
          originalQuantity: s.quantity,
          currentQuantity: s.quantity,
          origin: "received",
          status: "Active",
          isCannabis: true,
          availableAsIngredient: true,
          inventoryItemId: inv.id,
          createdBy: actor.id,
          createdByName: actor.fullName,
        }).returning();
        await tx.insert(lotEventsTable).values({
          lotId: newLot.id,
          eventType: "create",
          quantityDelta: s.quantity,
          resultingQuantity: s.quantity,
          reason: "Lot created (demo inventory seed)",
          performedBy: actor.id,
          performedByName: actor.fullName,
        });
        return newLot;
      });
      seeded.push({ item: s.itemName, status: "created", lotId: lot.id });
    }
    res.json({ ok: true, seeded });
  } catch (err) {
    req.log.error({ err }, "Failed to seed demo inventory");
    res.status(500).json({ error: "Failed to seed demo inventory", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Session 106 (2026-07-14) — assign real Metrc tag numbers to existing lots.
// Sets a lot's lot_number AND metrc_package_id to the given Metrc tag, so the
// lot both DISPLAYS as the Metrc number and is genuinely LINKED to it. Refuses
// (skips) a value already used by a different lot — lot_number is unique.
// Admin-only. Defaults to the three demo seed lots; override with
//   ?map=lotId:TAG,lotId:TAG   e.g. ?map=10:AAA05030000213A000001104,11:...
// MUST be registered before "/inventory/:id" so ":id" does not capture it.
router.get("/inventory/set-lot-numbers", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") {
      res.status(403).json({ error: "Admin only." });
      return;
    }
    const defaultMap = "10:AAA05030000213A000001104,11:AAA05030000213A000001105,12:AAA05030000213A000001106";
    const raw = typeof req.query.map === "string" && req.query.map.length > 0 ? req.query.map : defaultMap;
    const pairs = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf(":");
        return { lotId: Number(p.slice(0, idx)), value: p.slice(idx + 1).trim() };
      });
    const updated: Array<{ lotId: number; value: string; status: string; previous?: string }> = [];
    for (const { lotId, value } of pairs) {
      if (!Number.isInteger(lotId) || !value) {
        updated.push({ lotId, value, status: "bad pair (skipped)" });
        continue;
      }
      const [lot] = await db.select().from(lotsTable).where(eq(lotsTable.id, lotId));
      if (!lot) {
        updated.push({ lotId, value, status: "lot not found (skipped)" });
        continue;
      }
      const [clash] = await db.select().from(lotsTable).where(eq(lotsTable.lotNumber, value));
      if (clash && clash.id !== lotId) {
        updated.push({ lotId, value, status: `already used by lot ${clash.id} (skipped)` });
        continue;
      }
      const previous = lot.lotNumber ?? undefined;
      await db.update(lotsTable)
        .set({ lotNumber: value, metrcPackageId: value, updatedAt: new Date() })
        .where(eq(lotsTable.id, lotId));
      updated.push({ lotId, value, status: "updated", previous });
    }
    res.json({ ok: true, updated });
  } catch (err) {
    req.log.error({ err }, "Failed to set lot numbers");
    res.status(500).json({ error: "Failed to set lot numbers", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Session 108 (2026-07-16) — ONE-TIME reconciliation for the demo-seed mixup.
// The earlier fix created NEW lots ("Cannabis Distillate", "THCa Diamonds /
// Kief", "Shake/Trim") with placeholder SEED-* numbers, DUPLICATING the
// operator's real lots that already hold assigned Metrc tag numbers under the
// old item names ("Distillate", "Kief"). Some batch lines were recorded against
// the SEED lots, so they can't simply be deleted. Per material this route:
//   1. RE-POINTS any batch ingredient line that used the SEED lot onto the REAL
//      (Metrc-numbered) lot — so the batch shows the real tag, lineage intact.
//   2. RENAMES the real lot (and its catalog row) to the recipe-matching name.
//   3. DELETES the now-unreferenced SEED lot (+ its orphan catalog row).
// Data-driven (matches by lot number / item name, not hard-coded ids) and
// idempotent. Admin-only. MUST be registered before "/inventory/:id".
router.get("/inventory/fix-demo-lots", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") {
      res.status(403).json({ error: "Admin only." });
      return;
    }
    const plan = [
      { seedLotNumber: "SEED-DIST-02",  realOldName: "Distillate", correctName: "Cannabis Distillate" },
      { seedLotNumber: "SEED-KIEF-02",  realOldName: "Kief",       correctName: "THCa Diamonds / Kief" },
      { seedLotNumber: "SEED-SHAKE-01", realOldName: "Shake/Trim", correctName: "Shake/Trim" },
    ];

    const actions = await db.transaction(async (tx) => {
      const log: Array<Record<string, unknown>> = [];
      for (const p of plan) {
        const [seedLot] = await tx.select().from(lotsTable).where(eq(lotsTable.lotNumber, p.seedLotNumber));
        if (!seedLot) { log.push({ material: p.correctName, status: "no SEED lot (already clean)" }); continue; }

        // real lot = same base material but NOT the seed lot (shake shares its name)
        const candidates = await tx.select().from(lotsTable).where(eq(lotsTable.itemName, p.realOldName));
        const realLot = candidates.find((l) => l.id !== seedLot.id && l.lotNumber !== p.seedLotNumber);
        if (!realLot) { log.push({ material: p.correctName, status: "no real Metrc lot found — SEED lot kept" }); continue; }

        // 1) re-point batch lines from the SEED lot -> the real lot (lot_id AND
        //    inventory_item_id AND the denormalized lot_number the batch displays)
        const conds = [eq(batchIngredientsTable.lotId, seedLot.id)];
        if (seedLot.inventoryItemId != null) conds.push(eq(batchIngredientsTable.inventoryItemId, seedLot.inventoryItemId));
        const repointed = await tx.update(batchIngredientsTable)
          .set({ inventoryItemId: realLot.inventoryItemId, lotId: realLot.id, lotNumber: realLot.lotNumber })
          .where(or(...conds))
          .returning({ id: batchIngredientsTable.id });

        // 2) rename the real lot + its catalog row to the recipe-matching name
        if (realLot.itemName !== p.correctName) {
          await tx.update(lotsTable).set({ itemName: p.correctName, updatedAt: new Date() }).where(eq(lotsTable.id, realLot.id));
          if (realLot.inventoryItemId != null) {
            await tx.update(inventoryItemsTable).set({ itemName: p.correctName, updatedAt: new Date() }).where(eq(inventoryItemsTable.id, realLot.inventoryItemId));
          }
        }

        // 3) delete the SEED lot (lot_events cascade) + its now-orphan catalog row
        const seedInvId = seedLot.inventoryItemId;
        await tx.delete(lotsTable).where(eq(lotsTable.id, seedLot.id));
        if (seedInvId != null) {
          const usedByLot = await tx.select({ id: lotsTable.id }).from(lotsTable).where(eq(lotsTable.inventoryItemId, seedInvId));
          const usedByBom = await tx.select({ id: batchIngredientsTable.id }).from(batchIngredientsTable).where(eq(batchIngredientsTable.inventoryItemId, seedInvId));
          if (usedByLot.length === 0 && usedByBom.length === 0) {
            await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, seedInvId));
          }
        }

        log.push({
          material: p.correctName,
          realLotKept: realLot.lotNumber,
          renamedFrom: realLot.itemName === p.correctName ? "(already named)" : p.realOldName,
          batchLinesRepointed: repointed.length,
          seedLotDeleted: p.seedLotNumber,
        });
      }
      return log;
    });

    res.json({ ok: true, actions });
  } catch (err) {
    req.log.error({ err }, "Failed to fix demo lots");
    res.status(500).json({ error: "Failed to fix demo lots", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Session 110 (2026-07-18) — SYNC active Metrc packages INTO the lot ledger.
// Metrc is the source of truth for cannabis on-hand; this reads the facility's
// active packages and upserts one Lot per package (matched by Metrc tag), so the
// cannabis packages show up in Inventory and become pickable as batch ingredients
// (the ingredient dialog already filters lots by item name). Idempotent — re-run
// to refresh quantities. Admin-only. MUST be registered before "/inventory/:id"
// so ":id" does not capture "sync-metrc".
router.post("/inventory/sync-metrc", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") {
      res.status(403).json({ error: "Admin only." });
      return;
    }
    const licenseNumber = typeof req.body?.licenseNumber === "string" && req.body.licenseNumber.trim()
      ? req.body.licenseNumber.trim()
      : undefined;
    // Read through the tracking provider (the "conduit") like every other
    // on-hand read, so this is provider-selected (Metrc today, BioTrack later).
    const provider = await getTrackingProviderForFacility();
    const result = await provider.getActivePackages(licenseNumber);
    if (!result.ok) {
      res.status(502).json({ ok: false, error: `Metrc read failed (HTTP ${result.status}): ${result.error}`, metrcStatus: result.status });
      return;
    }
    const data = result.data as { Data?: unknown[] } | undefined;
    const packages: Record<string, unknown>[] = Array.isArray(data?.Data)
      ? (data!.Data as Record<string, unknown>[])
      : [];

    const rdStr = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
    const rdNum = (o: Record<string, unknown>, k: string): number | undefined => (typeof o[k] === "number" ? (o[k] as number) : undefined);

    let created = 0, updated = 0, unchanged = 0;
    const errors: Array<{ tag: string; error: string }> = [];

    for (const p of packages) {
      const label = rdStr(p, "Label");
      if (!label) continue;
      // Metrc v2 packages carry the item under a nested `Item` object; fall back
      // to flat fields defensively across sandbox/state shape differences.
      const itemObj = (p["Item"] && typeof p["Item"] === "object") ? (p["Item"] as Record<string, unknown>) : {};
      const itemName = rdStr(itemObj, "Name") ?? rdStr(p, "ProductName") ?? rdStr(p, "ItemName") ?? "(unnamed Metrc item)";
      const itemType = rdStr(itemObj, "ProductCategoryName") ?? rdStr(p, "ProductCategoryName") ?? "Cannabis";
      const uom = rdStr(p, "UnitOfMeasureName") ?? rdStr(p, "UnitOfMeasureAbbreviation") ?? rdStr(itemObj, "UnitOfMeasureName") ?? "";
      const qty = rdNum(p, "Quantity") ?? 0;
      try {
        // Match an existing lot by its Metrc link OR by the tag already sitting in
        // lot_number (older lots linked via /inventory/set-lot-numbers), so a
        // re-sync updates in place and never trips the unique lot_number constraint.
        const [existing] = await db.select().from(lotsTable)
          .where(or(eq(lotsTable.metrcPackageId, label), eq(lotsTable.lotNumber, label)));
        if (existing) {
          const changed = existing.currentQuantity !== qty
            || existing.unitOfMeasure !== uom
            || existing.itemName !== itemName
            || existing.metrcPackageId !== label;
          if (changed) {
            await db.transaction(async (tx) => {
              await tx.update(lotsTable).set({
                currentQuantity: qty,
                unitOfMeasure: uom,
                itemName,
                metrcPackageId: label,
                isCannabis: true,
                updatedAt: new Date(),
              }).where(eq(lotsTable.id, existing.id));
              if (existing.currentQuantity !== qty) {
                await tx.insert(lotEventsTable).values({
                  lotId: existing.id,
                  eventType: "metrc_sync",
                  quantityDelta: qty - existing.currentQuantity,
                  resultingQuantity: qty,
                  reason: "On-hand synced from Metrc",
                  performedBy: actor.id,
                  performedByName: actor.fullName,
                });
              }
            });
            updated++;
          } else {
            unchanged++;
          }
        } else {
          await db.transaction(async (tx) => {
            const [lot] = await tx.insert(lotsTable).values({
              lotNumber: label,
              itemName,
              itemType,
              unitOfMeasure: uom,
              originalQuantity: qty,
              currentQuantity: qty,
              origin: "received",
              status: "Active",
              isCannabis: true,
              availableAsIngredient: true,
              metrcPackageId: label,
              notes: "Imported from Metrc",
              createdBy: actor.id,
              createdByName: actor.fullName,
            }).returning();
            await tx.insert(lotEventsTable).values({
              lotId: lot.id,
              eventType: "create",
              quantityDelta: qty,
              resultingQuantity: qty,
              reason: "Lot created (imported from Metrc)",
              performedBy: actor.id,
              performedByName: actor.fullName,
            });
          });
          created++;
        }
      } catch (e) {
        errors.push({ tag: label, error: e instanceof Error ? e.message : String(e) });
      }
    }

    res.json({ ok: true, created, updated, unchanged, total: packages.length, errors });
  } catch (err) {
    req.log.error({ err }, "Failed to sync Metrc packages to lots");
    res.status(500).json({ error: "Failed to sync Metrc packages to lots", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Showcase prep: archive demo / non-Metrc CANNABIS lots ─────────────────────
// So a prospective client sees only real, Metrc-backed cannabis inventory. A
// cannabis lot is "real" iff its tag is in the CURRENT live Metrc active-package
// pull; anything else (seeded demo lots with made-up tags, or leftovers from a
// prior sandbox day) is archived. NON-cannabis lots (packaging, labels, food) are
// NEVER touched — they legitimately carry internal lot numbers with no Metrc
// package. Soft-archive only (status → "Archived"): reversible, no FK/cascade
// risk; hides them from Inventory + Lot Traceability. DRY-RUN by default; pass
// ?confirm=true to execute. ?includeAmbiguous=true also archives cannabis-UNKNOWN
// lots (isCannabis null). Registered BEFORE "/inventory/:id" so the param route
// doesn't shadow it. Admin only.
router.get("/inventory/prune-demo-lots", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") { res.status(403).json({ error: "Admin only." }); return; }
    const confirm = String(req.query["confirm"] ?? "") === "true";
    const includeAmbiguous = String(req.query["includeAmbiguous"] ?? "") === "true";

    // Live Metrc active packages = the source of truth for "real" cannabis lots.
    const provider = await getTrackingProviderForFacility();
    const result = await provider.getActivePackages(
      typeof req.query["licenseNumber"] === "string" ? (req.query["licenseNumber"] as string) : undefined,
    );
    if (!result.ok) {
      res.status(502).json({ ok: false, error: `Metrc read failed (HTTP ${result.status}): ${result.error}` });
      return;
    }
    const data = result.data as { Data?: Array<Record<string, unknown>> } | undefined;
    const livePkgs = Array.isArray(data?.Data) ? data!.Data! : [];
    const liveTags = new Set<string>();
    for (const p of livePkgs) { const l = p["Label"]; if (typeof l === "string") liveTags.add(l); }

    // GUARD: never prune against an empty Metrc (e.g. sandbox wiped, not yet
    // reseeded) — that would archive every cannabis lot. Reseed + Sync first.
    if (liveTags.size === 0) {
      res.status(409).json({ ok: false, error: "Metrc returned 0 active packages — refusing to prune (would archive everything). Reseed the sandbox and Sync from Metrc first, then re-run." });
      return;
    }

    const isReal = (l: typeof lotsTable.$inferSelect): boolean =>
      liveTags.has(l.lotNumber ?? "") || !!(l.metrcPackageId && liveTags.has(l.metrcPackageId));
    const summarize = (l: typeof lotsTable.$inferSelect) => ({
      id: l.id, lotNumber: l.lotNumber, itemName: l.itemName, itemType: l.itemType,
      quantity: l.currentQuantity, unitOfMeasure: l.unitOfMeasure, status: l.status,
      isCannabis: l.isCannabis, metrcPackageId: l.metrcPackageId,
    });

    const allLots = (await db.select().from(lotsTable)).filter((l) => l.status !== "Archived");
    const notReal = allLots.filter((l) => !isReal(l));
    const cannabisTargets = notReal.filter((l) => l.isCannabis === true);
    const ambiguous = notReal.filter((l) => l.isCannabis == null); // cannabis-UNKNOWN
    const nonCannabisKept = notReal.filter((l) => l.isCannabis === false);
    const realKept = allLots.filter(isReal);
    const toArchive = includeAmbiguous ? [...cannabisTargets, ...ambiguous] : cannabisTargets;

    if (!confirm) {
      res.json({
        ok: true,
        mode: "DRY-RUN (no changes made)",
        note: "Review 'wouldArchive'. Re-run with ?confirm=true to archive. Add &includeAmbiguous=true to also archive cannabis-UNKNOWN lots.",
        liveMetrcTags: liveTags.size,
        wouldArchiveCount: toArchive.length,
        wouldArchive: toArchive.map(summarize),
        ambiguousNotArchived: includeAmbiguous ? [] : ambiguous.map(summarize),
        keepRealMetrc: realKept.map(summarize),
        keepNonCannabis: nonCannabisKept.map(summarize),
      });
      return;
    }

    // Execute — soft-archive (reversible, no cascade risk).
    let archived = 0;
    for (const l of toArchive) {
      await db.transaction(async (tx) => {
        await tx.update(lotsTable).set({ status: "Archived", updatedAt: new Date() }).where(eq(lotsTable.id, l.id));
        await tx.insert(lotEventsTable).values({
          lotId: l.id, eventType: "archive", quantityDelta: 0, resultingQuantity: l.currentQuantity,
          reason: "Archived — demo / non-Metrc cannabis lot removed for client showcase",
          performedBy: actor.id, performedByName: actor.fullName,
        });
      });
      archived++;
    }
    res.json({ ok: true, mode: "EXECUTED", archived, keptRealMetrc: realKept.length, keptNonCannabis: nonCannabisKept.length });
  } catch (err) {
    req.log.error({ err }, "prune-demo-lots failed");
    res.status(500).json({ error: "prune-demo-lots failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Session 80 — one-shot admin maintenance for the demo/showcase dataset.
// Two independent jobs, both idempotent, both Admin-gated:
//   (a) markNonCannabisByType: backfill is_cannabis=false on lots that are
//       non-cannabis by item type but were created without the flag set
//       (is_cannabis == null). This is what makes the food/packaging/label
//       lots stop showing up as "cannabis-UNKNOWN / ambiguous".
//   (b) setLowStock: force specific lots' current_quantity down to a small
//       number so the next batch over-draws them — exercises the insufficient-
//       stock alert in the Add Ingredient dialog and the quantity pass-through.
// Registered BEFORE "/inventory/:id" so the literal path isn't shadowed.
// Item types that are UNAMBIGUOUSLY non-cannabis. Real Metrc cannabis lots
// carry types like "Cannabis", "Buds", "Concentrate", "Infused", "Shake/Trim",
// none of which appear here — so flipping is_cannabis=false for these types is
// safe regardless of the lot's current flag. Kept deliberately narrow.
const NON_CANNABIS_ITEM_TYPES = new Set([
  "Food Ingredient",
  "Production Material",
  "Packaging Material",
  "Label",
]);
router.post("/inventory/lots-admin-adjust", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor || actor.role !== "Admin") { res.status(403).json({ error: "Admin only." }); return; }
    const body = (req.body ?? {}) as {
      markNonCannabisByType?: boolean;
      setLowStock?: Array<{ lotNumber?: string; currentQuantity?: number }>;
      dryRun?: boolean;
    };
    const dryRun = body.dryRun === true;

    const allLots = await db.select().from(lotsTable);
    const byLotNumber = new Map<string, typeof lotsTable.$inferSelect>();
    for (const l of allLots) { if (l.lotNumber) byLotNumber.set(l.lotNumber, l); }

    // (a) Flag non-cannabis lots that were created without is_cannabis set.
    const flagged: Array<{ lotNumber: string | null; itemName: string; itemType: string | null }> = [];
    if (body.markNonCannabisByType) {
      // Target by item type, flipping anything not already false. These types are
      // never cannabis, so this correctly fixes both is_cannabis==null (never set)
      // and is_cannabis==true (default applied on insert) demo lots.
      const targets = allLots.filter(
        (l) => l.isCannabis !== false && l.itemType != null && NON_CANNABIS_ITEM_TYPES.has(l.itemType),
      );
      for (const l of targets) {
        if (!dryRun) {
          await db.update(lotsTable).set({ isCannabis: false, updatedAt: new Date() }).where(eq(lotsTable.id, l.id));
        }
        flagged.push({ lotNumber: l.lotNumber, itemName: l.itemName, itemType: l.itemType });
      }
    }

    // (b) Force selected lots to a low quantity (with an audit lot_event).
    const adjusted: Array<{ lotNumber: string; from: number; to: number; unit: string | null }> = [];
    const notFound: string[] = [];
    for (const req0 of body.setLowStock ?? []) {
      const ln = (req0.lotNumber ?? "").trim();
      const to = Number(req0.currentQuantity);
      if (!ln || !Number.isFinite(to)) continue;
      const lot = byLotNumber.get(ln);
      if (!lot) { notFound.push(ln); continue; }
      const from = Number(lot.currentQuantity ?? 0);
      if (!dryRun) {
        await db.transaction(async (tx) => {
          await tx.update(lotsTable).set({ currentQuantity: to, updatedAt: new Date() }).where(eq(lotsTable.id, lot.id));
          await tx.insert(lotEventsTable).values({
            lotId: lot.id, eventType: "adjustment", quantityDelta: to - from, resultingQuantity: to,
            reason: "Admin low-stock adjustment (demo — exercise insufficient-stock alert)",
            performedBy: actor.id, performedByName: actor.fullName,
          });
        });
      }
      adjusted.push({ lotNumber: ln, from, to, unit: lot.unitOfMeasure });
    }

    res.json({
      ok: true,
      mode: dryRun ? "DRY-RUN (no changes made)" : "EXECUTED",
      flaggedNonCannabisCount: flagged.length,
      flaggedNonCannabis: flagged,
      adjustedCount: adjusted.length,
      adjusted,
      notFound,
    });
  } catch (err) {
    req.log.error({ err }, "lots-admin-adjust failed");
    res.status(500).json({ error: "lots-admin-adjust failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Rename / Merge inventory items (Manager/Quality/Admin) ────────────────────
//
// Inventory rolls up on-hand by (item_name, item_type, unit_of_measure), so two
// spellings ("Mouthpiece" vs "Muthpieces") split the count and can false-trigger
// a reorder alert. These consolidate them:
//   - rename: fix a typo on one item group (all its lots + catalog row).
//   - merge : fold a source group INTO a target group (same unit), summing stock.
// Both rewrite the LOTS (what the rollup groups on), repoint batch_ingredients,
// fold/delete the source inventory_items catalog rows, and audit-log the change.
const ITEM_ADMIN_ROLES = new Set(["Manager", "Quality", "Admin"]);
const normStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

router.post("/inventory/rename", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!ITEM_ADMIN_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const b = req.body ?? {};
    const itemName = normStr(b.itemName), itemType = normStr(b.itemType), unitOfMeasure = normStr(b.unitOfMeasure);
    const newName = normStr(b.newName);
    if (!itemName || !itemType || !unitOfMeasure) { res.status(400).json({ error: "Missing source item name/type/unit." }); return; }
    if (!newName) { res.status(400).json({ error: "New name is required." }); return; }
    if (newName === itemName) { res.status(400).json({ error: "New name is the same as the current name." }); return; }

    const result = await db.transaction(async (tx) => {
      const lots = await tx.update(lotsTable).set({ itemName: newName, updatedAt: new Date() })
        .where(and(eq(lotsTable.itemName, itemName), eq(lotsTable.itemType, itemType), eq(lotsTable.unitOfMeasure, unitOfMeasure)))
        .returning({ id: lotsTable.id });
      const items = await tx.update(inventoryItemsTable).set({ itemName: newName, updatedAt: new Date() })
        .where(and(eq(inventoryItemsTable.itemName, itemName), eq(inventoryItemsTable.itemType, itemType), eq(inventoryItemsTable.unitOfMeasure, unitOfMeasure)))
        .returning({ id: inventoryItemsTable.id });
      await tx.insert(auditLogTable).values({
        tableName: "inventory_items", rowId: items[0]?.id ?? 0, operation: "RENAME_ITEM",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: { itemName } as never,
        afterState: { itemName: newName, lotsUpdated: lots.length, itemsUpdated: items.length } as never,
      });
      return { lotsUpdated: lots.length, itemsUpdated: items.length };
    });
    res.json({ ok: true, newName, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to rename inventory item");
    res.status(500).json({ error: "Failed to rename inventory item", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Session 63 — change an item group's TYPE.
//
// Until now the type was write-once: set at creation and editable nowhere. The
// ⋯ menu offered Rename and Merge only, and Reorder Points showed the type
// read-only. That left ten items stranded — nine reading "Received Material",
// which is not a type anyone chose but the fallback the receiving route writes
// when a line was saved without one, plus the growing media reading the legacy
// "Cultivation Input".
//
// Mirrors the rename route exactly: the inventory rollup groups by
// (item_name + item_type + unit_of_measure), so BOTH the lots and the
// inventory_items rows in that group have to move together or the group splits
// in half and the on-hand count with it.
router.post("/inventory/change-type", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!ITEM_ADMIN_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const b = req.body ?? {};
    const itemName = normStr(b.itemName), itemType = normStr(b.itemType), unitOfMeasure = normStr(b.unitOfMeasure);
    const newType = normStr(b.newType);
    if (!itemName || !itemType || !unitOfMeasure) { res.status(400).json({ error: "Missing source item name/type/unit." }); return; }
    if (!newType) { res.status(400).json({ error: "New type is required." }); return; }
    // Session 63.1 — a same-type request is NOT rejected. The catalog row and its
    // lots can disagree (the lot carries the type the clerk chose at receiving,
    // the catalog row the "Received Material" fallback), so "change it to the type
    // it already shows" is a legitimate reconcile — it is the only way to fix a
    // catalog row whose lots are already correct, which is the state all four TEST
    // items are in. If nothing actually changes, the 409 below says so.

    // Refuse when a group already exists under the target type: that is a MERGE
    // (two on-hand totals becoming one), and merge has its own rules — unit
    // compatibility, lot repointing, batch_ingredients. Silently colliding here
    // would produce two rows the UI renders as one and quantities nobody can
    // reconcile.
    const [collision] = await db.select({ id: inventoryItemsTable.id })
      .from(inventoryItemsTable)
      .where(and(
        eq(inventoryItemsTable.itemName, itemName),
        eq(inventoryItemsTable.itemType, newType),
        eq(inventoryItemsTable.unitOfMeasure, unitOfMeasure),
      )).limit(1);
    if (collision) {
      res.status(409).json({
        error: `"${itemName}" already exists as ${newType} in ${unitOfMeasure}. Combining the two is a merge, not a type change — use Merge into… instead so the on-hand quantities are handled properly.`,
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const lots = await tx.update(lotsTable).set({ itemType: newType, updatedAt: new Date() })
        .where(and(eq(lotsTable.itemName, itemName), eq(lotsTable.itemType, itemType), eq(lotsTable.unitOfMeasure, unitOfMeasure)))
        .returning({ id: lotsTable.id });

      // The catalog row and its lots can hold DIFFERENT types. They are written by
      // different paths at different times — receiving stamps the lot with the
      // Material Type the clerk chose, while the catalog row it auto-creates falls
      // back to "Received Material" when none was recorded — and nothing ever
      // reconciled them. Spatulas was the proof: lot "Ingredient / Other", catalog
      // row "Received Material". Matching the catalog on the source type alone
      // therefore retyped the lot and silently left the catalog row behind, which
      // is what the Reorder Points panel reads.
      //
      // So the catalog match also accepts "Received Material" for the same name and
      // unit. That string is safe to special-case because it is not a type anyone
      // can pick — it is literally what gets written when nobody recorded one. A
      // row holding a real type (Packaging Material, Component…) is a deliberate
      // answer and is left alone, which matters for names that legitimately exist
      // under two types, like the 510-Thread cartridge.
      const items = await tx.update(inventoryItemsTable).set({ itemType: newType, updatedAt: new Date() })
        .where(and(
          eq(inventoryItemsTable.itemName, itemName),
          eq(inventoryItemsTable.unitOfMeasure, unitOfMeasure),
          or(
            eq(inventoryItemsTable.itemType, itemType),
            eq(inventoryItemsTable.itemType, "Received Material"),
          ),
        ))
        .returning({ id: inventoryItemsTable.id });

      await tx.insert(auditLogTable).values({
        tableName: "inventory_items", rowId: items[0]?.id ?? 0, operation: "CHANGE_ITEM_TYPE",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: { itemName, itemType } as never,
        afterState: { itemName, itemType: newType, lotsUpdated: lots.length, itemsUpdated: items.length } as never,
      });
      return { lotsUpdated: lots.length, itemsUpdated: items.length };
    });
    if (result.lotsUpdated === 0 && result.itemsUpdated === 0) {
      res.status(409).json({ error: `Nothing to change — "${itemName}" is already ${newType} everywhere.` });
      return;
    }
    res.json({ ok: true, newType, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to change inventory item type");
    res.status(500).json({ error: "Failed to change item type", detail: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/inventory/merge", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!ITEM_ADMIN_ROLES.has(actor.role)) { res.status(403).json({ error: "Manager, Quality, or Admin role required." }); return; }
    const b = req.body ?? {};
    const fromName = normStr(b.fromName), fromType = normStr(b.fromType), fromUnit = normStr(b.fromUnit);
    const intoName = normStr(b.intoName), intoType = normStr(b.intoType), intoUnit = normStr(b.intoUnit);
    if (!fromName || !intoName) { res.status(400).json({ error: "Both source and target items are required." }); return; }
    if (fromUnit !== intoUnit) { res.status(400).json({ error: `Cannot merge across units (${fromUnit} vs ${intoUnit}). Units must match to combine quantities.` }); return; }
    if (fromName === intoName && fromType === intoType) { res.status(400).json({ error: "Source and target are the same item." }); return; }

    const result = await db.transaction(async (tx) => {
      const targetItems = await tx.select().from(inventoryItemsTable)
        .where(and(eq(inventoryItemsTable.itemName, intoName), eq(inventoryItemsTable.itemType, intoType), eq(inventoryItemsTable.unitOfMeasure, intoUnit)));
      const targetItemId: number | null = targetItems.length
        ? (targetItems.find((t) => t.reorderPoint != null)?.id ?? targetItems[0].id) : null;

      const sourceItems = await tx.select({ id: inventoryItemsTable.id }).from(inventoryItemsTable)
        .where(and(eq(inventoryItemsTable.itemName, fromName), eq(inventoryItemsTable.itemType, fromType), eq(inventoryItemsTable.unitOfMeasure, fromUnit)));
      const sourceItemIds = sourceItems.map((s) => s.id);

      // 1) Move the source's lots onto the target group; point at the target
      //    catalog row when there is one.
      const lotSet: Record<string, unknown> = { itemName: intoName, itemType: intoType, unitOfMeasure: intoUnit, updatedAt: new Date() };
      if (targetItemId != null) lotSet.inventoryItemId = targetItemId;
      const movedLots = await tx.update(lotsTable).set(lotSet as never)
        .where(and(eq(lotsTable.itemName, fromName), eq(lotsTable.itemType, fromType), eq(lotsTable.unitOfMeasure, fromUnit)))
        .returning({ id: lotsTable.id });

      let bomRepointed = 0, removedItems = 0;
      let keptAsTarget: number | null = null;

      if (targetItemId != null) {
        // Repoint every reference off the source catalog rows, then delete them.
        if (sourceItemIds.length) {
          const r = await tx.update(batchIngredientsTable).set({ inventoryItemId: targetItemId })
            .where(inArray(batchIngredientsTable.inventoryItemId, sourceItemIds)).returning({ id: batchIngredientsTable.id });
          bomRepointed = r.length;
          await tx.update(lotsTable).set({ inventoryItemId: targetItemId, updatedAt: new Date() })
            .where(inArray(lotsTable.inventoryItemId, sourceItemIds));
          const del = await tx.delete(inventoryItemsTable).where(inArray(inventoryItemsTable.id, sourceItemIds)).returning({ id: inventoryItemsTable.id });
          removedItems = del.length;
        }
      } else if (sourceItemIds.length) {
        // No target catalog row: keep one source row, rename it to the target so
        // any reorder config survives; delete the extras; point lots at it.
        keptAsTarget = sourceItemIds[0];
        await tx.update(inventoryItemsTable).set({ itemName: intoName, itemType: intoType, updatedAt: new Date() })
          .where(eq(inventoryItemsTable.id, keptAsTarget));
        const extras = sourceItemIds.slice(1);
        if (extras.length) {
          const del = await tx.delete(inventoryItemsTable).where(inArray(inventoryItemsTable.id, extras)).returning({ id: inventoryItemsTable.id });
          removedItems = del.length;
        }
        await tx.update(lotsTable).set({ inventoryItemId: keptAsTarget, updatedAt: new Date() })
          .where(and(eq(lotsTable.itemName, intoName), eq(lotsTable.itemType, intoType), eq(lotsTable.unitOfMeasure, intoUnit)));
      }

      await tx.insert(auditLogTable).values({
        tableName: "inventory_items", rowId: targetItemId ?? keptAsTarget ?? 0, operation: "MERGE_ITEM",
        changedBy: actor.id, changedByName: actor.fullName,
        beforeState: { itemName: fromName, itemType: fromType, unitOfMeasure: fromUnit } as never,
        afterState: { itemName: intoName, itemType: intoType, movedLots: movedLots.length, bomRepointed, removedItems } as never,
      });
      return { movedLots: movedLots.length, bomRepointed, removedItems };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to merge inventory items");
    res.status(500).json({ error: "Failed to merge inventory items", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Reorder-point manager feed — every catalog item (including no-lot starter
// items that never appear in the lot-based Inventory view) with its reorder
// thresholds and current total on-hand (summed across its Active lots).
// Registered BEFORE /inventory/:id so "catalog" is not parsed as an :id.
router.get("/inventory/catalog", async (req, res) => {
  try {
    const items = await db.select().from(inventoryItemsTable);
    const sums = await db
      .select({ iid: lotsTable.inventoryItemId, total: sql<number>`coalesce(sum(${lotsTable.currentQuantity}), 0)` })
      .from(lotsTable)
      .where(eq(lotsTable.status, "Active"))
      .groupBy(lotsTable.inventoryItemId);
    const onHandById = new Map<number, number>();
    for (const s of sums) if (s.iid != null) onHandById.set(s.iid, Number(s.total));
    res.json(
      items
        .map((it) => ({
          id: it.id,
          itemName: it.itemName,
          itemType: it.itemType,
          unitOfMeasure: it.unitOfMeasure,
          reorderPoint: it.reorderPoint,
          reorderQuantity: it.reorderQuantity,
          onHand: onHandById.get(it.id) ?? 0,
        }))
        .sort((a, b) => a.itemName.localeCompare(b.itemName)),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory catalog");
    res.status(500).json({ error: "Failed to list inventory catalog" });
  }
});

router.get("/inventory/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [item] = await db.select().from(inventoryItemsTable).where(eq(inventoryItemsTable.id, id));
    if (!item) { res.status(404).json({ error: "Item not found" }); return; }
    res.json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to get inventory item");
    res.status(500).json({ error: "Failed to get inventory item" });
  }
});

router.patch("/inventory/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [item] = await db.update(inventoryItemsTable).set({ ...req.body, updatedAt: new Date() }).where(eq(inventoryItemsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Item not found" }); return; }
    res.json(item);
  } catch (err) {
    req.log.error({ err }, "Failed to update inventory item");
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

export default router;
