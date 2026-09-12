import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Saved transporter / driver / vehicle presets (Phase 1). Manifest transport
// details repeat run-to-run, so a preset is picked and then overridden per
// manifest. Mirrors metrcTransfers.TransporterInput field-for-field so a preset
// maps straight onto the template payload later. Additive; app-managed.
export const transporterPresetsTable = pgTable("transporter_presets", {
  id: serial("id").primaryKey(),
  // A human label for the preset ("In-house van — J. Doe").
  label: text("label").notNull(),
  transporterFacilityLicenseNumber: text("transporter_facility_license_number").notNull(),
  driverName: text("driver_name"),
  driverOccupationalLicenseNumber: text("driver_occupational_license_number"),
  driverLicenseNumber: text("driver_license_number"),
  phoneNumberForQuestions: text("phone_number_for_questions"),
  vehicleMake: text("vehicle_make"),
  vehicleModel: text("vehicle_model"),
  vehicleLicensePlateNumber: text("vehicle_license_plate_number"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTransporterPresetSchema = createInsertSchema(transporterPresetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type TransporterPreset = typeof transporterPresetsTable.$inferSelect;
export type InsertTransporterPreset = z.infer<typeof insertTransporterPresetSchema>;
