import { pgTable, serial, integer, text, real, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { destructionRecordsTable } from "./destruction_records";

// 2026-08-05 — line items on a destruction record. Michigan's CRA waste/
// destruction log must carry the FULL METRC tag number of EACH package being
// destroyed (not one consolidated number), so a destruction event (the header
// record = the "Record of Evidence" reference) holds a LIST of these lines —
// one per scanned METRC package tag. For packaged product the amount/unit are
// pulled from METRC/Finished Goods on scan; for bulk waste they're entered by
// hand. Each line can carry its own reason (defaults to the header's) so a
// single destruction session can mix reasons (Expired + Low Potency + scrap).
export const destructionRecordLinesTable = pgTable("destruction_record_lines", {
  id: serial("id").primaryKey(),
  destructionRecordId: integer("destruction_record_id")
    .notNull()
    .references(() => destructionRecordsTable.id, { onDelete: "cascade" }),
  // The full METRC package tag being destroyed (scanned).
  metrcTag: text("metrc_tag").notNull(),
  // Product/item name — auto-filled from METRC/Finished Goods when the tag is
  // a known package; null for bulk/unrecognized tags.
  itemName: text("item_name"),
  // Amount + unit. amount is a count (ea/units) OR a weight; uom disambiguates
  // (ea | units | g | oz | lb | kg | mg). Nullable so bulk waste can omit.
  amount: real("amount"),
  uom: text("uom"),
  // Per-line reason (defaults to the header's default reason; may be overridden).
  reason: text("reason"),
  // Optional soft link back to a source batch (traceability), when known.
  sourceBatchId: integer("source_batch_id"),
  note: text("note"),
  // Phase 2 — METRC adjust/finish sync status for this package on record Close.
  // metrcSynced true once adjust(+finish) succeeded; metrcSyncError holds the
  // last failure so a failed package is visible, never silently swallowed.
  metrcSynced: boolean("metrc_synced").notNull().default(false),
  metrcSyncError: text("metrc_sync_error"),
  metrcSyncedAt: timestamp("metrc_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDestructionRecordLineSchema = createInsertSchema(destructionRecordLinesTable).omit({ id: true, createdAt: true });
export type InsertDestructionRecordLine = z.infer<typeof insertDestructionRecordLineSchema>;
export type DestructionRecordLine = typeof destructionRecordLinesTable.$inferSelect;
