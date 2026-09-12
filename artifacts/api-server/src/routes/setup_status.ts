// First-run setup status (Session 71, PR 2).
//
// Powers the Dashboard "Get started" checklist. Returns a flat set of booleans
// (plus a couple of counts for nuance) describing which first-run milestones a
// fresh deployment has completed. The frontend owns the labels / routes / copy
// — this endpoint only answers "is each thing configured yet," computed from
// the live tables so it's always accurate (no separate onboarding state to
// drift out of sync).
//
// Detection notes:
//   • company profile: GET /company-profile auto-creates a default row named
//     "My Company", so mere existence is not a signal. We treat it as done only
//     once the operator has actually filled it in (a real license number, or a
//     company name other than the default).
//   • approved testing lab: a supplier of type "Testing Laboratory" in status
//     "Approved" and not cancelled — required before a batch can carry a COA.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  companyProfileTable,
  usersTable,
  suppliersTable,
  batchRecordsTable,
} from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";

const router = Router();

router.get("/setup-status", async (req, res) => {
  try {
    const safeCount = async (q: PromiseLike<{ cnt: number }[]>): Promise<number> => {
      try { return Number((await q)[0]?.cnt ?? 0); } catch { return 0; }
    };

    const [profileRow] = await db.select().from(companyProfileTable).limit(1);
    const companyName = (profileRow?.companyName ?? "").trim();
    const companyProfile =
      !!(profileRow?.licenseNumber && profileRow.licenseNumber.trim()) ||
      (companyName.length > 0 && companyName !== "My Company");

    const [usersCount, supplierCount, approvedLabCount, batchCount] = await Promise.all([
      safeCount(db.select({ cnt: count() }).from(usersTable)),
      safeCount(
        db.select({ cnt: count() })
          .from(suppliersTable)
          .where(isNull(suppliersTable.cancelledAt)),
      ),
      safeCount(
        db.select({ cnt: count() })
          .from(suppliersTable)
          .where(and(
            isNull(suppliersTable.cancelledAt),
            eq(suppliersTable.supplierType, "Testing Laboratory"),
            eq(suppliersTable.status, "Approved"),
          )),
      ),
      safeCount(db.select({ cnt: count() }).from(batchRecordsTable)),
    ]);

    const flags = {
      companyProfile,
      // More than the founding admin = a real team has been added.
      teamMembers: usersCount > 1,
      firstSupplier: supplierCount > 0,
      approvedTestingLab: approvedLabCount > 0,
      firstBatch: batchCount > 0,
    };

    const total = Object.keys(flags).length;
    const completed = Object.values(flags).filter(Boolean).length;

    res.json({
      ...flags,
      counts: { users: usersCount, suppliers: supplierCount, approvedLabs: approvedLabCount, batches: batchCount },
      completed,
      total,
      allComplete: completed === total,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get setup status");
    res.status(500).json({ error: "Failed to get setup status" });
  }
});

export default router;
