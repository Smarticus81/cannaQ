import { Router } from "express";
import { db } from "@workspace/db";
import { licensesTable, insertLicenseSchema } from "@workspace/db";
import { and, asc, eq, isNotNull, lte, ne } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { facilityDateStr } from "../lib/facilityDate";

// Facility / state operating-license register (2026-07-21). Tracks the operator's
// OWN licenses (state processor, MDARD, local permits, etc.) with renewal dates,
// and powers the Quality dashboard's "licenses needing renewal" widget. Distinct
// from supplier certificate expiry, which lives on supplier_qualifications.
const router = Router();

// Managing licenses is a compliance function — limit writes to elevated roles.
// Reads are open to any signed-in user so a dashboard tile can render for anyone.
const WRITE_ROLES = new Set(["Admin", "Quality", "Manager"]);

// GET /licenses — active register (excludes soft-removed "Inactive"). Pass
// ?all=true to include Inactive rows (for an admin audit view).
router.get("/licenses", async (req, res) => {
  try {
    const includeAll = String(req.query.all ?? "") === "true";
    const rows = includeAll
      ? await db.select().from(licensesTable).orderBy(asc(licensesTable.expiryDate))
      : await db
          .select()
          .from(licensesTable)
          .where(ne(licensesTable.status, "Inactive"))
          .orderBy(asc(licensesTable.expiryDate));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list licenses");
    res.status(500).json({ error: "Failed to list licenses" });
  }
});

// GET /licenses/renewals?days=90 — licenses that are expired OR expiring within N
// days (default 90, clamped 1..365). Each row is enriched with `overdue` and
// `daysUntil`. This is the data source for the Quality "licenses needing renewal"
// widget.
router.get("/licenses/renewals", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1), 365);
    const todayStr = facilityDateStr();
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + days);
    const horizonStr = facilityDateStr(horizon);

    const rows = await db
      .select()
      .from(licensesTable)
      .where(
        and(
          isNotNull(licensesTable.expiryDate),
          lte(licensesTable.expiryDate, horizonStr),
          ne(licensesTable.status, "Inactive"),
        ),
      )
      .orderBy(asc(licensesTable.expiryDate));

    const enriched = rows.map((l) => {
      const exp = l.expiryDate as string;
      const overdue = exp < todayStr;
      const daysUntil = Math.round(
        (new Date(exp + "T00:00:00Z").getTime() - new Date(todayStr + "T00:00:00Z").getTime()) /
          86_400_000,
      );
      return { ...l, overdue, daysUntil };
    });

    res.json({
      days,
      overdueCount: enriched.filter((e) => e.overdue).length,
      dueSoonCount: enriched.filter((e) => !e.overdue).length,
      licenses: enriched,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get license renewals");
    res.status(500).json({ error: "Failed to get license renewals" });
  }
});

// POST /licenses — add a license (elevated roles).
router.post("/licenses", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (!WRITE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Not permitted for your role." });
      return;
    }
    const parsed = insertLicenseSchema.safeParse({ ...req.body, createdByName: user.fullName });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid license", details: parsed.error.issues });
      return;
    }
    const [created] = await db.insert(licensesTable).values(parsed.data).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to create license");
    res.status(500).json({ error: "Failed to create license" });
  }
});

// PUT /licenses/:id — update a license (elevated roles).
router.put("/licenses/:id", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (!WRITE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Not permitted for your role." });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { name, licenseType, licenseNumber, issuer, issueDate, expiryDate, status, notes } =
      req.body as Record<string, unknown>;
    const update: Partial<typeof licensesTable.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) update.name = String(name);
    if (licenseType !== undefined) update.licenseType = String(licenseType);
    if (licenseNumber !== undefined) update.licenseNumber = String(licenseNumber);
    if (issuer !== undefined) update.issuer = issuer ? String(issuer) : null;
    if (issueDate !== undefined) update.issueDate = issueDate ? String(issueDate) : null;
    if (expiryDate !== undefined) update.expiryDate = expiryDate ? String(expiryDate) : null;
    if (status !== undefined) update.status = String(status);
    if (notes !== undefined) update.notes = notes ? String(notes) : null;

    const [updated] = await db
      .update(licensesTable)
      .set(update)
      .where(eq(licensesTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "License not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update license");
    res.status(500).json({ error: "Failed to update license" });
  }
});

// DELETE /licenses/:id — soft-remove (elevated roles). QMS records are never
// hard-deleted; setting status "Inactive" drops the license from the register and
// the renewals widget while keeping the row for history.
router.delete("/licenses/:id", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (!WRITE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Not permitted for your role." });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [updated] = await db
      .update(licensesTable)
      .set({ status: "Inactive", updatedAt: new Date() })
      .where(eq(licensesTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "License not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove license");
    res.status(500).json({ error: "Failed to remove license" });
  }
});

export default router;
