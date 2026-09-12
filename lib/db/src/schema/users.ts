import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Canonical facility departments (2026-07-21). One shared vocabulary for user
// assignment, documents, and training so training can be targeted by Role ×
// Department and the old free-text department values converge on one list.
// A user can belong to SEVERAL departments (e.g. Cultivation AND Extraction),
// so users.departments is an array.
export const DEPARTMENTS = [
  "Cultivation",
  "Extraction",
  "Kitchen / Edibles",
  "Production",
  "Packaging & Labeling",
  "Quality / Lab",
  "Inventory / Warehouse",
  "Shipping / Distribution",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").unique(),
  // WHICH SITE THIS PERSON IS ACTING FOR right now (multi-facility Phase 4).
  // Not "where they work" — that is user_facilities, and it can be several places.
  // This is the one they have switched to, and it decides what every screen shows
  // them and which facility their new records belong to.
  //
  // Null = they have not chosen, so the app uses the first site they are listed at.
  // It is stored on the person rather than held in the browser because it decides
  // what data they are allowed to see: a value the browser could set would be a
  // value the browser could lie about.
  activeFacilityId: integer("active_facility_id"),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  initials: text("initials").notNull(),
  role: text("role").notNull().default("Operator"),
  // Departments the user works in (multi-select checklist). Empty = unassigned.
  // Used to target training by Role × Department. Values come from DEPARTMENTS.
  departments: text("departments").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
