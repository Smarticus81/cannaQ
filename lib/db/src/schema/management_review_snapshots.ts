import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Management Review snapshots (2026-08-06). The live Management Review shows the
// LATEST stored snapshot; it's regenerated on the first of each quarter (lazily,
// on the first load after the quarter turns) or on demand via the "Update"
// button. `data` holds the computed section payload; period_start/period_end
// frame the rolling-12-month window it covers. `trigger` records how it was made.
export const managementReviewSnapshotsTable = pgTable("management_review_snapshots", {
  id: serial("id").primaryKey(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  generatedByName: text("generated_by_name"),
  trigger: text("trigger").notNull().default("auto"), // "auto" (quarterly) | "manual" (Update button)
  periodStart: text("period_start"), // ISO date the 12-month window starts
  periodEnd: text("period_end"),     // ISO date the snapshot was taken (as-of)
  data: jsonb("data").notNull(),
});

export const insertManagementReviewSnapshotSchema = createInsertSchema(managementReviewSnapshotsTable).omit({ id: true, generatedAt: true });
export type InsertManagementReviewSnapshot = z.infer<typeof insertManagementReviewSnapshotSchema>;
export type ManagementReviewSnapshot = typeof managementReviewSnapshotsTable.$inferSelect;
