import { Resend } from "resend";
import { db } from "@workspace/db";
import {
  nonConformancesTable,
  correctiveActionsTable,
  complaintsTable,
  fieldActionsTable,
  batchRecordsTable,
  batchTestingTable,
  capasTable,
  capaActionItemsTable,
  digestSettingsTable,
  suppliersTable,
  supplierQualificationsTable,
} from "@workspace/db";
import { ne, lt, gte, and, lte, eq, sql, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { listInventoryView } from "../lib/inventoryView";
import { facilityDateStr } from "../lib/facilityDate";

function getResend(): Resend | null {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return null;
  return new Resend(key);
}

function batchStateLabel(s: string) {
  const map: Record<string, string> = {
    in_production: "In Production",
    in_inventory_untested: "Inventory (Untested)",
    testing_in_progress: "Testing In Progress",
    passed_awaiting_packaging: "Passed — Awaiting Packaging",
    released_to_inventory: "Released to Inventory",
    finished_goods: "Finished Goods",
    failed: "Failed",
    on_hold: "On Hold",
    destroyed: "Destroyed",
  };
  return map[s] ?? s;
}

function stateColor(s: string) {
  if (s === "in_production") return "#2563eb";
  if (s === "testing_in_progress") return "#4f46e5";
  if (s === "passed_awaiting_packaging") return "#d97706";
  if (s === "released_to_inventory" || s === "finished_goods") return "#16a34a";
  if (s === "on_hold") return "#ea580c";
  if (s === "failed" || s === "destroyed") return "#dc2626";
  return "#64748b";
}

function severityColor(s: string) {
  if (s === "Critical") return "#dc2626";
  if (s === "Major" || s === "High") return "#ea580c";
  if (s === "Minor" || s === "Medium") return "#ca8a04";
  return "#64748b";
}

// Format a date string (YYYY-MM-DD) for display, with days-until label
function fmtDue(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffMs = d.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  const formatted = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (diffDays === 0) return `${formatted} <strong style="color:#dc2626;">(today)</strong>`;
  if (diffDays === 1) return `${formatted} <strong style="color:#ea580c;">(tomorrow)</strong>`;
  if (diffDays < 0) return `${formatted} <strong style="color:#dc2626;">(${Math.abs(diffDays)}d overdue)</strong>`;
  return `${formatted} <span style="color:#64748b;">(in ${diffDays}d)</span>`;
}

function emailWrapper(title: string, subtitle: string, body: string, companyName: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;max-width:640px;width:100%;">
        <!-- Header -->
        <tr><td style="background:#16a34a;padding:24px 32px;">
          <p style="margin:0;color:#dcfce7;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">CannaQMS · ${companyName}</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">${title}</h1>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:13px;">${subtitle}</p>
          <p style="margin:4px 0 0;color:#86efac;font-size:12px;">${today}</p>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:28px 32px;">${body}</td></tr>
        <!-- Footer -->
        <tr><td style="background:#f1f5f9;padding:16px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:11px;">This is an automated weekly snapshot from CannaQMS. Do not reply to this email. Log in to review and action items.</p>
          <p style="margin:4px 0 0;color:#94a3b8;font-size:11px;">Michigan Cannabis Regulatory Agency compliance system · 21 CFR Part 11 compliant</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function sectionHeader(title: string, count: number, alert = false) {
  const bg = alert && count > 0 ? "#fef2f2" : "#f8fafc";
  const border = alert && count > 0 ? "#fecaca" : "#e2e8f0";
  const color = alert && count > 0 ? "#dc2626" : "#0f172a";
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;">
    <tr><td style="background:${bg};border:1px solid ${border};border-radius:6px;padding:10px 14px;">
      <span style="font-size:14px;font-weight:700;color:${color};">${title}</span>
      <span style="margin-left:8px;background:${alert && count > 0 ? "#dc2626" : "#64748b"};color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;">${count}</span>
    </td></tr>
  </table>`;
}

function proactiveSectionHeader(title: string, count: number, accent: "green" | "amber" | "red") {
  const styles: Record<"green" | "amber" | "red", { bg: string; border: string; color: string; badge: string }> = {
    green:  { bg: "#f0fdf4", border: "#bbf7d0", color: "#15803d", badge: "#16a34a" },
    amber:  { bg: "#fffbeb", border: "#fde68a", color: "#92400e", badge: "#d97706" },
    red:    { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", badge: "#dc2626" },
  };
  const s = styles[accent];
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;">
    <tr><td style="background:${s.bg};border:1px solid ${s.border};border-radius:6px;padding:10px 14px;">
      <span style="font-size:14px;font-weight:700;color:${s.color};">${title}</span>
      <span style="margin-left:8px;background:${s.badge};color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;">${count}</span>
    </td></tr>
  </table>`;
}

function emptyRow(msg: string) {
  return `<p style="color:#64748b;font-size:13px;padding:8px 0 16px;margin:0;">${msg}</p>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />`;
}

// ── Date window helpers ───────────────────────────────────────────────────────

function todayStr(): string {
  return facilityDateStr();
}

function plusDaysStr(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return facilityDateStr(d);
}

function minusDaysDate(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Fetch all digest data ─────────────────────────────────────────────────────

async function fetchDigestData() {
  const today = todayStr();
  const week  = plusDaysStr(7);
  const sevenDaysAgo = minusDaysDate(7);

  const [
    openNCs, openComplaints, openFAs,
    allBatches, pendingTests, allInventory,
    // New this week: adverse events & NCs
    newAdverseEvents, newNCs,
    // Proactive: due in next 7 days
    ncActionsDueThisWeek, capaActionsDueThisWeek, capaEffDueThisWeek,
    // Reactive: overdue
    ncActionsOverdue, capaActionsOverdue, capaEffOverdue,
  ] = await Promise.all([
    db.select().from(nonConformancesTable).where(ne(nonConformancesTable.status, "Closed")),
    db.select().from(complaintsTable).where(ne(complaintsTable.status, "Closed")),
    db.select().from(fieldActionsTable).where(ne(fieldActionsTable.status, "Closed")),
    db.select().from(batchRecordsTable),
    db.select().from(batchTestingTable).where(sql`${batchTestingTable.testResult} = 'Pending'`),
    // Session 79 (Step 2) — read the same shared lot-ledger view the Inventory
    // screen uses, so the digest's stock levels / low-stock can't drift from it.
    listInventoryView(),
    // Adverse event complaints opened in the past 7 days
    db.select({
      id: complaintsTable.id,
      complaintNumber: complaintsTable.complaintNumber,
      complaintType: complaintsTable.complaintType,
      severity: complaintsTable.severity,
      status: complaintsTable.status,
      receivedDate: complaintsTable.receivedDate,
      createdAt: complaintsTable.createdAt,
    }).from(complaintsTable).where(
      and(
        sql`${complaintsTable.complaintType} = 'Adverse Event'`,
        gte(complaintsTable.createdAt, sevenDaysAgo),
      )
    ),
    // NCs opened in the past 7 days
    db.select({
      id: nonConformancesTable.id,
      ncNumber: nonConformancesTable.ncNumber,
      title: nonConformancesTable.title,
      severity: nonConformancesTable.severity,
      status: nonConformancesTable.status,
      source: nonConformancesTable.source,
      createdAt: nonConformancesTable.createdAt,
    }).from(nonConformancesTable).where(
      gte(nonConformancesTable.createdAt, sevenDaysAgo)
    ),
    // NC corrective actions due this week
    db.select({
      id: correctiveActionsTable.id,
      ncId: correctiveActionsTable.ncId,
      actionDescription: correctiveActionsTable.actionDescription,
      assignedToName: correctiveActionsTable.assignedToName,
      dueDate: correctiveActionsTable.dueDate,
      status: correctiveActionsTable.status,
    }).from(correctiveActionsTable).where(
      and(
        ne(correctiveActionsTable.status, "Completed"),
        gte(correctiveActionsTable.dueDate, today),
        lte(correctiveActionsTable.dueDate, week),
      )
    ),
    // CAPA action items due this week
    db.select().from(capaActionItemsTable).where(
      and(
        ne(capaActionItemsTable.status, "Completed"),
        gte(capaActionItemsTable.dueDate, today),
        lte(capaActionItemsTable.dueDate, week),
      )
    ),
    // CAPA effectiveness checks due this week
    db.select().from(capasTable).where(
      and(
        ne(capasTable.status, "Closed"),
        gte(capasTable.effectivenessCheckDue, today),
        lte(capasTable.effectivenessCheckDue, week),
      )
    ),
    // NC corrective actions overdue
    db.select({
      id: correctiveActionsTable.id,
      ncId: correctiveActionsTable.ncId,
      actionDescription: correctiveActionsTable.actionDescription,
      assignedToName: correctiveActionsTable.assignedToName,
      dueDate: correctiveActionsTable.dueDate,
      status: correctiveActionsTable.status,
    }).from(correctiveActionsTable).where(
      and(ne(correctiveActionsTable.status, "Completed"), lt(correctiveActionsTable.dueDate, today))
    ),
    // CAPA action items overdue
    db.select().from(capaActionItemsTable).where(
      and(ne(capaActionItemsTable.status, "Completed"), lt(capaActionItemsTable.dueDate, today))
    ),
    // CAPA effectiveness checks overdue
    db.select().from(capasTable).where(
      and(ne(capasTable.status, "Closed"), lt(capasTable.effectivenessCheckDue, today))
    ),
  ]);

  const lowStock = allInventory.filter(
    (i) => i.reorderPoint != null && i.quantity <= (i.reorderPoint ?? 0)
  );

  const batchStatusMap: Record<string, typeof allBatches> = {};
  for (const b of allBatches) {
    if (!batchStatusMap[b.status]) batchStatusMap[b.status] = [];
    batchStatusMap[b.status].push(b);
  }

  return {
    openNCs, openComplaints, openFAs,
    allBatches, pendingTests, allInventory, lowStock, batchStatusMap,
    newAdverseEvents, newNCs,
    ncActionsDueThisWeek, capaActionsDueThisWeek, capaEffDueThisWeek,
    ncActionsOverdue, capaActionsOverdue, capaEffOverdue,
  };
}

// ── Fetch supplier re-qualification data ──────────────────────────────────────

type SupplierRequalRow = {
  id: number;
  supplierName: string;
  supplierType: string;
  requalificationIntervalYears: number;
  lastQualifiedDate: string | null;
  nextReviewDue: string | null;
  daysUntilDue: number | null;
  reviewStatus: "overdue" | "due-soon" | "never-qualified";
};

async function fetchSupplierRequalData(): Promise<{
  overdue: SupplierRequalRow[];
  dueSoon: SupplierRequalRow[];
}> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const ninetyDaysOut = new Date(today);
  ninetyDaysOut.setUTCDate(ninetyDaysOut.getUTCDate() + 90);

  // Get all suppliers
  const suppliers = await db
    .select({
      id: suppliersTable.id,
      supplierName: suppliersTable.supplierName,
      supplierType: suppliersTable.supplierType,
      requalificationIntervalYears: suppliersTable.requalificationIntervalYears,
    })
    .from(suppliersTable)
    .orderBy(suppliersTable.supplierName);

  if (suppliers.length === 0) return { overdue: [], dueSoon: [] };

  // Get the most recent approved qualification date per supplier
  const qualRows = await db
    .select({
      supplierId: supplierQualificationsTable.supplierId,
      approvalDate: supplierQualificationsTable.approvalDate,
    })
    .from(supplierQualificationsTable)
    .where(eq(supplierQualificationsTable.status, "Approved"))
    .orderBy(desc(supplierQualificationsTable.approvalDate));

  const latestApproval = new Map<number, string>();
  for (const row of qualRows) {
    if (!latestApproval.has(row.supplierId) && row.approvalDate) {
      latestApproval.set(row.supplierId, row.approvalDate);
    }
  }

  const overdue: SupplierRequalRow[] = [];
  const dueSoon: SupplierRequalRow[] = [];

  for (const s of suppliers) {
    const lastQualifiedDate = latestApproval.get(s.id) ?? null;

    if (!lastQualifiedDate) {
      // Never qualified — flag as overdue so it appears in the email
      overdue.push({
        ...s,
        lastQualifiedDate: null,
        nextReviewDue: null,
        daysUntilDue: null,
        reviewStatus: "never-qualified",
      });
      continue;
    }

    const last = new Date(lastQualifiedDate + "T00:00:00Z");
    const due  = new Date(last);
    due.setUTCFullYear(due.getUTCFullYear() + s.requalificationIntervalYears);
    const nextReviewDue = facilityDateStr(due);
    const diffMs   = due.getTime() - today.getTime();
    const diffDays = Math.ceil(diffMs / 86_400_000);

    if (diffDays < 0) {
      overdue.push({ ...s, lastQualifiedDate, nextReviewDue, daysUntilDue: diffDays, reviewStatus: "overdue" });
    } else if (due <= ninetyDaysOut) {
      dueSoon.push({ ...s, lastQualifiedDate, nextReviewDue, daysUntilDue: diffDays, reviewStatus: "due-soon" });
    }
  }

  // Sort: most overdue first, then soonest due first for due-soon
  overdue.sort((a, b) => (a.daysUntilDue ?? -9999) - (b.daysUntilDue ?? -9999));
  dueSoon.sort((a, b) => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0));

  return { overdue, dueSoon };
}

// ── Fetch CAPA numbers for action items ───────────────────────────────────────

async function enrichActionItemsWithCapaNumber(
  items: { capaId: number; id: number; actionDescription: string; dueDate: string | null; assignedToName: string | null; sequenceNumber: number }[]
): Promise<(typeof items[number] & { capaNumber: string })[]> {
  if (items.length === 0) return [];
  const ids = [...new Set(items.map((i) => i.capaId))];
  const capas = await db
    .select({ id: capasTable.id, capaNumber: capasTable.capaNumber })
    .from(capasTable)
    .where(sql`${capasTable.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`);
  const map = Object.fromEntries(capas.map((c) => [c.id, c.capaNumber]));
  return items.map((i) => ({ ...i, capaNumber: map[i.capaId] ?? `CAPA-${i.capaId}` }));
}

// ── Enrich NC corrective actions with NC number ───────────────────────────────

async function enrichNcActionsWithNcNumber(
  items: { id: number; ncId: number; actionDescription: string; dueDate: string | null; assignedToName: string | null; status: string }[]
): Promise<(typeof items[number] & { ncNumber: string })[]> {
  if (items.length === 0) return [];
  const ids = [...new Set(items.map((i) => i.ncId))];
  const ncs = await db
    .select({ id: nonConformancesTable.id, ncNumber: nonConformancesTable.ncNumber })
    .from(nonConformancesTable)
    .where(sql`${nonConformancesTable.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`);
  const map = Object.fromEntries(ncs.map((n) => [n.id, n.ncNumber]));
  return items.map((i) => ({ ...i, ncNumber: map[i.ncId] ?? `NC-${i.ncId}` }));
}

// ── Build weekly compliance snapshot HTML ─────────────────────────────────────

export async function buildComplianceDigest(companyName: string): Promise<string> {
  const [digestData, supplierRequalData] = await Promise.all([
    fetchDigestData(),
    fetchSupplierRequalData(),
  ]);

  const {
    openNCs, openComplaints, openFAs, allBatches, pendingTests, batchStatusMap,
    newAdverseEvents, newNCs,
    ncActionsDueThisWeek, capaActionsDueThisWeek, capaEffDueThisWeek,
    ncActionsOverdue, capaActionsOverdue, capaEffOverdue,
  } = digestData;

  const [enrichedDueCapa, enrichedOverdueCapa, enrichedDueNc, enrichedOverdueNc] =
    await Promise.all([
      enrichActionItemsWithCapaNumber(capaActionsDueThisWeek as Parameters<typeof enrichActionItemsWithCapaNumber>[0]),
      enrichActionItemsWithCapaNumber(capaActionsOverdue as Parameters<typeof enrichActionItemsWithCapaNumber>[0]),
      enrichNcActionsWithNcNumber(ncActionsDueThisWeek),
      enrichNcActionsWithNcNumber(ncActionsOverdue),
    ]);

  const critNCs        = openNCs.filter((n) => n.severity === "Critical");
  const flaggedBatches = allBatches.filter((b) => b.status === "failed" || b.status === "on_hold");

  const totalDueThisWeek = enrichedDueNc.length + enrichedDueCapa.length + capaEffDueThisWeek.length;
  const totalOverdue     = enrichedOverdueNc.length + enrichedOverdueCapa.length + capaEffOverdue.length;

  let body = "";

  const { overdue: suppliersOverdue, dueSoon: suppliersDueSoon } = supplierRequalData;

  // ── Top-level alert banner ──
  const hasCritical = critNCs.length > 0 || openFAs.length > 0 || totalOverdue > 0 || suppliersOverdue.length > 0;
  if (hasCritical) {
    body += `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:14px 16px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#dc2626;">⚠ Items Requiring Immediate Attention</p>
      <ul style="margin:0;padding-left:18px;color:#991b1b;font-size:13px;line-height:1.7;">
        ${totalOverdue > 0 ? `<li>${totalOverdue} compliance action item${totalOverdue > 1 ? "s are" : " is"} past due date</li>` : ""}
        ${suppliersOverdue.length > 0 ? `<li>${suppliersOverdue.length} supplier${suppliersOverdue.length > 1 ? "s are" : " is"} overdue for re-qualification (ISO 13485:2016 §7.4)</li>` : ""}
        ${critNCs.length > 0 ? `<li>${critNCs.length} Critical Non-Conformance${critNCs.length > 1 ? "s" : ""} open</li>` : ""}
        ${openFAs.length > 0 ? `<li>${openFAs.length} Active Field Action${openFAs.length > 1 ? "s" : ""} — CRA notification obligations may apply (R 420.209)</li>` : ""}
      </ul>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 0 — NEW THIS WEEK (adverse events & NCs opened in last 7 days)
  // ════════════════════════════════════════════════════════════════════════════
  const newThisWeekCount = newAdverseEvents.length + newNCs.length;
  body += proactiveSectionHeader("🆕 New This Week", newThisWeekCount, newThisWeekCount === 0 ? "green" : "red");

  if (newThisWeekCount === 0) {
    body += emptyRow("✓ No new adverse event complaints or non-conformances opened this week.");
  } else {
    if (newAdverseEvents.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#991b1b;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">Adverse Event Complaints</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fef2f2;">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">CMP #</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Severity</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Status</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Received</th>
        </tr>
        ${newAdverseEvents.map((c) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#dc2626;font-weight:600;border-bottom:1px solid #fef2f2;">${c.complaintNumber}</td>
          <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #fef2f2;"><span style="color:${severityColor(c.severity)};font-weight:600;">${c.severity}</span></td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fef2f2;">${c.status}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #fef2f2;">${c.receivedDate ?? facilityDateStr(c.createdAt)}</td>
        </tr>`).join("")}
      </table>
      <p style="font-size:11px;color:#991b1b;margin:0 0 12px;padding:6px 8px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:2px;">
        ⚠ Adverse events may trigger CRA 24-hour reporting obligations under R 420.209. Verify notification status for each item.
      </p>`;
    }

    if (newNCs.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">Non-Conformances</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fffbeb;">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">NC #</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Title</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Severity</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Source</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Opened</th>
        </tr>
        ${newNCs.map((n) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${n.ncNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${n.title.slice(0, 50)}${n.title.length > 50 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;"><span style="color:${severityColor(n.severity)};font-weight:600;">${n.severity}</span></td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${n.source}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${facilityDateStr(n.createdAt)}</td>
        </tr>`).join("")}
      </table>`;
    }
  }

  body += divider();

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 1 — DUE THIS WEEK (proactive)
  // ════════════════════════════════════════════════════════════════════════════
  body += proactiveSectionHeader("📅 Due in the Next 7 Days", totalDueThisWeek, totalDueThisWeek === 0 ? "green" : "amber");

  if (totalDueThisWeek === 0) {
    body += emptyRow("✓ No compliance deadlines in the next 7 days. Great work staying ahead.");
  } else {
    // CAPA action items due this week
    if (enrichedDueCapa.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">CAPA Action Items</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fffbeb;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">CAPA #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Action</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Assigned To</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Due</th></tr>
        ${enrichedDueCapa.map((a) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${a.capaNumber} #${a.sequenceNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${a.actionDescription.slice(0, 60)}${a.actionDescription.length > 60 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${a.assignedToName ?? "—"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;">${a.dueDate ? fmtDue(a.dueDate) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }

    // CAPA effectiveness checks due this week
    if (capaEffDueThisWeek.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">CAPA Effectiveness Checks</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fffbeb;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">CAPA #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Title</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Status</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Check Due</th></tr>
        ${capaEffDueThisWeek.map((c) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${c.capaNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${c.title.slice(0, 55)}${c.title.length > 55 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${c.status}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;">${c.effectivenessCheckDue ? fmtDue(c.effectivenessCheckDue) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }

    // NC corrective actions due this week
    if (enrichedDueNc.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">NC Corrective Actions</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fffbeb;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">NC #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Action</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Assigned To</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Due</th></tr>
        ${enrichedDueNc.map((a) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${a.ncNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${a.actionDescription.slice(0, 60)}${a.actionDescription.length > 60 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${a.assignedToName ?? "—"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;">${a.dueDate ? fmtDue(a.dueDate) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }
  }

  body += divider();

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 2 — ALREADY OVERDUE (reactive, urgent)
  // ════════════════════════════════════════════════════════════════════════════
  body += proactiveSectionHeader("🔴 Already Overdue", totalOverdue, totalOverdue === 0 ? "green" : "red");

  if (totalOverdue === 0) {
    body += emptyRow("✓ Nothing overdue. Keep it up.");
  } else {
    if (enrichedOverdueCapa.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#991b1b;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">CAPA Action Items (Overdue)</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fef2f2;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">CAPA #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Action</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Assigned To</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Was Due</th></tr>
        ${enrichedOverdueCapa.map((a) => `<tr style="background:#fef9f9;">
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#dc2626;border-bottom:1px solid #fef2f2;font-weight:600;">${a.capaNumber} #${a.sequenceNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #fef2f2;">${a.actionDescription.slice(0, 60)}${a.actionDescription.length > 60 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fef2f2;">${a.assignedToName ?? "—"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #fef2f2;">${a.dueDate ? fmtDue(a.dueDate) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }

    if (capaEffOverdue.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#991b1b;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">CAPA Effectiveness Checks (Overdue)</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fef2f2;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">CAPA #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Title</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Was Due</th></tr>
        ${capaEffOverdue.map((c) => `<tr style="background:#fef9f9;">
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#dc2626;border-bottom:1px solid #fef2f2;font-weight:600;">${c.capaNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #fef2f2;">${c.title.slice(0, 55)}${c.title.length > 55 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #fef2f2;">${c.effectivenessCheckDue ? fmtDue(c.effectivenessCheckDue) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }

    if (enrichedOverdueNc.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#991b1b;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">NC Corrective Actions (Overdue)</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fef2f2;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">NC #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Action</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Assigned To</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Was Due</th></tr>
        ${enrichedOverdueNc.map((a) => `<tr style="background:#fef9f9;">
          <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#dc2626;border-bottom:1px solid #fef2f2;font-weight:600;">${a.ncNumber}</td>
          <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #fef2f2;">${a.actionDescription.slice(0, 60)}${a.actionDescription.length > 60 ? "…" : ""}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fef2f2;">${a.assignedToName ?? "—"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #fef2f2;">${a.dueDate ? fmtDue(a.dueDate) : "—"}</td>
        </tr>`).join("")}
      </table>`;
    }
  }

  body += divider();

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 3 — OPEN ITEMS STATUS (existing reactive summary)
  // ════════════════════════════════════════════════════════════════════════════
  body += sectionHeader("Open Non-Conformances", openNCs.length, true);
  if (openNCs.length === 0) {
    body += emptyRow("✓ No open non-conformances.");
  } else {
    body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
      <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">NC #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Title</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Severity</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th></tr>
      ${openNCs.map((n) => `<tr>
        <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${n.ncNumber}</td>
        <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${n.title}</td>
        <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;"><span style="color:${severityColor(n.severity)};font-weight:600;">${n.severity}</span></td>
        <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${n.status}</td>
      </tr>`).join("")}
    </table>`;
  }

  body += sectionHeader("Open Complaints", openComplaints.length, openComplaints.some((c) => c.severity === "Critical" || c.complaintType === "Adverse Event"));
  if (openComplaints.length === 0) {
    body += emptyRow("✓ No open complaints.");
  } else {
    body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
      <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">CMP #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Type</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Severity</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th></tr>
      ${openComplaints.map((c) => `<tr>
        <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${c.complaintNumber}</td>
        <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${c.complaintType}</td>
        <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;"><span style="color:${severityColor(c.severity)};font-weight:600;">${c.severity}</span></td>
        <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${c.status}</td>
      </tr>`).join("")}
    </table>`;
  }

  body += sectionHeader("Active Field Actions", openFAs.length, openFAs.length > 0);
  if (openFAs.length === 0) {
    body += emptyRow("✓ No active field actions.");
  } else {
    body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
      <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">FA #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Type</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Title</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th></tr>
      ${openFAs.map((f) => `<tr>
        <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${f.faNumber}</td>
        <td style="padding:6px 8px;font-size:11px;color:#dc2626;font-weight:600;border-bottom:1px solid #f1f5f9;">${f.actionType}</td>
        <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${f.title.slice(0, 55)}${f.title.length > 55 ? "…" : ""}</td>
        <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${f.status}</td>
      </tr>`).join("")}
    </table>`;
  }

  body += sectionHeader("Flagged Batch Records", flaggedBatches.length, flaggedBatches.length > 0);
  if (flaggedBatches.length === 0) {
    body += emptyRow("✓ No failed or on-hold batches.");
  } else {
    body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
      <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Batch #</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Product</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">State</th></tr>
      ${flaggedBatches.map((b) => `<tr>
        <td style="padding:6px 8px;font-size:12px;font-family:monospace;color:#2563eb;border-bottom:1px solid #f1f5f9;">${b.batchNumber}</td>
        <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${b.productName}</td>
        <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;"><span style="color:${stateColor(b.status)};font-weight:600;">${batchStateLabel(b.status)}</span></td>
      </tr>`).join("")}
    </table>`;
  }

  body += sectionHeader("Pending Lab Results", pendingTests.length, false);
  if (pendingTests.length === 0) {
    body += emptyRow("✓ No pending test submissions.");
  } else {
    body += `<p style="font-size:12px;color:#64748b;margin:6px 0 20px;">${pendingTests.length} batch test submission${pendingTests.length > 1 ? "s" : ""} awaiting results from the laboratory.</p>`;
  }

  body += divider();

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION — SUPPLIER RE-QUALIFICATION
  // Shows overdue + due within 90 days; ISO 13485:2016 §7.4
  // ════════════════════════════════════════════════════════════════════════════
  const totalSupplierIssues = suppliersOverdue.length + suppliersDueSoon.length;
  body += proactiveSectionHeader(
    "🔄 Supplier Re-qualification Reviews",
    totalSupplierIssues,
    totalSupplierIssues === 0 ? "green" : suppliersOverdue.length > 0 ? "red" : "amber",
  );

  if (totalSupplierIssues === 0) {
    body += emptyRow("✓ All suppliers are current on re-qualification. No reviews due within 90 days.");
  } else {
    if (suppliersOverdue.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#991b1b;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">Overdue Re-qualification</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fef2f2;">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Supplier</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Type</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Last Qualified</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Was Due</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fecaca;">Cycle</th>
        </tr>
        ${suppliersOverdue.map((s) => `<tr style="background:#fef9f9;">
          <td style="padding:6px 8px;font-size:12px;font-weight:600;color:#0f172a;border-bottom:1px solid #fef2f2;">${s.supplierName}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fef2f2;">${s.supplierType}</td>
          <td style="padding:6px 8px;font-size:12px;color:#64748b;border-bottom:1px solid #fef2f2;">${s.lastQualifiedDate ?? "<em>Never</em>"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #fef2f2;">${s.nextReviewDue ? fmtDue(s.nextReviewDue) : "<strong style=\"color:#dc2626;\">No qualification on record</strong>"}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fef2f2;">Every ${s.requalificationIntervalYears} yr${s.requalificationIntervalYears > 1 ? "s" : ""}</td>
        </tr>`).join("")}
      </table>
      <p style="font-size:11px;color:#991b1b;margin:0 0 12px;padding:6px 8px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:2px;">
        ⚠ Overdue re-qualification may constitute a supplier approval lapse under <strong>ISO 13485:2016 §7.4.1</strong> and <strong>Michigan CRA R 420</strong>. Schedule assessments immediately.
      </p>`;
    }

    if (suppliersDueSoon.length > 0) {
      body += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">Due Within 90 Days</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-collapse:collapse;">
        <tr style="background:#fffbeb;">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Supplier</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Type</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Last Qualified</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Review Due</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #fde68a;">Cycle</th>
        </tr>
        ${suppliersDueSoon.map((s) => `<tr>
          <td style="padding:6px 8px;font-size:12px;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;">${s.supplierName}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${s.supplierType}</td>
          <td style="padding:6px 8px;font-size:12px;color:#64748b;border-bottom:1px solid #f1f5f9;">${s.lastQualifiedDate ?? "—"}</td>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;">${s.nextReviewDue ? fmtDue(s.nextReviewDue) : "—"}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">Every ${s.requalificationIntervalYears} yr${s.requalificationIntervalYears > 1 ? "s" : ""}</td>
        </tr>`).join("")}
      </table>`;
    }
  }

  const weekStr = plusDaysStr(7).slice(5).replace("-", "/");
  return emailWrapper(
    "Weekly Compliance Snapshot",
    `Upcoming deadlines & open items through ${weekStr}`,
    body,
    companyName
  );
}

// ── Build inventory digest HTML ───────────────────────────────────────────────

export async function buildInventoryDigest(companyName: string): Promise<string> {
  const { allBatches, pendingTests, allInventory, lowStock, batchStatusMap } =
    await fetchDigestData();

  let body = "";

  if (lowStock.length > 0) {
    body += `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:14px 16px;margin-bottom:20px;">
      <p style="margin:0;font-size:13px;font-weight:700;color:#c2410c;">⚠ Low Stock Alert — ${lowStock.length} item${lowStock.length > 1 ? "s" : ""} at or below reorder point</p>
    </div>`;
  }

  body += sectionHeader("Inventory Levels", allInventory.length, lowStock.length > 0);
  body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
    <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Item</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Type</th><th style="text-align:right;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Qty</th><th style="text-align:right;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Reorder At</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th></tr>
    ${allInventory.map((item) => {
      const atReorder = item.reorderPoint != null && item.quantity <= (item.reorderPoint ?? 0);
      const bg = atReorder ? "#fff7ed" : "transparent";
      return `<tr style="background:${bg};">
        <td style="padding:6px 8px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;font-weight:${atReorder ? "600" : "400"};">${item.itemName}</td>
        <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${item.itemType}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;color:#0f172a;border-bottom:1px solid #f1f5f9;font-family:monospace;">${item.quantity.toLocaleString()} ${item.unitOfMeasure}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;color:#64748b;border-bottom:1px solid #f1f5f9;font-family:monospace;">${item.reorderPoint != null ? `${item.reorderPoint.toLocaleString()} ${item.unitOfMeasure}` : "—"}</td>
        <td style="padding:6px 8px;font-size:11px;border-bottom:1px solid #f1f5f9;">${atReorder ? '<span style="color:#c2410c;font-weight:700;">⚠ Reorder</span>' : '<span style="color:#16a34a;">OK</span>'}</td>
      </tr>`;
    }).join("")}
  </table>`;

  const stateOrder = ["in_production", "testing_in_progress", "passed_awaiting_packaging", "on_hold", "failed", "released_to_inventory", "finished_goods", "in_inventory_untested", "destroyed"];
  const activeStates = stateOrder.filter((s) => batchStatusMap[s]?.length);

  body += sectionHeader("Batch Record Status", allBatches.length, false);
  if (allBatches.length === 0) {
    body += emptyRow("No batch records found.");
  } else {
    body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-collapse:collapse;">
      <tr style="background:#f8fafc;"><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">State</th><th style="text-align:right;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Count</th><th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Batches</th></tr>
      ${activeStates.map((s) => {
        const batches = batchStatusMap[s] ?? [];
        return `<tr>
          <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;"><span style="color:${stateColor(s)};font-weight:600;">${batchStateLabel(s)}</span></td>
          <td style="padding:6px 8px;font-size:12px;text-align:right;color:#0f172a;border-bottom:1px solid #f1f5f9;font-weight:700;">${batches.length}</td>
          <td style="padding:6px 8px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9;">${batches.map((b) => b.batchNumber).join(", ")}</td>
        </tr>`;
      }).join("")}
    </table>`;
  }

  body += sectionHeader("Lab Testing Status", pendingTests.length, pendingTests.length > 0);
  if (pendingTests.length === 0) {
    body += emptyRow("✓ No pending test results.");
  } else {
    body += `<p style="font-size:12px;color:#92400e;margin:6px 0 4px;font-weight:600;">${pendingTests.length} test submission${pendingTests.length > 1 ? "s" : ""} awaiting COA from laboratory:</p>`;
    body += `<ul style="margin:4px 0 20px;padding-left:18px;font-size:12px;color:#64748b;line-height:1.8;">`;
    for (const t of pendingTests) {
      const submitted = t.submittedDate ? new Date(t.submittedDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "date unknown";
      body += `<li>Batch test #${t.id} — submitted ${submitted} to ${t.testingAgency}</li>`;
    }
    body += `</ul>`;
  }

  return emailWrapper(
    "Weekly Inventory & Production Digest",
    "Current inventory levels, batch status, and pending lab results",
    body,
    companyName
  );
}

// ── Send functions ────────────────────────────────────────────────────────────

async function getSettings() {
  const [s] = await db.select().from(digestSettingsTable).limit(1);
  return s;
}

async function getCompanyName(): Promise<string> {
  try {
    const result = await db.execute(sql`SELECT company_name FROM company_profile LIMIT 1`);
    const row = result.rows?.[0] as { company_name?: string } | undefined;
    return row?.company_name ?? "CannaQMS";
  } catch {
    return "CannaQMS";
  }
}

export async function sendComplianceDigest(): Promise<{ sent: number; skipped: string[] }> {
  const resend = getResend();
  if (!resend) {
    logger.warn("RESEND_API_KEY not set — compliance digest skipped");
    return { sent: 0, skipped: ["No RESEND_API_KEY"] };
  }

  const settings = await getSettings();
  if (!settings?.complianceRecipients?.trim()) {
    logger.info("No compliance digest recipients configured");
    return { sent: 0, skipped: ["No recipients"] };
  }

  const recipients = settings.complianceRecipients.split(",").map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: 0, skipped: ["No recipients"] };

  const companyName = await getCompanyName();
  const html = await buildComplianceDigest(companyName);
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const skipped: string[] = [];
  let sent = 0;

  for (const to of recipients) {
    try {
      await resend.emails.send({
        from: "CannaQMS <digest@updates.cannaqms.app>",
        to,
        subject: `CannaQMS Weekly Compliance Snapshot — ${today}`,
        html,
      });
      sent++;
    } catch (err) {
      logger.error({ err, to }, "Failed to send compliance digest");
      skipped.push(to);
    }
  }

  await db.update(digestSettingsTable).set({ lastComplianceSentAt: new Date(), updatedAt: new Date() });
  logger.info({ sent, skipped }, "Compliance digest sent");
  return { sent, skipped };
}

export async function sendInventoryDigest(): Promise<{ sent: number; skipped: string[] }> {
  const resend = getResend();
  if (!resend) {
    logger.warn("RESEND_API_KEY not set — inventory digest skipped");
    return { sent: 0, skipped: ["No RESEND_API_KEY"] };
  }

  const settings = await getSettings();
  if (!settings?.inventoryRecipients?.trim()) {
    logger.info("No inventory digest recipients configured");
    return { sent: 0, skipped: ["No recipients"] };
  }

  const recipients = settings.inventoryRecipients.split(",").map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: 0, skipped: ["No recipients"] };

  const companyName = await getCompanyName();
  const html = await buildInventoryDigest(companyName);
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const skipped: string[] = [];
  let sent = 0;

  for (const to of recipients) {
    try {
      await resend.emails.send({
        from: "CannaQMS <digest@updates.cannaqms.app>",
        to,
        subject: `CannaQMS Weekly Inventory & Production Digest — ${today}`,
        html,
      });
      sent++;
    } catch (err) {
      logger.error({ err, to }, "Failed to send inventory digest");
      skipped.push(to);
    }
  }

  await db.update(digestSettingsTable).set({ lastInventorySentAt: new Date(), updatedAt: new Date() });
  logger.info({ sent, skipped }, "Inventory digest sent");
  return { sent, skipped };
}
