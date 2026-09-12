import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companyProfileTable = pgTable("company_profile", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull(),
  licenseNumber: text("license_number"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  phone: text("phone"),
  email: text("email"),
  contactPerson: text("contact_person"),
  // Session 97 (#15) — supplier risk SCORING opt-in. Off by default so the
  // ISO-13485-style tier ALARMS (Critical/High coloring, count chips, row
  // highlighting) stay suppressed until a facility deliberately adopts scoring.
  // The numeric score is still computed + shown neutrally; only the alarm framing
  // is gated. A facility flips this on from Settings once they've defined their
  // own process.
  supplierScoringEnabled: boolean("supplier_scoring_enabled").notNull().default(false),
  // ⛔ RETIRED 2026-08-28 — the facility time zone MOVED to `facilities.time_zone`.
  // It lived here for one day, while a facility entity did not exist. A facility is
  // a licence, and an operator holding licences in two states has two calendars, so
  // the zone cannot belong to the company.
  //
  // The column stays: it holds the value the first facility was seeded from, and we
  // do not drop columns that recorded how a record was dated. Nothing reads or
  // writes it any more — see routes/facilities.ts and lib/facilityDate.ts.
  timeZone: text("time_zone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCompanyProfileSchema = createInsertSchema(companyProfileTable).omit({ id: true, updatedAt: true });
export type InsertCompanyProfile = z.infer<typeof insertCompanyProfileSchema>;
export type CompanyProfile = typeof companyProfileTable.$inferSelect;
