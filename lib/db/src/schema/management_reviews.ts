import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { managementReviewSnapshotsTable } from "./management_review_snapshots";

// Management Review — Phase 2 (2026-08-08). A recordable, 21 CFR Part 11-signed
// review meeting built on a Phase-1 data snapshot. Captures attendees, per-section
// discussion notes, ISO 13485 §5.6.3 outputs, and action items that carry forward
// to the next review. status: "draft" (editable) → "signed" (locked).
export const managementReviewsTable = pgTable("management_reviews", {
  id: serial("id").primaryKey(),
  snapshotId: integer("snapshot_id").references(() => managementReviewSnapshotsTable.id),
  reviewDate: text("review_date"),            // ISO date the meeting was held
  periodStart: text("period_start"),          // copied from the snapshot for the record
  periodEnd: text("period_end"),
  status: text("status").notNull().default("draft"), // "draft" | "signed"
  attendees: jsonb("attendees"),              // [{ name, role }]
  sectionNotes: jsonb("section_notes"),       // { quality: "...", operations: "...", ... }
  outputs: text("outputs"),                   // §5.6.3 decisions / outputs
  generalNotes: text("general_notes"),
  signedByUserId: integer("signed_by_user_id").references(() => usersTable.id),
  signedByName: text("signed_by_name"),
  signedInitials: text("signed_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Action items from a review. Open items carry forward into the next review
// (carriedFromReviewId records which review they came from).
export const managementReviewActionItemsTable = pgTable("management_review_action_items", {
  id: serial("id").primaryKey(),
  reviewId: integer("review_id").notNull().references(() => managementReviewsTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  ownerUserId: integer("owner_user_id").references(() => usersTable.id),
  ownerName: text("owner_name"),
  dueDate: text("due_date"),                  // ISO date
  status: text("status").notNull().default("Open"), // "Open" | "Done"
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByName: text("completed_by_name"),
  carriedFromReviewId: integer("carried_from_review_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ManagementReview = typeof managementReviewsTable.$inferSelect;
export type ManagementReviewActionItem = typeof managementReviewActionItemsTable.$inferSelect;
