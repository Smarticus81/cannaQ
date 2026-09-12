import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldActionsTable } from "./field_actions";
import { lotsTable } from "./lots";

export const fieldActionLotsTable = pgTable(
  "field_action_lots",
  {
    id: serial("id").primaryKey(),
    fieldActionId: integer("field_action_id").notNull().references(() => fieldActionsTable.id, { onDelete: "cascade" }),
    lotId: integer("lot_id").notNull().references(() => lotsTable.id, { onDelete: "cascade" }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: unique("field_action_lots_unique").on(t.fieldActionId, t.lotId) }),
);

export const insertFieldActionLotSchema = createInsertSchema(fieldActionLotsTable).omit({ id: true, createdAt: true });
export type InsertFieldActionLot = z.infer<typeof insertFieldActionLotSchema>;
export type FieldActionLot = typeof fieldActionLotsTable.$inferSelect;
