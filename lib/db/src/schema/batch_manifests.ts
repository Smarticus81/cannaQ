import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

// Outbound manifest (Metrc outgoing transfer) — CannaQMS is the manifest system
// of record; Metrc is the downstream sync (Phase 2 pushes this as an outgoing
// TEMPLATE, since Metrc v2 has no direct outgoing-transfer create — see
// metrc-manifest-requirements). One row per outbound manifest for a batch.
//
// Ships to ANY licensed recipient (retailer OR processor OR lab, etc.); the
// transfer type is chosen per manifest from the live Metrc type list
// (Wholesale Transfer, AU Affiliated Transfer, Processor to Processor, …).
//
// Phase 1 (this table) covers the CannaQMS record + pre-flight + printable
// manifest — NO Metrc write. metrcTemplateId / metrcManifestNumber / pushedAt
// stay null until Phase 2 wires the guarded push.
export const batchManifestsTable = pgTable("batch_manifests", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  // draft → preflight_passed → pushed → accepted | rejected | voided
  status: text("status").notNull().default("draft"),
  // Metrc transfer type Name (must match GET /transfers/v2/types for the facility).
  transferTypeName: text("transfer_type_name"),
  // Recipient (denormalized so the manifest is self-contained even if the
  // directory row is later edited/retired). recipientId is a soft link.
  recipientId: integer("recipient_id"),
  recipientLicenseNumber: text("recipient_license_number"),
  recipientName: text("recipient_name"),
  // Logistics.
  plannedRoute: text("planned_route"),
  estimatedDepartureDateTime: timestamp("estimated_departure_date_time", { withTimezone: true }),
  estimatedArrivalDateTime: timestamp("estimated_arrival_date_time", { withTimezone: true }),
  transporterFacilityLicenseNumber: text("transporter_facility_license_number"),
  driverName: text("driver_name"),
  driverOccupationalLicenseNumber: text("driver_occupational_license_number"),
  driverLicenseNumber: text("driver_license_number"),
  vehicleMake: text("vehicle_make"),
  vehicleModel: text("vehicle_model"),
  vehicleLicensePlateNumber: text("vehicle_license_plate_number"),
  phoneNumberForQuestions: text("phone_number_for_questions"),
  // Destination gross weight — required by every licensed MI transfer type.
  grossWeight: numeric("gross_weight"),
  grossUnitOfWeightName: text("gross_unit_of_weight_name"),
  // Phase 2 sync (null in Phase 1).
  metrcTemplateId: integer("metrc_template_id"),
  metrcManifestNumber: text("metrc_manifest_number"),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  // Attribution + Part 11 sign-off (captured when a manifest is finalized/pushed).
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdByName: text("created_by_name"),
  signedByUserId: integer("signed_by_user_id").references(() => usersTable.id),
  signedByName: text("signed_by_name"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchManifestSchema = createInsertSchema(batchManifestsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type BatchManifest = typeof batchManifestsTable.$inferSelect;
export type InsertBatchManifest = z.infer<typeof insertBatchManifestSchema>;
