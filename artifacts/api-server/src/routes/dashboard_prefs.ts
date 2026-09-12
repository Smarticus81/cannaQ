import { Router } from "express";
import { db } from "@workspace/db";
import { userDashboardPreferencesTable, incomingInspectionsTable } from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";

// Per-user configurable dashboard (2026-07-21). Stores each user's chosen widget
// layout as an override on top of the role-based default (Quality / Production).
// A user with no saved row simply gets their role's default template, so this
// table only holds people who have customised their own dashboard.
const router = Router();

// GET /dashboard/preferences — the current user's saved layout (or null) plus
// their role, so the client knows which default template to fall back to.
router.get("/dashboard/preferences", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user || !user.clerkUserId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const [pref] = await db
      .select()
      .from(userDashboardPreferencesTable)
      .where(eq(userDashboardPreferencesTable.clerkUserId, user.clerkUserId));
    res.json({ role: user.role, preferences: pref ?? null });
  } catch (err) {
    req.log.error({ err }, "Failed to get dashboard preferences");
    res.status(500).json({ error: "Failed to get dashboard preferences" });
  }
});

// PUT /dashboard/preferences — upsert the current user's layout. Body:
//   { layout: WidgetConfig[]; baseTemplate?: "Quality" | "Production" | null }
// where WidgetConfig = { widgetId, visible, order, variant? }. The layout array is
// stored verbatim as jsonb; its shape is validated on the client side.
router.put("/dashboard/preferences", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user || !user.clerkUserId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const { layout, baseTemplate } = req.body as {
      layout?: unknown;
      baseTemplate?: string | null;
    };
    if (!Array.isArray(layout)) {
      res.status(400).json({ error: "layout must be an array" });
      return;
    }
    const [existing] = await db
      .select()
      .from(userDashboardPreferencesTable)
      .where(eq(userDashboardPreferencesTable.clerkUserId, user.clerkUserId));
    let saved;
    if (existing) {
      [saved] = await db
        .update(userDashboardPreferencesTable)
        .set({
          layout,
          baseTemplate: baseTemplate ?? existing.baseTemplate,
          updatedAt: new Date(),
        })
        .where(eq(userDashboardPreferencesTable.id, existing.id))
        .returning();
    } else {
      [saved] = await db
        .insert(userDashboardPreferencesTable)
        .values({ clerkUserId: user.clerkUserId, layout, baseTemplate: baseTemplate ?? null })
        .returning();
    }
    res.json(saved);
  } catch (err) {
    req.log.error({ err }, "Failed to save dashboard preferences");
    res.status(500).json({ error: "Failed to save dashboard preferences" });
  }
});

// DELETE /dashboard/preferences — reset the current user back to their role default
// (removes their customised row).
router.delete("/dashboard/preferences", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user || !user.clerkUserId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    await db
      .delete(userDashboardPreferencesTable)
      .where(eq(userDashboardPreferencesTable.clerkUserId, user.clerkUserId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reset dashboard preferences");
    res.status(500).json({ error: "Failed to reset dashboard preferences" });
  }
});

// GET /dashboard/open-inspections — count of incoming inspections still awaiting a
// result (Pending and not cancelled). Feeds the Production dashboard's
// "Open inspections" tile. Kept as its own endpoint so the shared /dashboard/summary
// route is untouched.
router.get("/dashboard/open-inspections", async (req, res) => {
  try {
    const [row] = await db
      .select({ cnt: count() })
      .from(incomingInspectionsTable)
      .where(
        and(
          eq(incomingInspectionsTable.result, "Pending"),
          isNull(incomingInspectionsTable.cancelledAt),
        ),
      );
    res.json({ openInspections: Number(row?.cnt ?? 0) });
  } catch (err) {
    req.log.error({ err }, "Failed to get open inspections");
    res.status(500).json({ error: "Failed to get open inspections" });
  }
});

export default router;
