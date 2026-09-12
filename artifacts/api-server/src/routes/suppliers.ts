import { Router } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable,
  supplierAttachmentsTable,
  supplierQualificationsTable,
  nonConformancesTable,
  incomingInspectionsTable,
  auditLogTable,
  supplierRiskChangesTable,
} from "@workspace/db";
import { eq, and, desc, inArray, ne } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { facilityDateStr } from "../lib/facilityDate";

const router = Router();

// Session 32 — supplier audit-log helper, mirrors the writeAuditLog used in
// non_conformances.ts / capas.ts / batches.ts. The supplier audit trail was
// previously implicit (UI surfaced edits but no row was written); the freeze
// + reopen flow added in this session requires an explicit record.
async function writeSupplierAuditLog(opts: {
  rowId: number;
  operation: string;
  changedById?: number | null;
  changedByName?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: "suppliers",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch { /* audit log must never break the main flow */ }
}

// Session 33 (Tier 2 #6) — Michigan cannabis suppliers must carry a license
// number unless they are still in a pre-license state. Two statuses exempt:
//   • Pending Review   — operator just added the supplier, info pending
//   • License Pending  — added but the license number is not yet on file
// Every other status (Approved, Conditional, Suspended, Unapproved,
// Disqualified) requires license_number to be present and non-empty when
// supplier_type is a cannabis cultivator or cannabis processor.
const CANNABIS_LICENSED_SUPPLIER_TYPES = new Set(["Cannabis Cultivator", "Cannabis Processor"]);
const LICENSE_EXEMPT_STATUSES = new Set(["Pending Review", "License Pending"]);
function licenseRequirementError(
  supplierType: string | null | undefined,
  status: string | null | undefined,
  licenseNumber: string | null | undefined,
): string | null {
  if (!supplierType || !CANNABIS_LICENSED_SUPPLIER_TYPES.has(supplierType)) return null;
  if (!status || LICENSE_EXEMPT_STATUSES.has(status)) return null;
  if (!licenseNumber || !licenseNumber.trim()) {
    return `License Number is required for ${supplierType} suppliers in status "${status}". Either provide a Michigan license number, or move the supplier to "License Pending" / "Pending Review" until the license is on file.`;
  }
  return null;
}

// Session 33 (Tier 2 #6, second half) — block material acceptance from
// cannabis suppliers whose license is not yet confirmed. "License Pending"
// and "Conditional" cannabis suppliers cannot be on the supplier line of a
// new Incoming Inspection. Used by the inspections route.
export const CANNABIS_BLOCKED_FOR_RECEIVING = new Set(["License Pending", "Conditional"]);

// Feedback 07-05 (SUP-2) — Incoming Inspections exist to monitor ingredients /
// materials that DIRECTLY impact the product (cannabis inputs, food-grade raw
// materials, and product-contact packaging). They are NOT for equipment,
// services, or facility vendors (HVAC, pest control, cleaning, ovens, mixing
// bowls, spatulas, tape, chairs, etc.) — receiving those would wrongly push
// non-product items into inventory. Only these supplier types may be selected
// on a new inspection; the picker filters to them and the server enforces it.
export const PRODUCT_MATERIAL_SUPPLIER_TYPES = new Set([
  "Cannabis Cultivator",
  "Cannabis Processor",
  "Raw Material Supplier",
  "Packaging Supplier",
]);
export function isProductMaterialSupplierType(supplierType: string | null | undefined): boolean {
  return !!supplierType && PRODUCT_MATERIAL_SUPPLIER_TYPES.has(supplierType);
}

// ── License-record requirement (2026-08-06) ─────────────────────────────────────
// Some suppliers are only qualified by a LICENSE / CERTIFICATE that carries an
// expiry date the QMS must actively watch. Rule: a supplier is "license-required"
// if its type is a cannabis licensee or testing laboratory, OR it has a license
// number on file (which captures regulated service trades — pest control, HVAC,
// electrical, plumbing — since their license number gets recorded here).
//
// Enforcement is "flag & alert": such a supplier is flagged until a CURRENT
// (non-expired) license/certificate record exists, and it cannot be set to
// "Approved" without one. Compliance is derived from the supplier's own
// certificate records (any non-failed qualification carrying a future expiry),
// independent of the audit Pass/Fail workflow — filing a certificate with a
// future expiry is enough. (New qual records open as "Open", not "Passed", so we
// deliberately do NOT reuse the Passed-only review driver here.)
const LICENSE_RECORD_REQUIRED_TYPES = new Set([
  "Cannabis Cultivator",
  "Cannabis Processor",
  "Testing Laboratory",
  // 2026-08-06 — Service Suppliers are licensed trades (pest control, HVAC,
  // electrical, plumbing). Requiring them BY TYPE closes the "leave the license
  // number blank and skip the requirement" dodge. NOTE: this also flags
  // unlicensed services (cleaning, consulting) as needing a license/cert — if
  // that's noisy, revisit with a per-supplier "license not applicable" opt-out.
  "Service Supplier",
]);
// Qualification statuses that do NOT count as a valid license/cert on file.
const NON_QUALIFYING_QUAL_STATUSES = new Set(["Failed", "Rejected", "Cancelled"]);

export function isLicenseRecordRequired(
  supplierType: string | null | undefined,
  licenseNumber: string | null | undefined,
): boolean {
  if (supplierType && LICENSE_RECORD_REQUIRED_TYPES.has(supplierType)) return true;
  return !!(licenseNumber && licenseNumber.trim());
}

type LicenseCompliance = "not-required" | "missing" | "expired" | "current";
function licenseComplianceFrom(
  supplierType: string | null | undefined,
  licenseNumber: string | null | undefined,
  latestExpiry: string | null | undefined,
): LicenseCompliance {
  if (!isLicenseRecordRequired(supplierType, licenseNumber)) return "not-required";
  if (!latestExpiry) return "missing";
  // ISO YYYY-MM-DD dates: a lexical compare equals a chronological one.
  const todayISO = facilityDateStr();
  return latestExpiry < todayISO ? "expired" : "current";
}

// Per-supplier furthest-out expiry among non-failed qualification/certificate
// records that actually carry an expiry date. A supplier absent from the map has
// no tracked-expiry record on file at all.
async function getLicenseExpiryMap(supplierIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (supplierIds.length === 0) return map;
  const rows = await db
    .select({
      supplierId: supplierQualificationsTable.supplierId,
      status: supplierQualificationsTable.status,
      expiryDate: supplierQualificationsTable.expiryDate,
    })
    .from(supplierQualificationsTable)
    .where(inArray(supplierQualificationsTable.supplierId, supplierIds));
  for (const r of rows) {
    if (!r.expiryDate) continue;
    if (r.status && NON_QUALIFYING_QUAL_STATUSES.has(r.status)) continue;
    const cur = map.get(r.supplierId);
    if (!cur || r.expiryDate > cur) map.set(r.supplierId, r.expiryDate);
  }
  return map;
}

// ── Review-status helpers ──────────────────────────────────────────────────────

function reviewStatusAt(
  intervalYears: number,
  lastQualifiedDate: string | null,
  reference: Date,
): string {
  if (!lastQualifiedDate) return "never-qualified";
  const due = new Date(lastQualifiedDate + "T00:00:00Z");
  due.setUTCFullYear(due.getUTCFullYear() + intervalYears);
  const diffDays = Math.ceil((due.getTime() - reference.getTime()) / 86_400_000);
  if (diffDays < 0)        return "overdue";
  if (diffDays <= 90)      return "due-soon";
  return "current";
}

// Session 97 (certificates / #14) — re-qualification can be driven by certificate
// EXPIRY rather than a fixed interval. A ReviewDriver carries, per supplier: the
// most recent Approved qualification date (lastQualifiedDate), and the earliest
// upcoming expiry among the supplier's CURRENT certificates (drivingExpiry) with
// the certificate type that owns it (drivingType). Expiry drives the next review
// when present; the fixed interval is the fallback used only when no current cert
// carries an expiry date.
type ReviewDriver = { lastQualifiedDate: string | null; drivingExpiry: string | null; drivingType: string | null };

function computeReviewFields(
  intervalYears: number,
  lastQualifiedDate: string | null,
  drivingExpiry?: string | null,
  drivingType?: string | null,
): { lastQualifiedDate: string | null; nextReviewDue: string | null; reviewStatus: string; reviewDriver: string | null } {
  // Expiry-driven: a current certificate carries an expiry date → next review is
  // that expiry (dates are ISO YYYY-MM-DD, so lexical = chronological).
  if (drivingExpiry) {
    const due = new Date(drivingExpiry + "T00:00:00Z");
    const diffDays = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
    const status = diffDays < 0 ? "overdue" : diffDays <= 90 ? "due-soon" : "current";
    return {
      lastQualifiedDate,
      nextReviewDue: drivingExpiry,
      reviewStatus: status,
      reviewDriver: drivingType ? `${drivingType} certificate expiry` : "certificate expiry",
    };
  }
  // Fallback: fixed interval from the last qualification (legacy behavior).
  if (!lastQualifiedDate) {
    return { lastQualifiedDate: null, nextReviewDue: null, reviewStatus: "never-qualified", reviewDriver: null };
  }
  const last = new Date(lastQualifiedDate + "T00:00:00Z");
  const due  = new Date(last);
  due.setUTCFullYear(due.getUTCFullYear() + intervalYears);

  const dueStr   = facilityDateStr(due);
  const status   = reviewStatusAt(intervalYears, lastQualifiedDate, new Date());

  return { lastQualifiedDate, nextReviewDue: dueStr, reviewStatus: status, reviewDriver: `${intervalYears}-year interval` };
}

// Per-supplier review drivers. Pulls every Passed qualification (a qual record
// doubles as a certificate here), then for each supplier keeps the LATEST qual per
// certificate type (a renewal supersedes the prior cert of that type, so an old
// expired license doesn't linger) and takes the EARLIEST expiry across those
// current per-type certs.
async function getReviewDrivers(supplierIds: number[]): Promise<Map<number, ReviewDriver>> {
  const map = new Map<number, ReviewDriver>();
  if (supplierIds.length === 0) return map;
  const rows = await db
    .select({
      supplierId: supplierQualificationsTable.supplierId,
      qualificationType: supplierQualificationsTable.qualificationType,
      recordType: supplierQualificationsTable.recordType,
      status: supplierQualificationsTable.status,
      approvalDate: supplierQualificationsTable.approvalDate,
      expiryDate: supplierQualificationsTable.expiryDate,
    })
    .from(supplierQualificationsTable)
    .where(inArray(supplierQualificationsTable.supplierId, supplierIds))
    .orderBy(desc(supplierQualificationsTable.approvalDate));

  // A record COUNTS as a current qualification/cert for the re-qualification /
  // expiry column when it isn't in a failed/rejected/cancelled state AND is
  // either a Passed/Approved audit OR a filed Certificate. Certificates carry no
  // Pass/Fail step (they open as "Open"), so filing one with an expiry makes it
  // current — this keeps the review/expiry column consistent with the
  // license-record flag, which also counts filed certificates. (2026-08-06.)
  // SQ-3 / SRS-3 note: "Passed" is the qualification workflow's terminal success
  // status; legacy "Approved" rows still count too.
  const counts = (r: { status: string | null; recordType: string | null }) => {
    if (r.status && NON_QUALIFYING_QUAL_STATUSES.has(r.status)) return false;
    return r.status === "Passed" || r.status === "Approved" || r.recordType === "Certificate";
  };

  const bySupplier = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!counts(r)) continue;
    if (!bySupplier.has(r.supplierId)) bySupplier.set(r.supplierId, []);
    bySupplier.get(r.supplierId)!.push(r);
  }
  for (const [sid, quals] of bySupplier) {
    // lastQualifiedDate = most recent approval date among Passed/Approved audits.
    // Certificates carry no approvalDate; they drive the expiry, not this date.
    const lastQualifiedDate =
      quals.find((q) => q.approvalDate && (q.status === "Passed" || q.status === "Approved"))?.approvalDate ?? null;
    // Current expiry per qualificationType = the FURTHEST-OUT expiry (a renewal
    // supersedes an older cert of the same type); drivingExpiry = the EARLIEST of
    // those per-type current expiries. Order-independent, so a renewal is never
    // masked by a still-listed expired record of the same type.
    const currentExpiryByType = new Map<string, string>();
    for (const q of quals) {
      if (!q.expiryDate) continue;
      const type = q.qualificationType ?? "";
      const cur = currentExpiryByType.get(type);
      if (!cur || q.expiryDate > cur) currentExpiryByType.set(type, q.expiryDate); // ISO: lexical = chrono
    }
    let drivingExpiry: string | null = null;
    let drivingType: string | null = null;
    for (const [type, exp] of currentExpiryByType) {
      if (drivingExpiry === null || exp < drivingExpiry) { drivingExpiry = exp; drivingType = type || null; }
    }
    map.set(sid, { lastQualifiedDate, drivingExpiry, drivingType });
  }
  return map;
}

// ── Risk-score helpers ─────────────────────────────────────────────────────────

interface RiskInputs {
  openNcs: { severity: string }[];
  allInspections: { result: string }[];
  rejectedQualCount: number;
}

function computeRiskScore(
  supplier: { status: string },
  reviewStatus: string,
  inputs: RiskInputs,
): { riskScore: number; riskTier: string; riskFactors: string[] } {
  let score = 0;
  const factors: string[] = [];

  // 1. Re-qualification status (max 40 pts)
  //
  // Per operator feedback (Session 3, 5/8): a brand-new supplier should NOT
  // automatically inherit "+40 — no qualification on record". That penalty
  // only makes sense once the operator has Approved the supplier as a vendor.
  // Until then, the supplier's status (Unapproved / Pending Review) already
  // captures the risk; double-counting drives every new supplier to Medium
  // before any real activity has occurred.
  //
  // Rules:
  //   • Approved supplier + never-qualified  → full +40 penalty (real gap)
  //   • Approved supplier + overdue/due-soon → existing penalties apply
  //   • Non-Approved + never-qualified        → suppressed; status #2 covers it
  if (reviewStatus === "never-qualified") {
    if (supplier.status === "Approved") {
      score += 40;
      factors.push("Approved supplier with no qualification on record");
    }
    // else: intentionally no penalty — supplier is not yet in active use.
  } else if (reviewStatus === "overdue") {
    score += 35;
    factors.push("Re-qualification overdue");
  } else if (reviewStatus === "due-soon") {
    score += 15;
    factors.push("Re-qualification due within 90 days");
  }

  // 2. Supplier approval status (max 30 pts)
  if (supplier.status === "Suspended") {
    score += 30;
    factors.push("Supplier status: Suspended");
  } else if (supplier.status === "Unapproved") {
    score += 20;
    factors.push("Supplier status: Unapproved");
  } else if (supplier.status === "Pending Review") {
    score += 10;
    factors.push("Supplier status: Pending Review");
  }

  // 3. Open Non-Conformances (max 20 pts)
  const critNcs  = inputs.openNcs.filter((n) => n.severity === "Critical").length;
  const majorNcs = inputs.openNcs.filter((n) => n.severity === "Major").length;
  const minorNcs = inputs.openNcs.filter((n) => n.severity === "Minor" || n.severity === "Low").length;
  score += Math.min(critNcs * 10, 20);
  score += Math.min(majorNcs * 5, 10);
  score += Math.min(minorNcs * 2, 4);
  if (critNcs  > 0) factors.push(`${critNcs} open Critical NC${critNcs  > 1 ? "s" : ""}`);
  if (majorNcs > 0) factors.push(`${majorNcs} open Major NC${majorNcs > 1 ? "s" : ""}`);
  if (minorNcs > 0) factors.push(`${minorNcs} open Minor NC${minorNcs > 1 ? "s" : ""}`);

  // 4. Inspection failure rate (max 10 pts)
  const total  = inputs.allInspections.length;
  const failed = inputs.allInspections.filter((i) => i.result !== "Pass").length;
  if (total > 0) {
    const rate = failed / total;
    if (rate > 0.5)       { score += 10; factors.push(`Inspection failure rate: ${Math.round(rate * 100)}%`); }
    else if (rate > 0.25) { score += 5;  factors.push(`Inspection failure rate: ${Math.round(rate * 100)}%`); }
    else if (rate > 0)    {               factors.push(`Inspection failure rate: ${Math.round(rate * 100)}%`); }
  }

  // 5. Rejected qualifications (max 6 pts)
  score += Math.min(inputs.rejectedQualCount * 3, 6);
  if (inputs.rejectedQualCount > 0) {
    factors.push(`${inputs.rejectedQualCount} rejected qualification record${inputs.rejectedQualCount > 1 ? "s" : ""}`);
  }

  score = Math.min(score, 100);

  let riskTier: string;
  if      (score >= 66) riskTier = "Critical";
  else if (score >= 41) riskTier = "High";
  else if (score >= 16) riskTier = "Medium";
  else                  riskTier = "Low";

  return { riskScore: score, riskTier, riskFactors: factors };
}

async function getBatchRiskInputs(supplierIds: number[]): Promise<Map<number, RiskInputs>> {
  if (supplierIds.length === 0) return new Map();

  const [ncs, inspections, rejectedQuals] = await Promise.all([
    db.select({ supplierId: nonConformancesTable.supplierId, severity: nonConformancesTable.severity })
      .from(nonConformancesTable)
      .where(and(
        inArray(nonConformancesTable.supplierId, supplierIds),
        ne(nonConformancesTable.status, "Closed"),
      )),
    db.select({ supplierId: incomingInspectionsTable.supplierId, result: incomingInspectionsTable.result })
      .from(incomingInspectionsTable)
      .where(inArray(incomingInspectionsTable.supplierId, supplierIds)),
    db.select({ supplierId: supplierQualificationsTable.supplierId })
      .from(supplierQualificationsTable)
      .where(and(
        inArray(supplierQualificationsTable.supplierId, supplierIds),
        // SRS-4 (2026-07-13) — the qualification workflow's failure status is
        // "Failed" (see SupplierQualificationDetail STATUSES), not "Rejected", so
        // failed quals never counted toward supplier risk. Accept both ("Rejected"
        // kept for any legacy rows).
        inArray(supplierQualificationsTable.status, ["Failed", "Rejected"]),
      )),
  ]);

  const result = new Map<number, RiskInputs>();
  for (const id of supplierIds) {
    result.set(id, { openNcs: [], allInspections: [], rejectedQualCount: 0 });
  }
  for (const nc of ncs) {
    if (nc.supplierId != null) result.get(nc.supplierId)?.openNcs.push({ severity: nc.severity });
  }
  for (const ins of inspections) {
    if (ins.supplierId != null) result.get(ins.supplierId)?.allInspections.push({ result: ins.result });
  }
  for (const rq of rejectedQuals) {
    const entry = result.get(rq.supplierId);
    if (entry) entry.rejectedQualCount += 1;
  }
  return result;
}

const TIER_BASELINE_SCORE: Record<string, number> = { Low: 8, Medium: 30, High: 55, Critical: 80 };

// SRS-1 Part 2 — tier ordering for comparing computed vs effective (reviewed) tier.
const TIER_RANK: Record<string, number> = { Low: 0, Medium: 1, High: 2, Critical: 3 };
const tierRank = (t: string | null | undefined): number => TIER_RANK[t ?? "Low"] ?? 0;

function annotate(
  supplier: typeof suppliersTable.$inferSelect,
  driver: ReviewDriver | null,
  riskInputs?: RiskInputs,
  licenseExpiry?: string | null,
) {
  const review = computeReviewFields(
    supplier.requalificationIntervalYears,
    driver?.lastQualifiedDate ?? null,
    driver?.drivingExpiry ?? null,
    driver?.drivingType ?? null,
  );
  const risk = computeRiskScore(supplier, review.reviewStatus, riskInputs ?? { openNcs: [], allInspections: [], rejectedQualCount: 0 });
  // License-record requirement (2026-08-06) — surfaced on every supplier so the
  // list, detail banner, and the Approved gate all read one source of truth.
  const licenseFields = {
    licenseRequired: isLicenseRecordRequired(supplier.supplierType, supplier.licenseNumber),
    licenseCompliance: licenseComplianceFrom(supplier.supplierType, supplier.licenseNumber, licenseExpiry ?? null),
    licenseExpiry: licenseExpiry ?? null,
  };
  // If the operator explicitly set a risk tier on this supplier, honor it as
  // the source of truth — cannabis isn't ISO 13485-bound, so the system must
  // not auto-bump a brand-new supplier to Medium just because no qualification
  // record exists yet. We keep the computed score visible but pin the tier.
  if (supplier.riskTier && TIER_BASELINE_SCORE[supplier.riskTier] !== undefined) {
    return {
      ...supplier,
      ...review,
      ...risk,
      ...licenseFields,
      riskTier: supplier.riskTier,
      riskScore: Math.max(risk.riskScore, TIER_BASELINE_SCORE[supplier.riskTier] ?? 0),
      riskFactors: [`Operator-set base tier: ${supplier.riskTier}`, ...risk.riskFactors],
    };
  }
  // SRS-1 Part 2 — surface the effective (reviewed) tier. It equals the computed
  // tier except when a DECREASE is being held for approval, in which case the
  // supplier keeps its higher reviewed tier (and that tier's baseline score +
  // factors) until Manager/Quality sign off. `computedRiskTier` exposes the
  // proposed lower tier for the review UI.
  const reviewedTier = supplier.reviewedRiskTier;
  const held = reviewedTier != null && tierRank(reviewedTier) > tierRank(risk.riskTier);
  return {
    ...supplier,
    ...review,
    ...risk,
    ...licenseFields,
    riskTier: reviewedTier ?? risk.riskTier,
    riskScore: held && supplier.reviewedRiskScore != null ? supplier.reviewedRiskScore : risk.riskScore,
    riskFactors: held && supplier.reviewedRiskFactors ? supplier.reviewedRiskFactors : risk.riskFactors,
    computedRiskTier: risk.riskTier,
    computedRiskScore: risk.riskScore,
    riskTierPendingReview: held,
  };
}

// ── SRS-1 Part 2 — supplier risk-tier change review engine ──────────────────────
// Manager / Quality / Admin may review (acknowledge increases, approve decreases).
const SUPPLIER_RISK_REVIEW_ROLES = new Set(["Manager", "Quality", "Admin"]);

// Deterministic, templated rationale for one tier change (mirrors the client's
// SRS-1 Part 1 sentence). No LLM — fully reproducible for the Part 11 record.
function buildChangeRationale(
  fromTier: string, toTier: string, fromScore: number, toScore: number,
  added: string[], removed: string[],
): string {
  const dir = toScore > fromScore ? "rose" : "fell";
  const parts: string[] = [];
  if (removed.length) parts.push(`resolved: ${removed.join("; ")}`);
  if (added.length) parts.push(`new: ${added.join("; ")}`);
  const why = parts.length ? ` — ${parts.join(" · ")}` : "";
  return `Risk ${dir} ${fromScore} → ${toScore} (${fromTier} → ${toTier})${why}.`;
}

// Raw (non-override) computed risk for a single supplier.
async function computeSupplierRiskRaw(
  supplier: typeof suppliersTable.$inferSelect,
): Promise<{ score: number; tier: string; factors: string[] }> {
  const driver = (await getReviewDrivers([supplier.id])).get(supplier.id) ?? null;
  const inputs = (await getBatchRiskInputs([supplier.id])).get(supplier.id)
    ?? { openNcs: [], allInspections: [], rejectedQualCount: 0 };
  const review = computeReviewFields(
    supplier.requalificationIntervalYears,
    driver?.lastQualifiedDate ?? null,
    driver?.drivingExpiry ?? null,
    driver?.drivingType ?? null,
  );
  const { riskScore, riskTier, riskFactors } = computeRiskScore(supplier, review.reviewStatus, inputs);
  return { score: riskScore, tier: riskTier, factors: riskFactors };
}

async function supersedeOpenDecreases(supplierId: number): Promise<void> {
  await db.update(supplierRiskChangesTable)
    .set({ status: "Superseded", supersededAt: new Date() })
    .where(and(
      eq(supplierRiskChangesTable.supplierId, supplierId),
      eq(supplierRiskChangesTable.status, "Pending"),
      eq(supplierRiskChangesTable.direction, "decrease"),
    ));
}

// Detect a tier change for one supplier and record/apply it per the directional
// hold rule. Idempotent: repeated calls with no change are no-ops.
export async function reconcileSupplierRisk(
  supplier: typeof suppliersTable.$inferSelect,
): Promise<void> {
  // Operator-set tier is a deliberate signed decision — skip the auto-workflow.
  if (supplier.riskTier && TIER_BASELINE_SCORE[supplier.riskTier] !== undefined) return;
  if (supplier.cancelledAt) return;

  const { score, tier, factors } = await computeSupplierRiskRaw(supplier);

  // Baseline: seed the effective tier silently the first time (no review record).
  if (!supplier.reviewedRiskTier) {
    await db.update(suppliersTable).set({
      reviewedRiskTier: tier, reviewedRiskScore: score, reviewedRiskFactors: factors, reviewedRiskTierAt: new Date(),
    }).where(eq(suppliersTable.id, supplier.id));
    return;
  }

  const effTier = supplier.reviewedRiskTier;
  const effRank = tierRank(effTier);
  const curRank = tierRank(tier);
  if (curRank === effRank) {
    // No tier change — clear any stale pending decrease (the drop reversed).
    await supersedeOpenDecreases(supplier.id);
    return;
  }

  const baseFactors = supplier.reviewedRiskFactors ?? [];
  const baseScore = supplier.reviewedRiskScore ?? 0;
  const baseSet = new Set(baseFactors);
  const curSet = new Set(factors);
  const added = factors.filter((f) => !baseSet.has(f));
  const removed = baseFactors.filter((f) => !curSet.has(f));
  const rationale = buildChangeRationale(effTier, tier, baseScore, score, added, removed);

  if (curRank > effRank) {
    // INCREASE — apply immediately; supersede any held decrease; record for ack.
    await supersedeOpenDecreases(supplier.id);
    await db.insert(supplierRiskChangesTable).values({
      supplierId: supplier.id, direction: "increase",
      fromTier: effTier, toTier: tier, fromScore: baseScore, toScore: score,
      rationale, factorsAdded: added, factorsRemoved: removed, status: "Pending",
    });
    await db.update(suppliersTable).set({
      reviewedRiskTier: tier, reviewedRiskScore: score, reviewedRiskFactors: factors, reviewedRiskTierAt: new Date(),
    }).where(eq(suppliersTable.id, supplier.id));
    return;
  }

  // DECREASE — hold. Keep the effective tier; ensure one pending record reflects
  // the current proposed lower tier.
  const [openDecrease] = await db.select().from(supplierRiskChangesTable)
    .where(and(
      eq(supplierRiskChangesTable.supplierId, supplier.id),
      eq(supplierRiskChangesTable.status, "Pending"),
      eq(supplierRiskChangesTable.direction, "decrease"),
    )).orderBy(desc(supplierRiskChangesTable.detectedAt)).limit(1);
  if (openDecrease) {
    if (openDecrease.toTier !== tier) {
      await db.update(supplierRiskChangesTable).set({
        toTier: tier, toScore: score, rationale, factorsAdded: added, factorsRemoved: removed, detectedAt: new Date(),
      }).where(eq(supplierRiskChangesTable.id, openDecrease.id));
    }
    return;
  }
  await db.insert(supplierRiskChangesTable).values({
    supplierId: supplier.id, direction: "decrease",
    fromTier: effTier, toTier: tier, fromScore: baseScore, toScore: score,
    rationale, factorsAdded: added, factorsRemoved: removed, status: "Pending",
  });
}

// Sweep every supplier — the daily scheduled reconcile + one-time boot backfill.
export async function reconcileAllSupplierRisk(): Promise<{ scanned: number }> {
  const rows = await db.select().from(suppliersTable);
  let scanned = 0;
  for (const s of rows) {
    try { await reconcileSupplierRisk(s); scanned++; } catch { /* never let one supplier break the sweep */ }
  }
  return { scanned };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/suppliers", async (req, res) => {
  try {
    const rows = await db.select().from(suppliersTable).orderBy(suppliersTable.supplierName);
    const { type, status } = req.query;
    let result = rows;
    // Session 52.2 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled suppliers (the Cancelled view). Cancel is the no-hard-delete pattern.
    const cancelled = req.query.cancelled === "true";
    result = cancelled
      ? result.filter((r) => (r as { cancelledAt?: unknown }).cancelledAt)
      : result.filter((r) => !(r as { cancelledAt?: unknown }).cancelledAt);
    if (type)   result = result.filter((r) => r.supplierType === type);
    if (status) result = result.filter((r) => r.status === status);

    const ids = result.map((r) => r.id);
    const [driverMap, riskMap, licenseMap] = await Promise.all([
      getReviewDrivers(ids),
      getBatchRiskInputs(ids),
      getLicenseExpiryMap(ids),
    ]);
    res.json(result.map((r) => annotate(r, driverMap.get(r.id) ?? null, riskMap.get(r.id), licenseMap.get(r.id) ?? null)));
  } catch (err) {
    req.log.error({ err }, "Failed to list suppliers");
    res.status(500).json({ error: "Failed to list suppliers" });
  }
});

router.post("/suppliers", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Session 33 (Tier 2 #6) — enforce the conditional license requirement on
    // create. Status defaults to "Pending Review" on the schema side, so a
    // cannabis supplier with no license_number can still be created so long
    // as nobody overrides status to Approved (or similar) up-front.
    const licenseErr = licenseRequirementError(
      body.supplierType as string | undefined,
      (body.status as string | undefined) ?? "Pending Review",
      body.licenseNumber as string | undefined,
    );
    if (licenseErr) { res.status(400).json({ error: licenseErr }); return; }

    // License-record requirement (2026-08-06) — a license-required supplier can't
    // be created directly as "Approved": it has no certificate records yet, so
    // there is nothing to prove a current license on file. Create it as Pending
    // Review, add the license under Approval & Certificates, then approve.
    const desiredStatus = (body.status as string | undefined) ?? "Pending Review";
    if (desiredStatus === "Approved" &&
        isLicenseRecordRequired(body.supplierType as string | undefined, body.licenseNumber as string | undefined)) {
      res.status(400).json({
        error: "A cannabis, laboratory, or licensed supplier needs a current license/certificate (with an expiry date) on file before it can be Approved. Save it as \"Pending Review\", add the license under Approval & Certificates, then approve.",
      });
      return;
    }

    // Session 33 (Tier 2 #9) — riskTier rationale is required on every new
    // supplier. The CreateSupplierDialog defaults riskTier to "Medium" so
    // every new supplier has a tier; that tier needs a documented reason.
    const riskTier = (body.riskTier as string | undefined) ?? "";
    const rationale = (body.riskTierRationale as string | undefined) ?? "";
    if (riskTier && !rationale.trim()) {
      res.status(400).json({
        error: `Risk Tier rationale is required when setting a Risk Tier on a new supplier. Document why you chose ${riskTier}.`,
      });
      return;
    }

    // Stamp the lineage fields server-side so they're never spoofable from
    // the client. Audit log gets a separate entry too.
    const actor = await getOrProvisionCurrentUser(req);
    if (riskTier && rationale.trim()) {
      body.riskTierRationale = rationale.trim();
      body.riskTierSetAt = new Date();
      body.riskTierSetByName = actor?.fullName ?? null;
    }

    // Separation of duties (2026-08-06) — stamp who created the supplier so the
    // PATCH approve-gate can stop that same person from approving their own record.
    body.createdById = actor?.id ?? null;
    body.createdByName = actor?.fullName ?? null;

    const [supplier] = await db.insert(suppliersTable).values(body as typeof suppliersTable.$inferInsert).returning();

    if (riskTier && rationale.trim()) {
      void writeSupplierAuditLog({
        rowId: supplier.id,
        operation: "RISK_TIER_SET",
        changedById: actor?.id ?? null,
        changedByName: actor?.fullName ?? null,
        beforeState: null,
        afterState: { riskTier, rationale: rationale.trim() },
      });
    }

    res.status(201).json(annotate(supplier, null));
  } catch (err) {
    req.log.error({ err }, "Failed to create supplier");
    res.status(500).json({ error: "Failed to create supplier" });
  }
});

router.get("/suppliers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }

    const [driverMap, riskMap, licenseMap] = await Promise.all([
      getReviewDrivers([id]),
      getBatchRiskInputs([id]),
      getLicenseExpiryMap([id]),
    ]);

    res.json(annotate(supplier, driverMap.get(id) ?? null, riskMap.get(id), licenseMap.get(id) ?? null));
  } catch (err) {
    req.log.error({ err }, "Failed to get supplier");
    res.status(500).json({ error: "Failed to get supplier" });
  }
});

// Session 32 — Approved suppliers are frozen. Per QMS review feedback,
// qualification cycle and every other field on an Approved supplier must be
// immutable until the record is explicitly Reopened via the dedicated
// endpoint below. The Reopen action logs a reason to the audit trail and
// flips the status back to "Pending Review" so the operator can edit, then
// re-approve. This satisfies ISO 13485 controlled-change ethos without
// blocking legitimate corrections.
router.patch("/suppliers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);

    const [before] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!before) { res.status(404).json({ error: "Supplier not found" }); return; }
    // Session 52.2 — a cancelled supplier is read-only (Re-open via /uncancel first).
    if ((before as { cancelledAt?: unknown }).cancelledAt) {
      res.status(409).json({ error: "This supplier is cancelled and read-only. Re-open it first (Admin)." }); return;
    }
    // Cancel fields are managed only by /cancel + /uncancel — never a field edit.
    {
      const b = req.body as Record<string, unknown> | undefined;
      // Creator lineage is stamped only at creation — never editable via PATCH.
      if (b) for (const k of ["cancelledAt","cancelledReason","cancelledByName","cancelledByInitials","cancelledMeaning","createdById","createdByName"]) delete b[k];
    }
    if (before.status === "Approved") {
      res.status(409).json({
        error: "This supplier is Approved and is locked for editing. Use POST /suppliers/:id/reopen with a reason to unlock the record for revision (the action is audit-logged).",
      });
      return;
    }

    // Session 33 (Tier 2 #6) — enforce the conditional license requirement on
    // the *post-merge* state, so the operator can't transition a cannabis
    // supplier to (say) Approved without also providing a license number in
    // the same PATCH. Pulls the un-changed fields from `before` and overlays
    // the PATCH body.
    const merged = { ...before, ...(req.body ?? {}) } as Record<string, unknown>;
    const licenseErr = licenseRequirementError(
      merged.supplierType as string | undefined,
      merged.status as string | undefined,
      merged.licenseNumber as string | undefined,
    );
    if (licenseErr) { res.status(400).json({ error: licenseErr }); return; }

    // License-record requirement (2026-08-06) — block the transition to
    // "Approved" unless a current (non-expired) license/certificate is on file.
    // Derived from the supplier's own certificate records, so a filed cert with a
    // future expiry satisfies it regardless of the audit Pass/Fail workflow.
    if ((merged.status as string | undefined) === "Approved") {
      const latestExpiry = (await getLicenseExpiryMap([id])).get(id) ?? null;
      const compliance = licenseComplianceFrom(
        merged.supplierType as string | undefined,
        merged.licenseNumber as string | undefined,
        latestExpiry,
      );
      if (compliance === "missing" || compliance === "expired") {
        res.status(400).json({
          error: compliance === "expired"
            ? "This supplier's license/certificate on file has expired. Add a current license record (with a future expiry) under Approval & Certificates before approving."
            : "This supplier needs a license/certificate with an expiry date on file before it can be Approved. Add it under Approval & Certificates, then approve.",
        });
        return;
      }
      // Separation of duties (2026-08-06) — the person who created a supplier
      // cannot approve their own record; a second person must approve. Only
      // enforced when we know the creator (legacy rows have no creator stamped).
      const creatorId = (before as { createdById?: number | null }).createdById ?? null;
      if (creatorId != null && actor?.id === creatorId) {
        res.status(403).json({
          error: "You created this supplier, so you can't approve it yourself. A different person (Manager/Quality/Admin) must review and approve it — separation of duties.",
        });
        return;
      }
    }

    // Session 33 (Tier 2 #9) — Risk Tier change must come with a fresh
    // rationale. We treat any PATCH body with riskTier !== before.riskTier as
    // a tier change (including setting it for the first time on a legacy row
    // that has no tier yet). The rationale field is required in the same
    // request — operators can't change the tier silently. Audit log captures
    // before/after.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const newTier = body.riskTier as string | undefined;
    const oldTier = before.riskTier;
    const tierChanging = Object.prototype.hasOwnProperty.call(body, "riskTier") && newTier !== oldTier;
    const newRationale = (body.riskTierRationale as string | undefined)?.trim() ?? "";
    if (tierChanging) {
      if (newTier && !newRationale) {
        res.status(400).json({
          error: `Risk Tier rationale is required when changing tier (was "${oldTier ?? "(unset)"}", now "${newTier}"). Document why you're moving the tier.`,
        });
        return;
      }
      // Server stamps lineage; client can't spoof who/when.
      body.riskTierRationale = newRationale || null;
      body.riskTierSetAt = newTier ? new Date() : null;
      body.riskTierSetByName = newTier ? (actor?.fullName ?? null) : null;
    }

    const [supplier] = await db
      .update(suppliersTable)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(suppliersTable.id, id))
      .returning();

    if (tierChanging && supplier) {
      void writeSupplierAuditLog({
        rowId: id,
        operation: oldTier ? "RISK_TIER_CHANGE" : "RISK_TIER_SET",
        changedById: actor?.id ?? null,
        changedByName: actor?.fullName ?? null,
        beforeState: { riskTier: oldTier },
        afterState: { riskTier: newTier ?? null, rationale: newRationale || null },
      });
    }
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }

    // Capture before/after for the audit log. Only diff the fields that were
    // actually included in the PATCH body so the trail doesn't get polluted
    // with `updatedAt` and other noise.
    const changedFields = Object.keys((req.body ?? {}) as Record<string, unknown>);
    const beforeSnap = Object.fromEntries(changedFields.map(k => [k, (before as Record<string, unknown>)[k]]));
    const afterSnap = Object.fromEntries(changedFields.map(k => [k, (supplier as unknown as Record<string, unknown>)[k]]));
    void writeSupplierAuditLog({
      rowId: id,
      operation: "UPDATE",
      changedById: actor?.id ?? null,
      changedByName: actor?.fullName ?? null,
      beforeState: beforeSnap,
      afterState: afterSnap,
    });

    const [driverMap, licenseMap] = await Promise.all([
      getReviewDrivers([id]),
      getLicenseExpiryMap([id]),
    ]);
    res.json(annotate(supplier, driverMap.get(id) ?? null, undefined, licenseMap.get(id) ?? null));
  } catch (err) {
    req.log.error({ err }, "Failed to update supplier");
    res.status(500).json({ error: "Failed to update supplier" });
  }
});

// Session 32 — Reopen an Approved supplier for revision. Requires a reason
// captured to the audit trail. Flips status back to "Pending Review" so the
// operator can then edit the record via the normal PATCH. A subsequent
// approval cycle re-locks it. Originator role logged on the audit row.
router.post("/suppliers/:id/reopen", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason || !reason.trim()) {
      res.status(400).json({ error: "A reason is required to reopen an Approved supplier (audit trail)." });
      return;
    }
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [before] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!before) { res.status(404).json({ error: "Supplier not found" }); return; }
    if (before.status !== "Approved") {
      res.status(409).json({
        error: `Reopen is only valid on Approved suppliers (currently "${before.status}"). The record is already editable.`,
      });
      return;
    }

    const [updated] = await db
      .update(suppliersTable)
      .set({ status: "Pending Review", updatedAt: new Date() })
      .where(and(eq(suppliersTable.id, id), eq(suppliersTable.status, "Approved")))
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Supplier state changed; refresh and try again." });
      return;
    }

    void writeSupplierAuditLog({
      rowId: id,
      operation: "REOPEN",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: { status: "Approved" },
      afterState: { status: "Pending Review", reopenReason: reason.trim(), reopenedBy: actor.fullName },
    });

    const driverMap = await getReviewDrivers([id]);
    res.json(annotate(updated, driverMap.get(id) ?? null));
  } catch (err) {
    req.log.error({ err }, "Failed to reopen supplier");
    res.status(500).json({ error: "Failed to reopen supplier" });
  }
});

// ── Session 52.2 — soft Cancel / Re-open (Part 11) replaces hard DELETE ───────
//
// QMS records are never hard-deleted (the supplier DELETE was the last top-level
// regulated hard delete — see Session52_MTR.md Track C). Cancel retains the row,
// is recoverable (/uncancel, Admin-only), and requires a Manager/Quality/Admin
// actor + rationale + Part 11 e-signature. Distinct from the supplier status
// lifecycle (Active / Deactivated / reopen). Mirrors the Session 52 reference.
const SUPPLIER_CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

router.post("/suppliers/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!SUPPLIER_CANCEL_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Cancelling a record requires Manager, Quality, or Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!before) { res.status(404).json({ error: "Supplier not found" }); return; }
    if ((before as { cancelledAt?: unknown }).cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }

    const [supplier] = await db.update(suppliersTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(suppliersTable.id, id)).returning();
    void writeSupplierAuditLog({
      rowId: id,
      operation: "CANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: supplier as unknown as Record<string, unknown>,
    });
    res.json(supplier);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel supplier");
    res.status(500).json({ error: "Failed to cancel supplier" });
  }
});

// POST /suppliers/:id/uncancel — reverse a Cancel. Admin-ONLY. Part 11 signature
// required. Clears the cancel fields and returns the supplier to active use.
router.post("/suppliers/:id/uncancel", async (req, res) => {
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

    const [before] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!before) { res.status(404).json({ error: "Supplier not found" }); return; }
    if (!(before as { cancelledAt?: unknown }).cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [supplier] = await db.update(suppliersTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(suppliersTable.id, id)).returning();
    void writeSupplierAuditLog({
      rowId: id,
      operation: "UNCANCEL",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: supplier as unknown as Record<string, unknown>,
    });
    res.json(supplier);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel supplier");
    res.status(500).json({ error: "Failed to uncancel supplier" });
  }
});

router.get("/suppliers/:id/risk-history", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }

    const [allNCs, allInspections, allQuals] = await Promise.all([
      db.select({
        severity:  nonConformancesTable.severity,
        createdAt: nonConformancesTable.createdAt,
        closedAt:  nonConformancesTable.closedAt,
      }).from(nonConformancesTable).where(eq(nonConformancesTable.supplierId, id)),

      db.select({
        result:         incomingInspectionsTable.result,
        inspectionDate: incomingInspectionsTable.inspectionDate,
      }).from(incomingInspectionsTable).where(eq(incomingInspectionsTable.supplierId, id)),

      db.select({
        status:       supplierQualificationsTable.status,
        approvalDate: supplierQualificationsTable.approvalDate,
        createdAt:    supplierQualificationsTable.createdAt,
      }).from(supplierQualificationsTable).where(eq(supplierQualificationsTable.supplierId, id)),
    ]);

    // Generate 13 monthly checkpoints (12 months back through today)
    // SRS-1 — each point also carries the contributing factors computeRiskScore
    // already derives, so the client can diff consecutive months and explain in
    // plain language why the score moved. Additive to the point shape (older
    // clients ignore it); the endpoint still returns a plain array.
    const points: { date: string; riskScore: number; riskTier: string; riskFactors: string[] }[] = [];
    const now = new Date();

    for (let i = 12; i >= 0; i--) {
      const cp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const cpStr = facilityDateStr(cp);

      const openNcs = allNCs
        .filter((nc) => {
          const created = new Date(nc.createdAt);
          const closed  = nc.closedAt ? new Date(nc.closedAt) : null;
          return created <= cp && (closed === null || closed > cp);
        })
        .map((nc) => ({ severity: nc.severity }));

      const inspections = allInspections
        .filter((ins) => ins.inspectionDate && new Date(ins.inspectionDate + "T00:00:00Z") <= cp)
        .map((ins) => ({ result: ins.result }));

      const rejectedQualCount = allQuals.filter(
        // SRS-4 — mirror getRiskInputs: "Failed" is the qual failure status
        // (legacy "Rejected" still honored) for the risk-trend history.
        (q) => (q.status === "Failed" || q.status === "Rejected") && new Date(q.createdAt) <= cp,
      ).length;

      const latestApproval = allQuals
        // SQ-3 / SRS-3 — mirror getReviewDrivers: "Passed" is the qual success
        // status (legacy "Approved" still honored) for the risk-trend history.
        .filter((q) => (q.status === "Passed" || q.status === "Approved") && q.approvalDate && new Date(q.approvalDate + "T00:00:00Z") <= cp)
        .sort((a, b) => (b.approvalDate ?? "").localeCompare(a.approvalDate ?? ""))[0];

      const revStatus = reviewStatusAt(supplier.requalificationIntervalYears, latestApproval?.approvalDate ?? null, cp);
      const { riskScore, riskTier, riskFactors } = computeRiskScore(supplier, revStatus, { openNcs, allInspections: inspections, rejectedQualCount });

      points.push({ date: cpStr, riskScore, riskTier, riskFactors });
    }

    res.json(points);
  } catch (err) {
    req.log.error({ err }, "Failed to compute supplier risk history");
    res.status(500).json({ error: "Failed to compute supplier risk history" });
  }
});

// ── SRS-1 Part 2 — rating-change review endpoints ───────────────────────────────

// Change records for one supplier (newest first) — powers the review card.
router.get("/suppliers/:id/risk-changes", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(supplierRiskChangesTable)
      .where(eq(supplierRiskChangesTable.supplierId, id))
      .orderBy(desc(supplierRiskChangesTable.detectedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list supplier risk changes");
    res.status(500).json({ error: "Failed to list supplier risk changes" });
  }
});

// All pending changes across suppliers (for the dashboard review queue/tile).
router.get("/supplier-risk-changes/pending", async (req, res) => {
  try {
    const rows = await db.select({
      id: supplierRiskChangesTable.id,
      supplierId: supplierRiskChangesTable.supplierId,
      supplierName: suppliersTable.supplierName,
      direction: supplierRiskChangesTable.direction,
      fromTier: supplierRiskChangesTable.fromTier,
      toTier: supplierRiskChangesTable.toTier,
      rationale: supplierRiskChangesTable.rationale,
      detectedAt: supplierRiskChangesTable.detectedAt,
    })
      .from(supplierRiskChangesTable)
      .innerJoin(suppliersTable, eq(supplierRiskChangesTable.supplierId, suppliersTable.id))
      .where(eq(supplierRiskChangesTable.status, "Pending"))
      .orderBy(desc(supplierRiskChangesTable.detectedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list pending supplier risk changes");
    res.status(500).json({ error: "Failed to list pending supplier risk changes" });
  }
});

// Review a pending change (Part 11 e-sig). Increase → acknowledge (tier already
// applied). Decrease → approve, which finally lowers the supplier's effective
// tier. Manager / Quality / Admin only; initials must match the signed-in user.
router.post("/supplier-risk-changes/:id/review", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { initials, signingMeaning, signatureMeaning } = (req.body ?? {}) as {
      initials?: string; signingMeaning?: string; signatureMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!SUPPLIER_RISK_REVIEW_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Reviewing a supplier rating change requires Manager / Quality / Admin role. Your role is "${actor.role}".` });
      return;
    }
    if ((actor.initials ?? "").toUpperCase() !== String(initials).trim().toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }
    const [change] = await db.select().from(supplierRiskChangesTable).where(eq(supplierRiskChangesTable.id, id));
    if (!change) { res.status(404).json({ error: "Rating change not found." }); return; }
    if (change.status !== "Pending") {
      res.status(409).json({ error: `This rating change is already ${change.status.toLowerCase()}.` }); return;
    }

    // A held decrease finally lowers the supplier's effective tier on approval.
    if (change.direction === "decrease") {
      const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, change.supplierId));
      const fresh = supplier ? await computeSupplierRiskRaw(supplier) : { score: change.toScore, factors: change.factorsRemoved ?? [] };
      await db.update(suppliersTable).set({
        reviewedRiskTier: change.toTier,
        reviewedRiskScore: change.toScore,
        reviewedRiskFactors: fresh.factors,
        reviewedRiskTierAt: new Date(),
      }).where(eq(suppliersTable.id, change.supplierId));
    }

    const [updated] = await db.update(supplierRiskChangesTable).set({
      status: "Reviewed",
      reviewedByUserId: actor.id,
      reviewedByName: actor.fullName,
      reviewedByInitials: initials,
      reviewedMeaning: meaning,
      reviewedAt: new Date(),
    }).where(eq(supplierRiskChangesTable.id, id)).returning();

    void writeSupplierAuditLog({
      rowId: change.supplierId,
      operation: change.direction === "decrease" ? "APPROVE_RISK_DECREASE" : "ACKNOWLEDGE_RISK_INCREASE",
      changedById: actor.id,
      changedByName: actor.fullName,
      beforeState: change as unknown as Record<string, unknown>,
      afterState: updated as unknown as Record<string, unknown>,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to review supplier risk change");
    res.status(500).json({ error: "Failed to review supplier risk change" });
  }
});

router.get("/suppliers/:id/attachments", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const attachments = await db.select().from(supplierAttachmentsTable).where(eq(supplierAttachmentsTable.supplierId, id));
    res.json(attachments);
  } catch (err) {
    req.log.error({ err }, "Failed to list supplier attachments");
    res.status(500).json({ error: "Failed to list supplier attachments" });
  }
});

router.post("/suppliers/:id/attachments", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [attachment] = await db.insert(supplierAttachmentsTable).values({ ...req.body, supplierId: id }).returning();
    res.status(201).json(attachment);
  } catch (err) {
    req.log.error({ err }, "Failed to create supplier attachment");
    res.status(500).json({ error: "Failed to create supplier attachment" });
  }
});

router.delete("/supplier-attachments/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(supplierAttachmentsTable).where(eq(supplierAttachmentsTable.id, id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete supplier attachment");
    res.status(500).json({ error: "Failed to delete supplier attachment" });
  }
});

export default router;
