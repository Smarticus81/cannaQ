import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogTable } from "@workspace/db";
import { eq, and, gte, lte, desc } from "drizzle-orm";

const router = Router();

router.get("/audit-log", async (req, res) => {
  try {
    const { tableName, rowId, operation, changedBy, from, to, limit } = req.query;

    const conditions = [];
    if (tableName) conditions.push(eq(auditLogTable.tableName, String(tableName)));
    if (rowId) conditions.push(eq(auditLogTable.rowId, Number(rowId)));
    if (operation) conditions.push(eq(auditLogTable.operation, String(operation)));
    if (changedBy) conditions.push(eq(auditLogTable.changedBy, Number(changedBy)));
    if (from) conditions.push(gte(auditLogTable.changedAt, new Date(String(from))));
    if (to) conditions.push(lte(auditLogTable.changedAt, new Date(String(to))));

    const pageLimit = Math.min(Number(limit) || 200, 1000);

    const logs = await db
      .select()
      .from(auditLogTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogTable.changedAt))
      .limit(pageLimit);

    res.json(logs);
  } catch (err) {
    req.log.error({ err }, "Failed to list audit log");
    res.status(500).json({ error: "Failed to list audit log" });
  }
});

export default router;
