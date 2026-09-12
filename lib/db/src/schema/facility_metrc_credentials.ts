import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { facilitiesTable } from "./facilities";

// METRC CREDENTIALS, one row per facility — multi-facility Phase 1, slice 3 (2026-08-28).
//
// ⛔ WHY THIS IS A SEPARATE TABLE AND NOT TWO MORE COLUMNS ON `facilities`.
// Every id-bearing table in this database carries the zzz_cqms_audit trigger, and
// that trigger stores the WHOLE row — `to_jsonb(NEW)` — in the audit log. Put a
// user key on the facilities row and every save of a facility's address would
// write that key, in clear, into a table half the app can read. Holding the two
// secrets apart lets that one table be excluded from the triggers (see
// ensureSchema) while everything else stays fully audited.
//
// The CHANGE is still recorded: the route writes its own audit entry saying who
// changed the connection and when, with the keys masked. The event is the
// compliance record; the value is not.
//
// ⚠️ These are stored as written. That is the same exposure as the Railway
// environment variables they replace — anyone with the database has them — and no
// worse, but it is not encryption, and a rotation still has to be done by hand.
// See [[metrc-keys-source-of-truth]]: the user key rotates and the pair must match.
export const facilityMetrcCredentialsTable = pgTable(
  "facility_metrc_credentials",
  {
    id: serial("id").primaryKey(),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    // Username half of the HTTP Basic pair — the integrator key, emailed by METRC.
    vendorKey: text("vendor_key"),
    // Password half — generated in the METRC UI by a named human, and the one that
    // carries the grants. This is the one that rotates.
    userKey: text("user_key"),
    updatedByName: text("updated_by_name"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    facilityUnique: uniqueIndex("facility_metrc_credentials_facility_key").on(t.facilityId),
  }),
);

export type FacilityMetrcCredentials = typeof facilityMetrcCredentialsTable.$inferSelect;
