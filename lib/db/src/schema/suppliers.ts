import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  supplierName: text("supplier_name").notNull(),
  contactPerson: text("contact_person"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  licenseNumber: text("license_number"),
  supplierType: text("supplier_type").notNull(),
  status: text("status").notNull().default("Pending Review"),
  qualityRating: text("quality_rating"),
  notes: text("notes"),
  requalificationIntervalYears: integer("requalification_interval_years").notNull().default(1),
  // Operator-set base risk tier (Low/Medium/High/Critical). When set, overrides
  // the auto-computed tier — cannabis industry isn't required to follow ISO
  // 13485, so absence of qualification record shouldn't auto-bump to Medium.
  riskTier: text("risk_tier"),
  // Session 33 (Tier 2 #9) — operator-supplied rationale documenting *why*
  // this tier was chosen. Required on new supplier creation and on every
  // subsequent tier change. Audit log captures the history; these columns
  // mirror the current rationale + lineage for at-a-glance display.
  // Feeds the Track C1 Risk Memory rationale corpus per the priority list.
  riskTierRationale: text("risk_tier_rationale"),
  riskTierSetAt: timestamp("risk_tier_set_at", { withTimezone: true }),
  riskTierSetByName: text("risk_tier_set_by_name"),
  // SRS-1 Part 2 — the "effective" (officially-reviewed) auto-computed risk tier.
  // This is what annotate() surfaces as the supplier's tier when there is no
  // operator-set override. It rises with the computed tier immediately (an
  // escalation is never hidden) but only falls when a Manager/Quality approves
  // the decrease via a supplier_risk_changes record (the directional hold).
  // Null until the boot backfill seeds it = fall back to the computed tier.
  reviewedRiskTier: text("reviewed_risk_tier"),
  reviewedRiskTierAt: timestamp("reviewed_risk_tier_at", { withTimezone: true }),
  // The score + contributing factors captured when reviewed_risk_tier was last
  // applied — the baseline the next change is diffed against to build the
  // templated rationale ("resolved: … / new: …").
  reviewedRiskScore: integer("reviewed_risk_score"),
  reviewedRiskFactors: text("reviewed_risk_factors").array(),
  // Session 52.2 — soft Cancel (Part 11) replaces the old hard DELETE. QMS
  // records (incl. supplier master data, ISO 13485 §7.4) are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires a
  // Manager/Quality/Admin actor + rationale + Part 11 e-signature. Distinct from
  // the status lifecycle (Active/Deactivated/reopen). All nullable; null = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),
  // Separation of duties (2026-08-06) — who created this supplier. Stamped at
  // creation only; used to stop the creator from approving their own record.
  // Nullable so legacy rows (created before this) stay approvable by anyone.
  createdById: integer("created_by_id"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const supplierAttachmentsTable = pgTable("supplier_attachments", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull().references(() => suppliersTable.id, { onDelete: "cascade" }),
  fileType: text("file_type").notNull(),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliersTable.$inferSelect;

export const insertSupplierAttachmentSchema = createInsertSchema(supplierAttachmentsTable).omit({ id: true, createdAt: true });
export type InsertSupplierAttachment = z.infer<typeof insertSupplierAttachmentSchema>;
export type SupplierAttachment = typeof supplierAttachmentsTable.$inferSelect;
