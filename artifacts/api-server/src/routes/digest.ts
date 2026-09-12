import { Router } from "express";
import { db } from "@workspace/db";
import { digestSettingsTable } from "@workspace/db";
import {
  buildComplianceDigest,
  buildInventoryDigest,
  sendComplianceDigest,
  sendInventoryDigest,
} from "../services/digestEmail";
import { sql } from "drizzle-orm";

const router = Router();

async function getCompanyName(): Promise<string> {
  try {
    const result = await db.execute(sql`SELECT company_name FROM company_profile LIMIT 1`);
    const row = result.rows?.[0] as { company_name?: string } | undefined;
    return row?.company_name ?? "CannaQMS";
  } catch {
    return "CannaQMS";
  }
}

// GET /digest/settings
router.get("/digest/settings", async (req, res) => {
  try {
    const [settings] = await db.select().from(digestSettingsTable).limit(1);
    res.json(settings ?? null);
  } catch (err) {
    req.log.error({ err }, "Failed to get digest settings");
    res.status(500).json({ error: "Failed to get digest settings" });
  }
});

// PATCH /digest/settings
router.patch("/digest/settings", async (req, res) => {
  try {
    const {
      complianceRecipients,
      inventoryRecipients,
      sendHourUtc,
      sendDayOfWeek,
      enabled,
    } = req.body as {
      complianceRecipients?: string;
      inventoryRecipients?: string;
      sendHourUtc?: number;
      sendDayOfWeek?: number;
      enabled?: number;
    };

    const update: Partial<typeof digestSettingsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (complianceRecipients !== undefined) update.complianceRecipients = complianceRecipients;
    if (inventoryRecipients !== undefined) update.inventoryRecipients = inventoryRecipients;
    if (sendHourUtc !== undefined) update.sendHourUtc = sendHourUtc;
    if (sendDayOfWeek !== undefined) update.sendDayOfWeek = sendDayOfWeek;
    if (enabled !== undefined) update.enabled = enabled;

    const [updated] = await db
      .update(digestSettingsTable)
      .set(update)
      .returning();

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update digest settings");
    res.status(500).json({ error: "Failed to update digest settings" });
  }
});

// POST /digest/send/compliance  — manual trigger
router.post("/digest/send/compliance", async (req, res) => {
  try {
    const result = await sendComplianceDigest();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to send compliance digest");
    res.status(500).json({ error: "Failed to send compliance digest" });
  }
});

// POST /digest/send/inventory  — manual trigger
router.post("/digest/send/inventory", async (req, res) => {
  try {
    const result = await sendInventoryDigest();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to send inventory digest");
    res.status(500).json({ error: "Failed to send inventory digest" });
  }
});

// GET /digest/preview/compliance  — returns raw HTML for browser preview
router.get("/digest/preview/compliance", async (req, res) => {
  try {
    const companyName = await getCompanyName();
    const html = await buildComplianceDigest(companyName);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Failed to preview compliance digest");
    res.status(500).json({ error: "Failed to preview compliance digest" });
  }
});

// GET /digest/preview/inventory  — returns raw HTML for browser preview
router.get("/digest/preview/inventory", async (req, res) => {
  try {
    const companyName = await getCompanyName();
    const html = await buildInventoryDigest(companyName);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Failed to preview inventory digest");
    res.status(500).json({ error: "Failed to preview inventory digest" });
  }
});

export default router;
