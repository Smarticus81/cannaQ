import { pgTable, serial, text, date, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Session 66 — E5 Regulatory Intelligence Agent (Tier 6, Wave 1). External and
// standalone: a regulatory bulletin is ingested (pasted, or fetched once from a
// URL), Claude summarizes it, assigns a severity, and maps it against the
// facility's live controlled documents + label templates to flag likely impacts.
//
// Tier 6 design rules honored here: the human is always actor-of-record — the
// agent PROPOSES (summary, severity, impacted items, suggested actions) and a
// reviewer DISPOSES (Reviewed / Dismissed / Actioned). The AI output columns are
// advisory and overridable; `ai_model` records which model produced them so the
// suggestion is attributable (lightweight ISO 42001 provenance — full
// accept/reject logging is deferred per the features-first decision).
export const REGULATORY_SEVERITIES = ["Informational", "Advisory", "Action Required"] as const;
export type RegulatorySeverity = (typeof REGULATORY_SEVERITIES)[number];

export const REGULATORY_STATUSES = ["New", "Reviewed", "Dismissed", "Actioned"] as const;
export type RegulatoryStatus = (typeof REGULATORY_STATUSES)[number];

export const regulatoryUpdatesTable = pgTable("regulatory_updates", {
  id: serial("id").primaryKey(),
  // Provenance of the bulletin itself.
  source: text("source").notNull(),                 // e.g. "MI CRA Bulletin", "FDA cGMP (21 CFR 117)"
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  publishedDate: date("published_date"),
  rawText: text("raw_text"),

  // AI output (advisory).
  aiSummary: text("ai_summary"),
  severity: text("severity").notNull().default("Informational"),
  impactedDocuments: jsonb("impacted_documents"),        // [{ docId, docNumber, title, reason }]
  impactedLabelTemplates: jsonb("impacted_label_templates"), // [{ templateId, name, reason }]
  suggestedActions: jsonb("suggested_actions"),          // string[]
  // 2026-08-09 — the follow-up thread: CAPAs / documents this bulletin triggered,
  // so "rule change → the change we made" is traceable. [{ type:"capa"|"document", id, label }]
  linkedActions: jsonb("linked_actions"),
  aiModel: text("ai_model"),

  // Human disposition.
  status: text("status").notNull().default("New"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRegulatoryUpdateSchema = createInsertSchema(regulatoryUpdatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type RegulatoryUpdate = typeof regulatoryUpdatesTable.$inferSelect;
export type InsertRegulatoryUpdate = z.infer<typeof insertRegulatoryUpdateSchema>;
