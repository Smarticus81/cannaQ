import { pgTable, serial, text, integer, real, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";
import { usersTable } from "./users";

export const incomingInspectionsTable = pgTable("incoming_inspections", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  inspectionNumber: text("inspection_number").notNull().unique(),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  supplierName: text("supplier_name"),
  poManifestNumber: text("po_manifest_number"),
  inspectionDate: date("inspection_date").notNull(),
  inspectedBy: integer("inspected_by").references(() => usersTable.id),
  inspectedByName: text("inspected_by_name"),
  // Inspections start in Pending and the operator advances them from the
  // detail screen. Allowed values: Pending | Pass | Fail | Conditional | Closed.
  result: text("result").notNull().default("Pending"),
  inspectionNotes: text("inspection_notes"),

  // Required when result becomes Fail or Conditional. Captures why the operator
  // moved the inspection out of Pass. The audit log retains the full transition
  // history; these columns store only the most recent rationale for easy display.
  stateRationale: text("state_rationale"),
  stateRationaleByName: text("state_rationale_by_name"),
  stateRationaleAt: timestamp("state_rationale_at", { withTimezone: true }),

  // Captured when Pass is granted while at least one line item is Fail —
  // requires Supervisor / Manager / Quality / Admin sign-off (Part 11 e-sig).
  passApproverName: text("pass_approver_name"),
  passApproverInitials: text("pass_approver_initials"),
  passApproverMeaning: text("pass_approver_meaning"),
  passApprovedAt: timestamp("pass_approved_at", { withTimezone: true }),

  // Session 52 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Re-open, Admin-only), and requires
  // a Part 11 e-signature from a Manager/Quality/Admin plus a rationale.
  // Cancel is allowed only while the inspection is In-Process; a Closed
  // inspection cannot be cancelled. All nullable; null = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const incomingInspectionItemsTable = pgTable("incoming_inspection_items", {
  id: serial("id").primaryKey(),
  inspectionId: integer("inspection_id").notNull().references(() => incomingInspectionsTable.id, { onDelete: "cascade" }),
  itemName: text("item_name").notNull(),
  // Material Type drives the cannabis overlay: a "Cannabis – …" value marks the
  // resulting lot is_cannabis (so it shows on the cannabis-only Lot view) and
  // becomes the lot/inventory item type. Non-cannabis values (Packaging, Label,
  // Ingredient) leave the lot off that view. Chosen at receiving, per item.
  materialType: text("material_type"),
  supplierItemCode: text("supplier_item_code"),
  lotNumber: text("lot_number"),
  // METRC package tag captured at receiving (REQUIRED for a Cannabis line).
  // Flows onto the created lot's metrc_package_id on Pass so the cannabis lot
  // is identified from receipt; null for non-cannabis materials.
  metrcTag: text("metrc_tag"),
  // Sativa / Indica / Hybrid classification for cannabis lines (optional).
  strainType: text("strain_type"),
  // Potency (2026-09-06) — THC/CBD off the COA that accompanies a tested cannabis
  // transfer. Captured HERE at receiving (typed by the receiving team, or pulled
  // from the Metrc lab results attached to the incoming package) and copied onto
  // the lot when the line passes. Null on non-cannabis lines and on a cannabis
  // line whose COA has not been recorded — null means UNKNOWN, never zero.
  thcPct: real("thc_pct"),
  cbdPct: real("cbd_pct"),
  // 'manual' when typed off the COA, 'metrc' when pulled from the state system.
  potencySource: text("potency_source"),
  potencyTestedAt: date("potency_tested_at"),
  expiryDate: date("expiry_date"),
  quantityReceived: real("quantity_received"),
  quantityUom: text("quantity_uom"),
  result: text("result").notNull().default("Pass"),
  notes: text("notes"),
  // Disposition of a FAILED line item: "Return to Vendor" | "Scrap" | "Use As Is" | "Rework".
  // Use As Is accepts the material into inventory under concession (needs justification).
  disposition: text("disposition"),
  dispositionNotes: text("disposition_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertIncomingInspectionSchema = createInsertSchema(incomingInspectionsTable).omit({ id: true, inspectionNumber: true, createdAt: true, updatedAt: true });
export type InsertIncomingInspection = z.infer<typeof insertIncomingInspectionSchema>;
export type IncomingInspection = typeof incomingInspectionsTable.$inferSelect;

export const insertIncomingInspectionItemSchema = createInsertSchema(incomingInspectionItemsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIncomingInspectionItem = z.infer<typeof insertIncomingInspectionItemSchema>;
export type IncomingInspectionItem = typeof incomingInspectionItemsTable.$inferSelect;
