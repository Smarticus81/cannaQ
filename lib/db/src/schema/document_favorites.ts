import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

// Per-user document favorites (2026-08-13). A "star" a user places on a
// controlled document to pin it to the top of THEIR Document Control list.
// Keyed by Clerk user id (the same identity the rest of the app authorizes on),
// so a star is private to each user and follows them across sessions/devices.
// One row per (user, document); starring is idempotent (unique constraint +
// ON CONFLICT DO NOTHING). Rows are removed when the document is hard-deleted
// (cascade) - documents are normally cancelled, not deleted, so a star survives
// a cancel and simply stops showing once the doc leaves the active list.
export const documentFavoritesTable = pgTable("document_favorites", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull(),
  documentId: integer("document_id")
    .notNull()
    .references(() => documentsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqUserDoc: unique("uniq_document_favorites_user_doc").on(t.clerkUserId, t.documentId),
}));

export const insertDocumentFavoriteSchema = createInsertSchema(documentFavoritesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDocumentFavorite = z.infer<typeof insertDocumentFavoriteSchema>;
export type DocumentFavorite = typeof documentFavoritesTable.$inferSelect;
