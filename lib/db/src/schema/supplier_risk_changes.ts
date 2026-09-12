import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";
import { usersTable } from "./users";

// SRS-1 Part 2 — persisted, signed record of every supplier risk-TIER change.
//
// Increases apply immediately (the supplier's reviewed_risk_tier is advanced at
// detection) and require a Manager/Quality ACKNOWLEDGEMENT after the fact.
// Decreases are HELD — reviewed_risk_tier is NOT lowered until this record is
// APPROVED — so the system can never quietly reduce a supplier's risk without a
// human signing off. Every review is a 21 CFR Part 11 e-signature. Records are
// never hard-deleted; a pending decrease made obsolete by the computed tier
// reversing is marked Superseded.
export const supplierRiskChangesTable = pgTable("supplier_risk_changes", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull().references(() => suppliersTable.id, { onDelete: "cascade" }),
  // "increase" (applied immediately, needs acknowledgement) or
  // "decrease" (held until approved).
  direction: text("direction").notNull(),
  fromTier: text("from_tier").notNull(),
  toTier: text("to_tier").notNull(),
  fromScore: integer("from_score").notNull(),
  toScore: integer("to_score").notNull(),
  // Templated rationale (same deterministic builder as SRS-1 Part 1).
  rationale: text("rationale").notNull(),
  factorsAdded: text("factors_added").array(),
  factorsRemoved: text("factors_removed").array(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  // "Pending"  — increase: applied, awaiting acknowledgement;
  //              decrease: proposed, NOT yet applied, awaiting approval.
  // "Reviewed" — signed (increase acknowledged, or decrease approved + applied).
  // "Superseded" — a pending decrease obsoleted before review (tier reversed).
  status: text("status").notNull().default("Pending"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id),
  reviewedByName: text("reviewed_by_name"),
  reviewedByInitials: text("reviewed_by_initials"),
  reviewedMeaning: text("reviewed_meaning"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSupplierRiskChangeSchema = createInsertSchema(supplierRiskChangesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupplierRiskChange = z.infer<typeof insertSupplierRiskChangeSchema>;
export type SupplierRiskChange = typeof supplierRiskChangesTable.$inferSelect;
