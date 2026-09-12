import { pgTable, serial, text, real, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const regulatoryConfigTable = pgTable("regulatory_config", {
  id: serial("id").primaryKey(),
  state: text("state").notNull().unique(),
  maxThcPerServing: real("max_thc_per_serving").notNull().default(10),
  maxThcPerContainer: real("max_thc_per_container").notNull().default(200),
  potencyTolerancePct: real("potency_tolerance_pct").notNull().default(10),
  retentionYears: integer("retention_years").notNull().default(4),
  tracingSystem: text("tracing_system"),
  additionalConfig: jsonb("additional_config"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRegulatoryConfigSchema = createInsertSchema(regulatoryConfigTable).omit({ id: true, updatedAt: true });
export type InsertRegulatoryConfig = z.infer<typeof insertRegulatoryConfigSchema>;
export type RegulatoryConfig = typeof regulatoryConfigTable.$inferSelect;
