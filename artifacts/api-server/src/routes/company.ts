import { Router } from "express";
import { db } from "@workspace/db";
import { companyProfileTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// The COMPANY — one record, the operator itself: who they are, who to call, and
// the company-wide switches like supplier risk scoring.
//
// 2026-08-28 — the facility TIME ZONE moved off this record onto the facility
// (routes/facilities.ts). It lived here for one day, while a facility entity did
// not exist, and a company holding licences in two states needs one zone per site.
// `company_profile.time_zone` is deliberately left in the table, holding the value
// the facility was seeded from; it is simply no longer read or written.
const router = Router();

router.get("/company-profile", async (req, res) => {
  try {
    const [profile] = await db.select().from(companyProfileTable).limit(1);
    if (!profile) {
      const [created] = await db.insert(companyProfileTable).values({ companyName: "My Company" }).returning();
      res.json(created); return;
    }
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Failed to get company profile");
    res.status(500).json({ error: "Failed to get company profile" });
  }
});

router.patch("/company-profile", async (req, res) => {
  try {
    const [existing] = await db.select().from(companyProfileTable).limit(1);
    if (!existing) {
      const [created] = await db.insert(companyProfileTable).values(req.body).returning();
      res.json(created); return;
    }
    const [profile] = await db.update(companyProfileTable).set({ ...req.body, updatedAt: new Date() }).where(
      eq(companyProfileTable.id, existing.id)
    ).returning();
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Failed to update company profile");
    res.status(500).json({ error: "Failed to update company profile" });
  }
});

export default router;
