import { Router } from "express";
import { db } from "@workspace/db";
import { supplierQualificationsTable, suppliersTable, normalizeCorrections, isCorrectionOpen } from "@workspace/db";
import { desc, eq, sql, like } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";

const router = Router();

// Session 32 — match NC/CAPA generator semantics: MAX of the parsed sequence
// suffix within the current year, NOT count(*). Year-scoped, monotonic, never
// reuses a number after a delete. The old count(*) approach was the third
// instance of the "increment-by-N" defect alongside Batch and Complaint.
// Race-condition note: small TOCTOU window between SELECT and INSERT; the
// unique constraint on qual_number is the hard backstop.
async function generateQualNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2);
  const prefix = `SQ-${year}-`;
  const rows = await db
    .select({ qualNumber: supplierQualificationsTable.qualNumber })
    .from(supplierQualificationsTable)
    .where(like(supplierQualificationsTable.qualNumber, `${prefix}%`));
  let maxSeq = 0;
  for (const r of rows) {
    const m = r.qualNumber?.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

// Single source of truth for the columns every read returns to the client.
// Previously each of the three read queries (list, get-by-id, post-return)
// carried its own inline copy of this projection; the 2026-08-10 audit-flow
// columns were added to the table but only to the writes, so the three copies
// drifted and the new fields (auditReason, corrections, closure, sign-offs)
// silently never reached the UI. Keep this the ONLY projection so it can't
// happen again — add a column here once and all three reads pick it up.
const qualSelect = {
  id: supplierQualificationsTable.id,
  qualNumber: supplierQualificationsTable.qualNumber,
  supplierId: supplierQualificationsTable.supplierId,
  supplierName: suppliersTable.supplierName,
  supplierType: suppliersTable.supplierType,
  qualificationType: supplierQualificationsTable.qualificationType,
  recordType: supplierQualificationsTable.recordType,
  riskLevel: supplierQualificationsTable.riskLevel,
  status: supplierQualificationsTable.status,
  assessorName: supplierQualificationsTable.assessorName,
  assessmentDate: supplierQualificationsTable.assessmentDate,
  expiryDate: supplierQualificationsTable.expiryDate,
  issuer: supplierQualificationsTable.issuer,
  certificateNumber: supplierQualificationsTable.certificateNumber,
  score: supplierQualificationsTable.score,
  findings: supplierQualificationsTable.findings,
  correctiveActionsRequired: supplierQualificationsTable.correctiveActionsRequired,
  auditReason: supplierQualificationsTable.auditReason,
  corrections: supplierQualificationsTable.corrections,
  correctionsRationale: supplierQualificationsTable.correctionsRationale,
  closureVerification: supplierQualificationsTable.closureVerification,
  closureDate: supplierQualificationsTable.closureDate,
  qualitySignedName: supplierQualificationsTable.qualitySignedName,
  qualitySignedInitials: supplierQualificationsTable.qualitySignedInitials,
  qualitySignedAt: supplierQualificationsTable.qualitySignedAt,
  managerSignedName: supplierQualificationsTable.managerSignedName,
  managerSignedInitials: supplierQualificationsTable.managerSignedInitials,
  managerSignedAt: supplierQualificationsTable.managerSignedAt,
  approvedByName: supplierQualificationsTable.approvedByName,
  approvalDate: supplierQualificationsTable.approvalDate,
  notes: supplierQualificationsTable.notes,
  createdByName: supplierQualificationsTable.createdByName,
  createdAt: supplierQualificationsTable.createdAt,
  updatedAt: supplierQualificationsTable.updatedAt,
};

router.get("/supplier-qualifications", async (req, res) => {
  try {
    const rows = await db
      .select(qualSelect)
      .from(supplierQualificationsTable)
      .innerJoin(suppliersTable, eq(supplierQualificationsTable.supplierId, suppliersTable.id))
      .orderBy(desc(supplierQualificationsTable.updatedAt));

    const { status, riskLevel, supplierId } = req.query;
    let filtered = rows;
    if (status) filtered = filtered.filter((r) => r.status === status);
    if (riskLevel) filtered = filtered.filter((r) => r.riskLevel === riskLevel);
    if (supplierId) filtered = filtered.filter((r) => r.supplierId === parseInt(supplierId as string));
    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Failed to list supplier qualifications");
    res.status(500).json({ error: "Failed to list supplier qualifications" });
  }
});

router.post("/supplier-qualifications", async (req, res) => {
  try {
    const qualNumber = await generateQualNumber();
    // Session 76.1 — defense-in-depth backstop for the date columns. These are
    // real DATE types; an empty string "" (e.g. an open-ended For-Cause review
    // with no expiry) is invalid date syntax and 500s the insert. Coerce blank
    // date fields to null regardless of which client posted them.
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    for (const k of ["assessmentDate", "expiryDate", "approvalDate", "closureDate"]) {
      if (typeof body[k] === "string" && (body[k] as string).trim() === "") body[k] = null;
    }
    // Certificate expiry required (2026-08-06) — a Certificate record exists to
    // track an expiry date, and the supplier license flag + review both key off
    // it. Filing a certificate without one silently leaves the supplier flagged,
    // so require it (audits may be open-ended, so this applies to certs only).
    if (body.recordType === "Certificate" && !body.expiryDate) {
      res.status(400).json({ error: "A certificate must have an expiry date — that's the date the system tracks for renewal. Add the certificate/license expiry, then save." });
      return;
    }
    // SQ-1 (2026-07-12) — new qualifications open in the single active state
    // "Open" (was the DB default "Scheduled"). The simplified workflow is
    // Open → Passed / Failed; the old "In Progress"/"Pending Review" limbo
    // states are retired. An explicit status in the body still wins.
    const [qual] = await db
      .insert(supplierQualificationsTable)
      .values({ ...body, qualNumber, status: (typeof body.status === "string" && body.status.trim()) || "Open" } as typeof supplierQualificationsTable.$inferInsert)
      .returning();

    // Fetch with supplier info
    const [withSupplier] = await db
      .select(qualSelect)
      .from(supplierQualificationsTable)
      .innerJoin(suppliersTable, eq(supplierQualificationsTable.supplierId, suppliersTable.id))
      .where(eq(supplierQualificationsTable.id, qual.id));

    res.status(201).json(withSupplier ?? qual);
  } catch (err) {
    req.log.error({ err }, "Failed to create supplier qualification");
    res.status(500).json({ error: "Failed to create supplier qualification" });
  }
});

router.get("/supplier-qualifications/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db
      .select(qualSelect)
      .from(supplierQualificationsTable)
      .innerJoin(suppliersTable, eq(supplierQualificationsTable.supplierId, suppliersTable.id))
      .where(eq(supplierQualificationsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get supplier qualification");
    res.status(500).json({ error: "Failed to get supplier qualification" });
  }
});

router.patch("/supplier-qualifications/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Session 76.1 — same blank-date coercion as the POST path. closureDate
    // (2026-08-10 audit flow) is a real DATE column too; clearing it in the
    // Closure editor posts "" and would 500 the update without this coercion.
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    for (const k of ["assessmentDate", "expiryDate", "approvalDate", "closureDate"]) {
      if (typeof body[k] === "string" && (body[k] as string).trim() === "") body[k] = null;
    }
    // Normalize corrections to the object shape on write — drops empty rows and
    // coerces any legacy plain-string entries, so stored data is always uniform.
    const incomingCorrections = "corrections" in body ? normalizeCorrections(body.corrections) : null;
    if (incomingCorrections) body.corrections = incomingCorrections;

    // Open-action gate (2026-08-10) — can't record Pass or set a Closure date
    // while any correction is still open (no completion date). Effective
    // corrections = those in THIS request if present, else the stored ones.
    const settingPass = body.status === "Passed";
    const settingClosure = typeof body.closureDate === "string" && (body.closureDate as string).trim() !== "";
    if (settingPass || settingClosure) {
      let corr = incomingCorrections;
      if (!corr) {
        const [existing] = await db
          .select({ corrections: supplierQualificationsTable.corrections })
          .from(supplierQualificationsTable)
          .where(eq(supplierQualificationsTable.id, id));
        corr = normalizeCorrections(existing?.corrections);
      }
      const openCount = corr.filter(isCorrectionOpen).length;
      if (openCount > 0) {
        res.status(400).json({
          error: `Can't ${settingPass ? "record Pass" : "set a closure date"} while ${openCount} correction${openCount === 1 ? " is" : "s are"} still open — add a Date Completed to every correction first.`,
        });
        return;
      }
    }

    // Auto-revert (2026-08-10) — if a corrections update REOPENS an action (a
    // correction with no completion date) on an already-Passed audit, undo the
    // outcome: flip back to Open and clear the Pass approval + closure date, so a
    // Passed audit can never sit with an open correction. The audit must then be
    // re-completed and re-passed. (Guard: skip if this same request is already
    // (re)setting the status explicitly, e.g. a Fail.)
    if (incomingCorrections && incomingCorrections.some(isCorrectionOpen) && body.status === undefined) {
      const [current] = await db
        .select({ status: supplierQualificationsTable.status })
        .from(supplierQualificationsTable)
        .where(eq(supplierQualificationsTable.id, id));
      if (current?.status === "Passed") {
        body.status = "Open";
        body.approvalDate = null;
        body.approvedByName = null;
        body.closureDate = null;
      }
    }

    const [qual] = await db
      .update(supplierQualificationsTable)
      .set({ ...body, updatedAt: new Date() } as Partial<typeof supplierQualificationsTable.$inferInsert>)
      .where(eq(supplierQualificationsTable.id, id))
      .returning();
    if (!qual) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(qual);
  } catch (err) {
    req.log.error({ err }, "Failed to update supplier qualification");
    res.status(500).json({ error: "Failed to update supplier qualification" });
  }
});

// 2026-08-10 — lightweight outcome sign-off. Quality and Manager each sign so
// both are aware of the audit outcome. Role-gated per slot; captures name +
// initials + timestamp (Quality typically runs the audit and writes the record).
const QUALITY_SLOT_ROLES = new Set(["Quality", "Admin"]);
const MANAGER_SLOT_ROLES = new Set(["Manager", "Admin"]);
router.post("/supplier-qualifications/:id/sign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { slot, initials } = (req.body ?? {}) as { slot?: string; initials?: string };
    if (slot !== "quality" && slot !== "manager") {
      res.status(400).json({ error: "slot must be 'quality' or 'manager'." }); return;
    }
    if (!initials || !initials.trim()) {
      res.status(400).json({ error: "Initials are required to sign off." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const allowed = slot === "quality" ? QUALITY_SLOT_ROLES : MANAGER_SLOT_ROLES;
    if (!allowed.has(actor.role)) {
      res.status(403).json({ error: slot === "quality"
        ? "Only Quality (or Admin) can sign the Quality slot."
        : "Only a Manager (or Admin) can sign the Manager slot." });
      return;
    }
    const now = new Date();
    const patch = slot === "quality"
      ? { qualitySignedName: actor.fullName, qualitySignedInitials: initials.trim(), qualitySignedAt: now }
      : { managerSignedName: actor.fullName, managerSignedInitials: initials.trim(), managerSignedAt: now };
    const [qual] = await db
      .update(supplierQualificationsTable)
      .set({ ...patch, updatedAt: now } as Partial<typeof supplierQualificationsTable.$inferInsert>)
      .where(eq(supplierQualificationsTable.id, id))
      .returning();
    if (!qual) { res.status(404).json({ error: "Not found" }); return; }
    res.json(qual);
  } catch (err) {
    req.log.error({ err }, "Failed to record supplier qualification sign-off");
    res.status(500).json({ error: "Failed to record sign-off" });
  }
});

export default router;
