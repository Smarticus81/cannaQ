import { Router } from "express";
import { db } from "@workspace/db";
import {
  nonConformancesTable,
  correctiveActionsTable,
  complaintsTable,
  fieldActionsTable,
  batchRecordsTable,
  capaActionItemsTable,
  capasTable,
} from "@workspace/db";
import { ne, inArray, notInArray, and, lte, isNotNull, eq } from "drizzle-orm";
import { facilityDateStr } from "../lib/facilityDate";

const router = Router();

router.get("/notifications", async (req, res) => {
  try {
    // Window: today through +3 days (inclusive end of day)
    const now = new Date();
    const threeDaysOut = new Date(now);
    threeDaysOut.setDate(threeDaysOut.getDate() + 3);
    // Use ISO date string for date column comparison (YYYY-MM-DD)
    const todayStr = facilityDateStr(now);
    const thresholdStr = facilityDateStr(threeDaysOut);

    const [openNCs, openComplaints, openFAs, flaggedBatches, dueSoonActionItems, dueSoonNcActions] = await Promise.all([
      db
        .select({
          id: nonConformancesTable.id,
          ncNumber: nonConformancesTable.ncNumber,
          title: nonConformancesTable.title,
          severity: nonConformancesTable.severity,
          status: nonConformancesTable.status,
          createdAt: nonConformancesTable.createdAt,
        })
        .from(nonConformancesTable)
        .where(ne(nonConformancesTable.status, "Closed")),

      db
        .select({
          id: complaintsTable.id,
          complaintNumber: complaintsTable.complaintNumber,
          complaintType: complaintsTable.complaintType,
          severity: complaintsTable.severity,
          status: complaintsTable.status,
          receivedDate: complaintsTable.receivedDate,
          createdAt: complaintsTable.createdAt,
        })
        .from(complaintsTable)
        .where(ne(complaintsTable.status, "Closed")),

      db
        .select({
          id: fieldActionsTable.id,
          faNumber: fieldActionsTable.faNumber,
          title: fieldActionsTable.title,
          actionType: fieldActionsTable.actionType,
          status: fieldActionsTable.status,
          createdAt: fieldActionsTable.createdAt,
        })
        .from(fieldActionsTable)
        .where(ne(fieldActionsTable.status, "Closed")),

      db
        .select({
          id: batchRecordsTable.id,
          batchNumber: batchRecordsTable.batchNumber,
          productName: batchRecordsTable.productName,
          status: batchRecordsTable.status,
          updatedAt: batchRecordsTable.updatedAt,
        })
        .from(batchRecordsTable)
        .where(inArray(batchRecordsTable.status, ["failed", "on_hold"])),

      // CAPA action items overdue or due within 3 days
      db
        .select({
          id: capaActionItemsTable.id,
          capaId: capaActionItemsTable.capaId,
          sequenceNumber: capaActionItemsTable.sequenceNumber,
          actionDescription: capaActionItemsTable.actionDescription,
          assignedToName: capaActionItemsTable.assignedToName,
          dueDate: capaActionItemsTable.dueDate,
          status: capaActionItemsTable.status,
          capaNumber: capasTable.capaNumber,
          capaType: capasTable.type,
          capaStatus: capasTable.status,
        })
        .from(capaActionItemsTable)
        .innerJoin(capasTable, eq(capaActionItemsTable.capaId, capasTable.id))
        .where(
          and(
            notInArray(capaActionItemsTable.status, ["Completed", "Verified"]),
            notInArray(capasTable.status, ["Closed", "Cancelled"]),
            isNotNull(capaActionItemsTable.dueDate),
            lte(capaActionItemsTable.dueDate, thresholdStr),
          )
        ),

      // NC corrective actions overdue or due within 3 days
      db
        .select({
          id: correctiveActionsTable.id,
          ncId: correctiveActionsTable.ncId,
          actionDescription: correctiveActionsTable.actionDescription,
          assignedToName: correctiveActionsTable.assignedToName,
          dueDate: correctiveActionsTable.dueDate,
          status: correctiveActionsTable.status,
          ncNumber: nonConformancesTable.ncNumber,
          ncStatus: nonConformancesTable.status,
        })
        .from(correctiveActionsTable)
        .innerJoin(nonConformancesTable, eq(correctiveActionsTable.ncId, nonConformancesTable.id))
        .where(
          and(
            ne(correctiveActionsTable.status, "Completed"),
            ne(nonConformancesTable.status, "Closed"),
            isNotNull(correctiveActionsTable.dueDate),
            lte(correctiveActionsTable.dueDate, thresholdStr),
          )
        ),
    ]);

    const criticalNCs = openNCs.filter((n) => n.severity === "Critical");
    const majorNCs = openNCs.filter((n) => n.severity !== "Critical");
    const adverseComplaints = openComplaints.filter((c) => c.complaintType === "Adverse Event");
    const otherComplaints = openComplaints.filter((c) => c.complaintType !== "Adverse Event");

    // Split CAPA action items into overdue vs due-soon
    // Items due today are treated as overdue so the bell fires on the due date itself
    const overdueActionItems = dueSoonActionItems.filter(
      (i) => i.dueDate !== null && i.dueDate <= todayStr
    );
    const comingDueActionItems = dueSoonActionItems.filter(
      (i) => i.dueDate !== null && i.dueDate > todayStr
    );

    // Split NC corrective actions into overdue vs due-soon (same boundary)
    const overdueNcActions = dueSoonNcActions.filter(
      (i) => i.dueDate !== null && i.dueDate <= todayStr
    );
    const comingDueNcActions = dueSoonNcActions.filter(
      (i) => i.dueDate !== null && i.dueDate > todayStr
    );

    // Build flat notifications array sorted by severity
    const notifications: Array<{
      id: string;
      level: "critical" | "warning" | "info";
      category: "nc" | "complaint" | "field_action" | "batch" | "capa";
      title: string;
      subtitle: string;
      href: string;
      createdAt: string;
    }> = [];

    for (const n of criticalNCs) {
      notifications.push({
        id: `nc-${n.id}`,
        level: "critical",
        category: "nc",
        title: `${n.ncNumber}: ${n.title}`,
        subtitle: `Critical NC · ${n.status}`,
        href: `/non-conformances/${n.id}`,
        createdAt: n.createdAt.toISOString(),
      });
    }

    for (const fa of openFAs) {
      notifications.push({
        id: `fa-${fa.id}`,
        level: "critical",
        category: "field_action",
        title: `${fa.faNumber}: ${fa.title}`,
        subtitle: `${fa.actionType} Field Action · ${fa.status}`,
        href: `/field-actions/${fa.id}`,
        createdAt: fa.createdAt.toISOString(),
      });
    }

    for (const c of adverseComplaints) {
      notifications.push({
        id: `cmp-${c.id}`,
        level: "critical",
        category: "complaint",
        title: `${c.complaintNumber}: Adverse Event`,
        subtitle: `${c.severity} severity · ${c.status}`,
        href: `/complaints/${c.id}`,
        createdAt: c.createdAt.toISOString(),
      });
    }

    for (const n of majorNCs) {
      notifications.push({
        id: `nc-${n.id}`,
        level: "warning",
        category: "nc",
        title: `${n.ncNumber}: ${n.title}`,
        subtitle: `${n.severity} NC · ${n.status}`,
        href: `/non-conformances/${n.id}`,
        createdAt: n.createdAt.toISOString(),
      });
    }

    for (const b of flaggedBatches) {
      notifications.push({
        id: `batch-${b.id}`,
        level: "warning",
        category: "batch",
        title: `${b.batchNumber}: ${b.productName}`,
        subtitle: `Batch ${b.status === "failed" ? "Failed" : "On Hold"} — review required`,
        href: `/batches/${b.id}`,
        createdAt: b.updatedAt.toISOString(),
      });
    }

    for (const c of otherComplaints) {
      notifications.push({
        id: `cmp-${c.id}`,
        level: "warning",
        category: "complaint",
        title: `${c.complaintNumber}: ${c.complaintType}`,
        subtitle: `${c.severity} complaint · ${c.status}`,
        href: `/complaints/${c.id}`,
        createdAt: c.createdAt.toISOString(),
      });
    }

    // Overdue CAPA action items → critical
    for (const item of overdueActionItems) {
      const daysOver = Math.floor(
        (new Date(todayStr).getTime() - new Date(item.dueDate!).getTime()) / 86_400_000
      );
      const overdueLabel = daysOver === 0 ? "Due today" : `Overdue by ${daysOver}d`;
      notifications.push({
        id: `capa-item-${item.id}`,
        level: "critical",
        category: "capa",
        title: `${item.capaNumber} — Action Item #${item.sequenceNumber}`,
        subtitle: `${overdueLabel} · ${item.actionDescription.slice(0, 60)}${item.actionDescription.length > 60 ? "…" : ""}`,
        href: `/capas/${item.capaId}`,
        createdAt: new Date(item.dueDate!).toISOString(),
      });
    }

    // CAPA action items due within 3 days → warning
    for (const item of comingDueActionItems) {
      const daysUntil = Math.ceil(
        (new Date(item.dueDate!).getTime() - new Date(todayStr).getTime()) / 86_400_000
      );
      const dueSoonLabel =
        daysUntil === 1 ? "Due tomorrow" : `Due in ${daysUntil}d`;
      notifications.push({
        id: `capa-item-${item.id}`,
        level: "warning",
        category: "capa",
        title: `${item.capaNumber} — Action Item #${item.sequenceNumber}`,
        subtitle: `${dueSoonLabel} · ${item.actionDescription.slice(0, 60)}${item.actionDescription.length > 60 ? "…" : ""}`,
        href: `/capas/${item.capaId}`,
        createdAt: new Date(item.dueDate!).toISOString(),
      });
    }

    // Overdue NC corrective actions → critical
    for (const item of overdueNcActions) {
      const daysOver = Math.floor(
        (new Date(todayStr).getTime() - new Date(item.dueDate!).getTime()) / 86_400_000
      );
      const overdueLabel = daysOver === 0 ? "Due today" : `Overdue by ${daysOver}d`;
      notifications.push({
        id: `nc-action-${item.id}`,
        level: "critical",
        category: "nc",
        title: `${item.ncNumber} — Corrective Action`,
        subtitle: `${overdueLabel} · ${item.actionDescription.slice(0, 60)}${item.actionDescription.length > 60 ? "…" : ""}`,
        href: `/non-conformances/${item.ncId}`,
        createdAt: new Date(item.dueDate!).toISOString(),
      });
    }

    // NC corrective actions due within 3 days → warning
    for (const item of comingDueNcActions) {
      const daysUntil = Math.ceil(
        (new Date(item.dueDate!).getTime() - new Date(todayStr).getTime()) / 86_400_000
      );
      const dueSoonLabel = daysUntil === 1 ? "Due tomorrow" : `Due in ${daysUntil}d`;
      notifications.push({
        id: `nc-action-${item.id}`,
        level: "warning",
        category: "nc",
        title: `${item.ncNumber} — Corrective Action`,
        subtitle: `${dueSoonLabel} · ${item.actionDescription.slice(0, 60)}${item.actionDescription.length > 60 ? "…" : ""}`,
        href: `/non-conformances/${item.ncId}`,
        createdAt: new Date(item.dueDate!).toISOString(),
      });
    }

    const criticalCount = notifications.filter((n) => n.level === "critical").length;
    const totalCount = notifications.length;

    res.json({ notifications, totalCount, criticalCount });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch notifications");
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

export default router;
