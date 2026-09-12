import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { facilitiesTable } from "./facilities";

// WHO WORKS WHERE — multi-facility Phase 1 (2026-08-28).
//
// ⛔ PEOPLE ARE FACILITY, MIRRORING METRC. His ruling 08-27:
//   "If a human wants to work at a facility, they must be in michigan metrc."
// The state's employee list is the authority on who is at a site, so this table
// records the same thing rather than inventing a separate org chart.
//
// ⛔ WHY A JOIN TABLE AND NOT A COLUMN ON `users`: a supervisor can cover two
// plants, and a quality director covers all of them. A single facility_id would
// force a second user account for the same human — and that would split their
// SIGNATURE IDENTITY, which must stay single. One person, one set of initials, one
// Part 11 identity, listed at as many facilities as they actually work at.
//
// ⚠️ HIS OPEN FLAG, not solved here: "we still need to be aware that people are not
// being removed with this software." A leaver is removed in METRC, not in CannaQMS,
// so nothing here notices. Needs its own decision.
export const userFacilitiesTable = pgTable(
  "user_facilities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    // Free text against the same role vocabulary the user carries. Null = they work
    // at this site under their normal role; set = the role they hold HERE, for the
    // case where the same person is an operator at one plant and a supervisor at
    // another. Nothing reads it yet.
    roleAtFacility: text("role_at_facility"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userFacilityUnique: uniqueIndex("user_facilities_user_facility_key").on(t.userId, t.facilityId),
  }),
);

export const insertUserFacilitySchema = createInsertSchema(userFacilitiesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUserFacility = z.infer<typeof insertUserFacilitySchema>;
export type UserFacility = typeof userFacilitiesTable.$inferSelect;
