import { pgTable, serial, text, date, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Facility / state operating-license register (2026-07-21).
// Home for the operator's OWN licenses (state processor license, MDARD
// cultivation, local permits, etc.) WITH renewal dates — distinct from supplier
// certificate/license expiry, which lives on supplier_qualifications. Powers the
// Quality dashboard's "licenses needing renewal" widget.
export const licensesTable = pgTable("licenses", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  name: text("name").notNull(), // e.g. "Processor License", "MDARD Cultivation"
  licenseType: text("license_type").notNull().default("State"), // State | MDARD | Local | Federal | Other
  licenseNumber: text("license_number").notNull(),
  issuer: text("issuer"), // e.g. "Michigan CRA", "MDARD"
  issueDate: date("issue_date"),
  expiryDate: date("expiry_date"), // the renewal-due date the widget watches
  status: text("status").notNull().default("Active"), // Active | Expired | Pending | Inactive
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLicenseSchema = createInsertSchema(licensesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type License = typeof licensesTable.$inferSelect;
