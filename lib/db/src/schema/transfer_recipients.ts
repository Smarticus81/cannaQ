import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Outbound-manifest recipient directory (Phase 1). A saved list of licensed
// counterparties a manifest can ship to — NOT just retailers: a processor can
// ship distillate to another processor, trade samples to a lab, etc. So a row is
// any licensed destination, tagged with its licenseType. Avoids re-typing /
// mistyping license numbers on every manifest. Additive; app-managed.
export const transferRecipientsTable = pgTable("transfer_recipients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  licenseNumber: text("license_number").notNull(),
  // Retailer | Processor | Grower | Safety Compliance Facility | Other — free text
  // so it stays flexible across states; drives nothing structural, just display/filter.
  licenseType: text("license_type").notNull().default("Retailer"),
  address1: text("address1"),
  addressCity: text("address_city"),
  addressState: text("address_state"),
  addressPostalCode: text("address_postal_code"),
  mainPhone: text("main_phone"),
  notes: text("notes"),
  // Soft-retire instead of delete so historical manifests keep a valid reference.
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTransferRecipientSchema = createInsertSchema(transferRecipientsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type TransferRecipient = typeof transferRecipientsTable.$inferSelect;
export type InsertTransferRecipient = z.infer<typeof insertTransferRecipientSchema>;
