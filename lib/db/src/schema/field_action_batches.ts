import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldActionsTable } from "./field_actions";
import { batchRecordsTable } from "./batch_records";

// #4 (2026-08-05) — the affected finished-goods BATCHES on a field action. Unlike
// field_action_lots this is RECORD-ONLY: no auto-quarantine. Per Jonathan, product
// still in-house is quarantined separately (e.g. via a CAPA), while product that
// already shipped to customers is worked through the field action's Response
// Actions. A field action's affected batches drive the "suggest stores from
// manifests" lookup (batch -> its outbound manifests -> destination stores).
export const fieldActionBatchesTable = pgTable(
  "field_action_batches",
  {
    id: serial("id").primaryKey(),
    fieldActionId: integer("field_action_id").notNull().references(() => fieldActionsTable.id, { onDelete: "cascade" }),
    batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
    notes: text("notes"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: unique("field_action_batches_unique").on(t.fieldActionId, t.batchId) }),
);

export const insertFieldActionBatchSchema = createInsertSchema(fieldActionBatchesTable).omit({ id: true, createdAt: true });
export type InsertFieldActionBatch = z.infer<typeof insertFieldActionBatchSchema>;
export type FieldActionBatch = typeof fieldActionBatchesTable.$inferSelect;
