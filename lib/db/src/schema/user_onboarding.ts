import { pgTable, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userOnboardingTable = pgTable("user_onboarding", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id),
  revision: integer("revision").notNull().default(0),
  draft: jsonb("draft").notNull().default({}),
  completedRevision: integer("completed_revision"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deferredAt: timestamp("deferred_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
