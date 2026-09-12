import { pgTable, serial, integer, text, boolean, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldActionsTable } from "./field_actions";
import { usersTable } from "./users";

// Per-store response-actions tracking for a Field Action (Session 13, feedback
// item 21). Each row captures the dispensary / retailer notification, return,
// and destruction status for product distributed to a single licensee.
//
// Replaces the free-text `field_actions.response_actions` column for new
// work; the legacy column is preserved on the FA row for back-compat and
// surfaced as a "Legacy notes" affordance in the UI when populated.
export const faResponseActionsTable = pgTable("fa_response_actions", {
  id: serial("id").primaryKey(),
  fieldActionId: integer("field_action_id")
    .notNull()
    .references(() => fieldActionsTable.id, { onDelete: "cascade" }),

  // Recipient identification.
  storeName: text("store_name").notNull(),
  storeLicenseNumber: text("store_license_number"), // METRC / state licensee #

  // Point-of-contact for the notification.
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),

  // Notification event.
  notificationDate: date("notification_date"),
  // Phone | Email | In-Person | Certified Mail | Other
  method: text("method"),
  confirmationReference: text("confirmation_reference"),

  // Reconciliation.
  unitsAffected: integer("units_affected"),
  unitsReturned: integer("units_returned"),
  productReturned: boolean("product_returned").notNull().default(false),
  productDestroyed: boolean("product_destroyed").notNull().default(false),
  // Response form received (the signed form sent back) — a distinct progress
  // step from returned/destroyed (2026-08-09).
  responseFormReceived: boolean("response_form_received").notNull().default(false),
  responseFormReceivedDate: date("response_form_received_date"),

  // Session 63.5 — a response is not the same as a resolution. A store can
  // answer for 20 of the 40 units it holds; the row is still open on the other
  // 20. This is the flag that says every unit sent to THIS licensee is now
  // accounted for — returned, destroyed, sold through, or written off — and a
  // field action cannot be closed while any row still has it unticked.
  allItemsAccounted: boolean("all_items_accounted").notNull().default(false),

  notes: text("notes"),

  // Audit columns — who recorded the entry. Full edit history lives in
  // audit_log (table_name="fa_response_actions").
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFaResponseActionSchema = createInsertSchema(faResponseActionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFaResponseAction = z.infer<typeof insertFaResponseActionSchema>;
export type FaResponseAction = typeof faResponseActionsTable.$inferSelect;
