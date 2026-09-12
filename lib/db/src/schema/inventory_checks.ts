import { pgTable, serial, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Inventory Checks — periodic physical-count reconciliation against METRC.
//
// Each check is a point-in-time event: the facility physically counts on-hand
// product and compares it to what METRC says it should have. The "expected"
// quantity is captured as a LIVE METRC snapshot at count time (per active
// package tag), then staff enter the physical count per tag. Any line where the
// physical count != the METRC quantity is a variance and must carry a written
// reason before the check can be completed. Completion is 21 CFR Part 11
// e-signed. Cadence (how often a check is due) is a facility setting.
//
// One header (inventory_checks) : many lines (inventory_check_lines, one per
// METRC package tag). Additive + idempotent — CREATE TABLE IF NOT EXISTS in
// ensureSchema, and drizzle push on deploy.
export const inventoryChecksTable = pgTable("inventory_checks", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  // Human-facing sequential number, e.g. IC-2026-0001 (per-year sequence).
  checkNumber: text("check_number").notNull().unique(),
  // Optional descriptor of the period being counted, e.g. "2026 Q3".
  periodLabel: text("period_label"),
  // In Progress | Completed | Cancelled.
  status: text("status").notNull().default("In Progress"),
  // Full = whole-facility count; Partial = a subset / cycle count.
  countType: text("count_type").notNull().default("Full"),
  // When this check was due (drives overdue flagging on the list).
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  // When the METRC expected-quantity snapshot was captured.
  metrcSnapshotAt: timestamp("metrc_snapshot_at", { withTimezone: true }),
  countedByName: text("counted_by_name"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // 21 CFR Part 11 e-signature captured at completion.
  signedByName: text("signed_by_name"),
  signedByInitials: text("signed_by_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  notes: text("notes"),
  // Universal Cancel pattern — recoverable, audited, never hard-deleted.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// One row per METRC package tag included in the count.
export const inventoryCheckLinesTable = pgTable("inventory_check_lines", {
  id: serial("id").primaryKey(),
  checkId: integer("check_id").notNull().references(() => inventoryChecksTable.id, { onDelete: "cascade" }),
  metrcTag: text("metrc_tag").notNull(),
  itemName: text("item_name"),
  category: text("category"),
  uom: text("uom"),
  // Expected quantity from the METRC snapshot at count time.
  systemQty: real("system_qty"),
  // Physical count entered by staff (null until counted).
  countedQty: real("counted_qty"),
  // countedQty - systemQty (computed on save; null until counted).
  variance: real("variance"),
  counted: boolean("counted").notNull().default(false),
  // Required when variance != 0.
  reason: text("reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Singleton facility setting (row id=1) for the check cadence.
export const inventoryCheckSettingsTable = pgTable("inventory_check_settings", {
  id: integer("id").primaryKey().default(1),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  // Monthly | Quarterly | Semiannual | Annual | None.
  cadence: text("cadence").notNull().default("Quarterly"),
  // Optional grace period (days) added to the due date before "Overdue".
  graceDays: integer("grace_days").notNull().default(0),
  updatedByName: text("updated_by_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertInventoryCheckSchema = createInsertSchema(inventoryChecksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InventoryCheck = typeof inventoryChecksTable.$inferSelect;
export type InsertInventoryCheck = z.infer<typeof insertInventoryCheckSchema>;

export const insertInventoryCheckLineSchema = createInsertSchema(inventoryCheckLinesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InventoryCheckLine = typeof inventoryCheckLinesTable.$inferSelect;
export type InsertInventoryCheckLine = z.infer<typeof insertInventoryCheckLineSchema>;

export type InventoryCheckSettings = typeof inventoryCheckSettingsTable.$inferSelect;
