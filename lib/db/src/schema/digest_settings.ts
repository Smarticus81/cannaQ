import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const digestSettingsTable = pgTable("digest_settings", {
  id: serial("id").primaryKey(),
  complianceRecipients: text("compliance_recipients").notNull().default(""),
  inventoryRecipients: text("inventory_recipients").notNull().default(""),
  sendHourUtc: integer("send_hour_utc").notNull().default(12),
  sendDayOfWeek: integer("send_day_of_week").notNull().default(1),
  enabled: integer("enabled").notNull().default(1),
  lastComplianceSentAt: timestamp("last_compliance_sent_at", { withTimezone: true }),
  lastInventorySentAt: timestamp("last_inventory_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type DigestSettings = typeof digestSettingsTable.$inferSelect;
