import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull(),
  rowId: integer("row_id").notNull(),
  operation: text("operation").notNull(),
  changedBy: integer("changed_by"),
  changedByName: text("changed_by_name"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
});

export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({ id: true, changedAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogTable.$inferSelect;
