import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// FACILITIES — multi-facility Phase 1 (2026-08-28).
//
// ⛔ A FACILITY IS A LICENCE. Jonathan's ruling, 2026-08-27:
//   "in michigan one company could have a license for cultivation, a license for
//    processing, a license for each retail location."
// One building holding two licences is TWO facilities, and moving product between
// them is a real METRC transfer, not an internal move. That is exactly how the
// state sees it, so there is no licence-picking logic to write and nothing to
// reconcile against METRC later.
//
// This is NOT the licence REGISTER (`licenses`). That table tracks renewal dates
// for every permit an operator holds — CRA, MDARD, fire, local zoning — and is a
// compliance watchlist. This table is the OPERATING SITE that records belong to:
// batches, inventory, training records and METRC credentials all hang off it.
//
// Phase 1 is deliberately invisible: exactly one facility exists, seeded from the
// company profile, and nothing else in the app changes. Phase 2 adds scoping that
// cannot be forgotten, BEFORE a second facility exists to get it wrong with — a
// missed query filter would show a Michigan operator a Missouri batch, which is a
// compliance incident, not a cosmetic bug.
export const facilitiesTable = pgTable("facilities", {
  id: serial("id").primaryKey(),

  // What people call the site: "Ann Arbor Processing", "Bay City Grow".
  name: text("name").notNull(),

  // A SHORT CODE for the site — "AA", "BC". Two to four letters, unique.
  // It is what goes into the numbers of records that belong to one plant, so a
  // person reading NC-AA-26-0001 knows where it came from without looking it up.
  // Company-wide records (SOPs, and the quality events every site can see) keep
  // their plain number: there is only one of each, so there is nothing to tell apart.
  code: text("code"),

  // The licence this facility IS. Nullable only so the seed can never fail on an
  // operator who has not filled in their company profile; the UI requires it.
  licenseNumber: text("license_number"),
  // Free text against the CRA vocabulary — Processor, Grower – Class C, Retailer,
  // Microbusiness, Safety Compliance Facility. Not an enum: the list differs by
  // state and a second state is the whole point of this work.
  licenseType: text("license_type"),

  // Two-letter state. Drives which rules apply and, from Phase 3, which METRC host
  // the client for this facility is built against.
  state: text("state").notNull().default("MI"),
  address: text("address"),
  city: text("city"),
  zip: text("zip"),
  phone: text("phone"),
  contactPerson: text("contact_person"),

  // ⛔ THE FACILITY TIME ZONE — moved here from company_profile, which is where it
  // lived for one day (2026-08-27) while a facility entity did not exist. Every
  // date-only column in this system is a calendar day where the operator is
  // standing, including the packagedDate sent to METRC, whose DATE fields carry no
  // zone at all. An IANA name ("America/New_York"); null = Eastern, which is what
  // every record written before the setting existed was dated against.
  timeZone: text("time_zone"),

  // ── METRC, per facility (Phase 1, slice 3) ────────────────────────────────
  // A facility IS a licence, and METRC issues its credentials per licence, so this
  // is where the connection belongs — not on an environment variable shared by
  // whatever the server happens to be running.
  //
  // ⛔ THE KEYS ARE NOT HERE. Only the two NON-SECRET halves live on this row, so
  // they can be read, shown and audited like any other field. The vendor and user
  // keys live in `facility_metrc_credentials`, which is excluded from the audit
  // triggers so a key value can never be copied into the audit log.
  //
  // The host differs by state — Michigan sandbox is https://sandbox-api-mi.metrc.com,
  // Missouri would be a different host — which is why the client has to be built per
  // facility rather than once for the process. Null on both = fall back to the
  // METRC_* environment variables, which is exactly how it behaved before.
  metrcBaseUrl: text("metrc_base_url"),
  metrcLicenseNumber: text("metrc_license_number"),

  // Soft retirement. A closed site's records must stay readable and signed — we do
  // not delete facilities any more than we delete batches.
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFacilitySchema = createInsertSchema(facilitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFacility = z.infer<typeof insertFacilitySchema>;
export type Facility = typeof facilitiesTable.$inferSelect;
