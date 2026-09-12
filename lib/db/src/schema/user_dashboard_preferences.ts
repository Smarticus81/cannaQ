import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-user dashboard layout (2026-07-21). One row per Clerk user.
// `layout` is the ordered list of widget configs the user has chosen — an
// override on top of the role-based default (Quality / Production). A user with
// NO row falls back to the default template for their role, so this table only
// stores people who have customised their dashboard.
// Shape of each layout entry (validated app-side, stored as jsonb):
//   { widgetId: string; visible: boolean; order: number; variant?: "tile" | "table" | "chart" }
export const userDashboardPreferencesTable = pgTable("user_dashboard_preferences", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  baseTemplate: text("base_template"), // "Quality" | "Production" — which default they started from
  layout: jsonb("layout").notNull(), // array of widget-config objects (see note above)
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserDashboardPreferencesSchema = createInsertSchema(userDashboardPreferencesTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertUserDashboardPreferences = z.infer<typeof insertUserDashboardPreferencesSchema>;
export type UserDashboardPreferences = typeof userDashboardPreferencesTable.$inferSelect;
