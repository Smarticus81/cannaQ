import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

// Structured sections that drive the Print Batch Record output when a batch
// links to this document (only Specification-type docs are linkable).
//
// `kind` controls how the section is rendered:
//   - 'header'              → batch header (auto-rendered from batch + spec metadata)
//   - 'ingredients'         → batch_ingredients lines CONSUMED IN MANUFACTURING
//                             (kind Ingredient + Material), planned vs actual.
//                             Mirrors the batch screen's Ingredients tab.
//   - 'packaging'           → batch_ingredients lines consumed AT PACKAGING:
//                             kind Packaging, plus any line whose catalog item
//                             type is a Label. Mirrors the Packaging tab. The
//                             two sections together cover every line, split the
//                             way the work actually happens — weigh-out first,
//                             packaging and labeling at the end.
//                             NOTE: one label line per batch assumes ONE label
//                             lot covers the run (true for Michigan). A state
//                             that can change label lot mid-batch needs a
//                             per-unit-range model instead.
//   - 'in_process_checks'   → checklist responses joined to checklist_items
//   - 'tests'               → batch_testing rows
//   - 'yield'               → outputQuantity vs theoretical (computed)
//   - 'signoffs'            → batch e-sigs (release approver) + spec approver
//   - 'room_environmental'  → free text from spec (room conditions / environmental controls)
//   - 'equipment'           → free text from spec (equipment list / maintenance)
//   - 'free_text'           → arbitrary spec content rendered verbatim
//   - 'process_steps'       → renders the linked recipe's recipe_process_steps
//                             (hybrid doc<->process bridge); the procedure shown
//                             here is the SAME steps the operator executes on a
//                             batch — single source of truth. Requires the
//                             document to have a recipeId set.
//
// For every kind the spec author can supply optional `bodyMarkdown` that is
// shown as supplementary notes; for 'free_text' / 'room_environmental' /
// 'equipment' kinds the body is the entire content.
export const SECTION_KINDS = [
  "header",
  "ingredients",
  "packaging",
  "in_process_checks",
  "tests",
  "yield",
  "signoffs",
  "room_environmental",
  "equipment",
  "free_text",
  "process_steps",
  // SOP / Policy / Manual narrative sections (optional per document — a doc may
  // omit any that don't apply, e.g. Materials on a Pest Control or CAPA SOP).
  //   - 'definitions'          → free text (bodyMarkdown)
  //   - 'materials_equipment'  → list of tools/equipment (spatulas, scales, …) in
  //                              `data.items`; documentation only, NOT batch ingredients
  //                              (recipe-backed Work Instructions get materials from the recipe)
  //   - 'safety'               → free text (bodyMarkdown)
  //   - 'procedure'            → free text (bodyMarkdown)
  //   - 'associated_documents' → links to other controlled docs in `data.docs`
  //                              ([{ documentId, note? }]); rendered as clickable references
  //   - 'responsibilities'     → who does what, as a two-column table in
  //                              `data.roles` ([{ role, responsibility }]). Structured
  //                              rather than free text so it prints as a table and
  //                              stays consistent between documents.
  "definitions",
  "materials_equipment",
  "safety",
  "responsibilities",
  "procedure",
  "associated_documents",
] as const;
export type SectionKind = typeof SECTION_KINDS[number];

export const documentSectionsTable = pgTable("document_sections", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => documentsTable.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  bodyMarkdown: text("body_markdown"),
  // Structured payload for non-free-text SOP sections:
  //   associated_documents → { docs: [{ documentId: number, note?: string }] }
  //   materials_equipment  → { items: [{ name: string, note?: string }] }
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDocumentSectionSchema = createInsertSchema(documentSectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type DocumentSection = typeof documentSectionsTable.$inferSelect;
export type InsertDocumentSection = z.infer<typeof insertDocumentSectionSchema>;
