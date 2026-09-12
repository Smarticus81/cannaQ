import { pgTable, serial, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

export const batchLabelingTable = pgTable("batch_labeling", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }).unique(),
  productType: text("product_type").notNull(),
  labelVersion: text("label_version"),
  metrcTagNumber: text("metrc_tag_number"),
  labelNotes: text("label_notes"),
  approvedBy: integer("approved_by").references(() => usersTable.id),
  approvalName: text("approval_name"),
  approvalInitials: text("approval_initials"),
  // Session 67 (Item 5) — Part 11 meaning of the labeling-approval signature.
  approvalMeaning: text("approval_meaning"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  checklistCompletePct: real("checklist_complete_pct"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const checklistItemsTable = pgTable("checklist_items", {
  id: serial("id").primaryKey(),
  labelingId: integer("labeling_id").notNull().references(() => batchLabelingTable.id, { onDelete: "cascade" }),
  productType: text("product_type").notNull(),
  itemNumber: integer("item_number").notNull(),
  itemText: text("item_text").notNull(),
  regulationRef: text("regulation_ref").notNull(),
  required: text("required").notNull().default("true"),
  // "Packaging" (approved once with the design) or "Labeling" (checked every
  // print). Nullable: rows seeded before 2026-08-30 have no control recorded.
  control: text("control"),
  // The requirement's STABLE key. itemNumber is positional and moves whenever a
  // list is rebuilt, so an answered row needs this to stay traceable to what it
  // was actually answering. Nullable for rows written before 2026-08-30.
  requirementKey: text("requirement_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const checklistResponsesTable = pgTable("checklist_responses", {
  id: serial("id").primaryKey(),
  checklistItemId: integer("checklist_item_id").notNull().references(() => checklistItemsTable.id, { onDelete: "cascade" }).unique(),
  response: text("response").notNull(),
  notes: text("notes"),
  respondedBy: integer("responded_by").references(() => usersTable.id),
  respondedByName: text("responded_by_name"),
  respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchLabelingSchema = createInsertSchema(batchLabelingTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBatchLabeling = z.infer<typeof insertBatchLabelingSchema>;
export type BatchLabeling = typeof batchLabelingTable.$inferSelect;

export const insertChecklistItemSchema = createInsertSchema(checklistItemsTable).omit({ id: true, createdAt: true });
export type InsertChecklistItem = z.infer<typeof insertChecklistItemSchema>;
export type ChecklistItem = typeof checklistItemsTable.$inferSelect;

export const insertChecklistResponseSchema = createInsertSchema(checklistResponsesTable).omit({ id: true, respondedAt: true, updatedAt: true });
export type InsertChecklistResponse = z.infer<typeof insertChecklistResponseSchema>;
export type ChecklistResponse = typeof checklistResponsesTable.$inferSelect;

// Session 40 (Tier 3 #12d) — production-print log. Every successful render of
// a non-draft label PDF inserts a row here, so "when was this batch last
// printed and by whom" is queryable without grepping the audit log. Draft
// previews (?draft=1) are NOT logged — those are explicit walk-throughs.
// Stamping the template name + version at print time means later renames or
// retirements don't rewrite history.
export const batchLabelPrintsTable = pgTable("batch_label_prints", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  labelTemplateId: integer("label_template_id"),
  labelTemplateName: text("label_template_name"),
  labelTemplateVersion: integer("label_template_version"),
  printedById: integer("printed_by_id").references(() => usersTable.id),
  printedByName: text("printed_by_name"),
  printedAt: timestamp("printed_at", { withTimezone: true }).notNull().defaultNow(),
  // #3 (2026-07-22) - per-run second-person review (21 CFR Part 11). Every
  // print run (data-file download or legacy PDF) logs here in review_status
  // "pending"; a separate qualified person (Quality/Supervisor) signs it off,
  // which stamps the reviewer fields and flips it to "reviewed".
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewedById: integer("reviewed_by_id").references(() => usersTable.id),
  reviewedByName: text("reviewed_by_name"),
  reviewerInitials: text("reviewer_initials"),
  reviewerMeaning: text("reviewer_meaning"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rowCount: integer("row_count"),
  exportFormat: text("export_format"),
});

export const insertBatchLabelPrintSchema = createInsertSchema(batchLabelPrintsTable).omit({ id: true, printedAt: true });
export type InsertBatchLabelPrint = z.infer<typeof insertBatchLabelPrintSchema>;
export type BatchLabelPrint = typeof batchLabelPrintsTable.$inferSelect;

// Session 40 (Tier 3 #12b) — MI-MRA pre-print verification checklist
// templates, keyed by product type. The auto-populate endpoint copies these
// into the per-batch `checklist_items` table so each batch has its own
// addressable list (responses are batch-scoped). Holding the canonical list
// in code keeps regulation-reference updates in source control with a clear
// diff; promoting to a regulator-approvable `checklist_item_templates` table
// is a future cleanup if/when a third consumer needs the same surface.
//
// Item numbering is stable per product type so re-running auto-populate is
// idempotent (we look up existing items by (labelingId, itemNumber)).
export type ChecklistTemplateItem = {
  /**
   * STABLE identity for a requirement, shared across product types.
   *
   * itemNumber is positional and shifts whenever a list is rebuilt — the
   * 2026-08-30 rewrite renumbered every one of them. A facility's decision about
   * WHICH checklist a requirement belongs to has to survive that, so it hangs off
   * this instead. Shared on purpose: "warn-pregnancy" is one requirement assigned
   * once, not seven near-identical rows across seven product types.
   *
   * ⛔ Never renumber a key or reuse one for a different requirement.
   */
  key: string;
  itemNumber: number;
  itemText: string;
  regulationRef: string;
  required: boolean;
  /**
   * WHICH control this question belongs to.
   * "Packaging" — fixed artwork, verified ONCE when the packaging design is approved.
   * "Labeling"  — changes per batch, verified BEFORE EVERY PRINT.
   * Optional so a state rule set written before this field still loads.
   */
  control?: "Packaging" | "Labeling";
};

// ⛔ REWRITTEN 2026-08-30. The previous set cited R 420.701-420.705, which in the
// Michigan rules are Definitions and the HEARING and SUSPENSION procedures — not
// labelling. Every citation below is read from R 420.502 / 420.504 / 420.403 /
// 420.404 and cross-checked against the CRA Best Practices bulletin (23 Feb 2023,
// pp.41-46, "Compliance Labeling Requirements by Product Type").
//
// `control` splits Jonathan's two cadences: Packaging is fixed artwork approved
// ONCE with the design; Labeling changes per batch and is checked BEFORE EVERY
// PRINT. Both are still seeded into the per-print checklist for now — routing the
// Packaging half to the design review is the next step, and dropping them before
// that lands would leave those checks recorded nowhere.
//
// ⛔ Nothing here is a company standard dressed as a rule. Requirements the CRA
// does not impose were REMOVED, not re-cited: per-unit count, per-unit weight,
// servings per package, extraction method, printed residual-solvent and vitamin-E
// results, allergen statements on topicals (the bulletin's topical list, p.46,
// has no allergen item — only the edible list, p.45, does).

const FLOWER_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Producer state licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "packager-licence", itemNumber: 3, control: "Packaging", itemText: "Packager name and licence number, if different from the producer", regulationRef: "R 420.504(1)(b)", required: false },
  { key: "net-weight", itemNumber: 4, control: "Packaging", itemText: "Net weight in US customary or metric units", regulationRef: "R 420.504(1)(e)", required: true },
  { key: "potency-variance-statement", itemNumber: 5, control: "Packaging", itemText: "Statement that the actual THC/CBD value may vary from the reported value by 10%", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "activation-time", itemNumber: 6, control: "Packaging", itemText: "Activation time expressed in words or through a pictogram", regulationRef: "R 420.504(1)(g)", required: true },
  { key: "universal-symbol", itemNumber: 7, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "warn-driving", itemNumber: 8, control: "Packaging", itemText: "Warning: \"It is illegal to drive a motor vehicle while under the influence of marihuana.\"", regulationRef: "R 420.504(1)(j)(i)", required: true },
  { key: "warn-poison-control", itemNumber: 9, control: "Packaging", itemText: "Warning: \"National Poison Control Center 1-800-222-1222.\"", regulationRef: "R 420.504(1)(j)(ii)", required: true },
  { key: "warn-age-au", itemNumber: 10, control: "Packaging", itemText: "For Adult-Use products: \"For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iv)", required: true },
  { key: "warn-pregnancy", itemNumber: 11, control: "Packaging", itemText: "Pregnancy warning verbatim, in legible type and surrounded by a continuous heavy line", regulationRef: "R 420.504(1)(j)(v)", required: true },
  { key: "metrc-tag", itemNumber: 12, control: "Labeling", itemText: "METRC package tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "potency-values", itemNumber: 13, control: "Labeling", itemText: "THC and CBD concentration as reported by the laboratory", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "lab-name-and-date", itemNumber: 14, control: "Labeling", itemText: "Name of the laboratory that performed passing compliance testing, and the test analysis date", regulationRef: "R 420.504(1)(h)", required: true },
  { key: "harvest-date", itemNumber: 15, control: "Labeling", itemText: "Date of harvest", regulationRef: "R 420.504(1)(c)", required: true },
  { key: "strain-name", itemNumber: 16, control: "Labeling", itemText: "Name of strain", regulationRef: "R 420.504(1)(d)", required: true },
  { key: "warn-age-med", itemNumber: 17, control: "Packaging", itemText: "For Medical products ONLY: \"For use by registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iii)", required: false },
];

const CONCENTRATE_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Producer state licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "packager-licence", itemNumber: 3, control: "Packaging", itemText: "Packager name and licence number, if different from the producer", regulationRef: "R 420.504(1)(b)", required: false },
  { key: "net-weight", itemNumber: 4, control: "Packaging", itemText: "Net weight in US customary or metric units", regulationRef: "R 420.504(1)(e)", required: true },
  { key: "potency-variance-statement", itemNumber: 5, control: "Packaging", itemText: "Statement that the actual THC/CBD value may vary from the reported value by 10%", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "activation-time", itemNumber: 6, control: "Packaging", itemText: "Activation time expressed in words or through a pictogram", regulationRef: "R 420.504(1)(g)", required: true },
  { key: "universal-symbol", itemNumber: 7, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "warn-driving", itemNumber: 8, control: "Packaging", itemText: "Warning: \"It is illegal to drive a motor vehicle while under the influence of marihuana.\"", regulationRef: "R 420.504(1)(j)(i)", required: true },
  { key: "warn-poison-control", itemNumber: 9, control: "Packaging", itemText: "Warning: \"National Poison Control Center 1-800-222-1222.\"", regulationRef: "R 420.504(1)(j)(ii)", required: true },
  { key: "warn-age-au", itemNumber: 10, control: "Packaging", itemText: "For Adult-Use products: \"For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iv)", required: true },
  { key: "warn-pregnancy", itemNumber: 11, control: "Packaging", itemText: "Pregnancy warning verbatim, in legible type and surrounded by a continuous heavy line", regulationRef: "R 420.504(1)(j)(v)", required: true },
  { key: "metrc-tag", itemNumber: 12, control: "Labeling", itemText: "METRC package tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "potency-values", itemNumber: 13, control: "Labeling", itemText: "THC and CBD concentration as reported by the laboratory", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "lab-name-and-date", itemNumber: 14, control: "Labeling", itemText: "Name of the laboratory that performed passing compliance testing, and the test analysis date", regulationRef: "R 420.504(1)(h)", required: true },
  { key: "harvest-date", itemNumber: 15, control: "Labeling", itemText: "Date of harvest, only on products that include flower", regulationRef: "R 420.504(1)(c)", required: false },
  { key: "strain-name", itemNumber: 16, control: "Labeling", itemText: "Name of strain, only on products that include flower", regulationRef: "R 420.504(1)(d)", required: false },
  { key: "warn-age-med", itemNumber: 17, control: "Packaging", itemText: "For Medical products ONLY: \"For use by registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iii)", required: false },
];

const EDIBLE_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Producer state licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "packager-licence", itemNumber: 3, control: "Packaging", itemText: "Packager name and licence number, if different from the producer", regulationRef: "R 420.504(1)(b)", required: false },
  { key: "net-weight", itemNumber: 4, control: "Packaging", itemText: "Net weight or net volume of the product", regulationRef: "R 420.403(7)(c)", required: true },
  { key: "potency-variance-statement", itemNumber: 5, control: "Packaging", itemText: "Statement that the actual THC/CBD value may vary from the reported value by 10%", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "activation-time", itemNumber: 6, control: "Packaging", itemText: "Activation time expressed in words or through a pictogram", regulationRef: "R 420.504(1)(g)", required: true },
  { key: "universal-symbol", itemNumber: 7, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "warn-driving", itemNumber: 8, control: "Packaging", itemText: "Warning: \"It is illegal to drive a motor vehicle while under the influence of marihuana.\"", regulationRef: "R 420.504(1)(j)(i)", required: true },
  { key: "warn-poison-control", itemNumber: 9, control: "Packaging", itemText: "Warning: \"National Poison Control Center 1-800-222-1222.\"", regulationRef: "R 420.504(1)(j)(ii)", required: true },
  { key: "warn-age-au", itemNumber: 10, control: "Packaging", itemText: "For Adult-Use products: \"For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iv)", required: true },
  { key: "warn-pregnancy", itemNumber: 11, control: "Packaging", itemText: "Pregnancy warning verbatim, in legible type and surrounded by a continuous heavy line", regulationRef: "R 420.504(1)(j)(v)", required: true },
  { key: "product-name-modifier", itemNumber: 12, control: "Packaging", itemText: "Product name includes a modifier (\"marijuana product\", \"THC product\" or \"cannabis product\") in the same or larger font", regulationRef: "R 420.403(7)(a)", required: true },
  { key: "ingredients", itemNumber: 13, control: "Packaging", itemText: "Ingredients, including excipients and diluents, in descending order by weight", regulationRef: "R 420.403(7)(b)", required: true },
  { key: "inactive-ingredients", itemNumber: 14, control: "Packaging", itemText: "Non-marihuana inactive ingredients listed, FDA-approved for the intended use and below the maximum concentration", regulationRef: "R 420.403(6)", required: true },
  { key: "allergens", itemNumber: 15, control: "Packaging", itemText: "Allergen labelling per FALCPA, 21 USC 343", regulationRef: "R 420.403(7)(d)(i)", required: true },
  { key: "health-claims", itemNumber: 16, control: "Packaging", itemText: "Health or nutritional claim labelling per 21 CFR 101, if any claim is made", regulationRef: "R 420.403(7)(d)(ii)", required: false },
  { key: "metrc-tag", itemNumber: 17, control: "Labeling", itemText: "METRC package tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "potency-values", itemNumber: 18, control: "Labeling", itemText: "THC and CBD concentration as reported by the laboratory", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "lab-name-and-date", itemNumber: 19, control: "Labeling", itemText: "Name of the laboratory that performed passing compliance testing, and the test analysis date", regulationRef: "R 420.504(1)(h)", required: true },
  { key: "date-produced", itemNumber: 20, control: "Labeling", itemText: "Date the product was produced", regulationRef: "R 420.403(7)(e)", required: true },
  { key: "expiration-date", itemNumber: 21, control: "Labeling", itemText: "Expiration date on a shelf-stable edible", regulationRef: "R 420.403(11)(a)", required: true },
  { key: "thc-limits", itemNumber: 22, control: "Labeling", itemText: "THC per serving and per package within the agency maximum", regulationRef: "R 420.404", required: true },
  { key: "warn-age-med", itemNumber: 23, control: "Packaging", itemText: "For Medical products ONLY: \"For use by registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iii)", required: false },
  // ⛔ ADDED 2026-08-31. R 420.403(9) and (10) were imposed on every edible sold in
  // Michigan and NOTHING in this app asked about either — not here, not on the
  // packaging design, nowhere. Read from the rules PDF, not from memory: both
  // subrules are written against "an edible marihuana product", so they are on THIS
  // list only. (10) is split in two because the resealable half applies only to a
  // package holding more than one serving — which is exactly what an N/A answer is
  // for. (9) stays ONE question: it is four prohibitions on the same judgement, and
  // a person answers it (⛔ "appeal to minors is too subjective for a computer").
  { key: "container-opaque-child-resistant", itemNumber: 24, control: "Packaging", itemText: "Container is opaque and child-resistant, meeting the effectiveness specifications in 16 CFR 1700.15", regulationRef: "R 420.403(10)", required: true },
  { key: "container-resealable", itemNumber: 25, control: "Packaging", itemText: "If the package holds more than one serving, it is resealable, meeting the effectiveness specifications in 16 CFR 1700.15", regulationRef: "R 420.403(10)", required: false },
  { key: "not-appealing-to-minors", itemNumber: 26, control: "Packaging", itemText: "Packaging, labelling and product shape do not appeal to minors aged 17 or younger: no cartoons, caricatures, toys or designs aimed at them; not easily confused with a commercially available food product; the words candy or candies are not used; not the distinct shape of a human, animal or fruit", regulationRef: "R 420.403(9)", required: true },
];

const TOPICAL_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Producer state licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "packager-licence", itemNumber: 3, control: "Packaging", itemText: "Packager name and licence number, if different from the producer", regulationRef: "R 420.504(1)(b)", required: false },
  { key: "net-weight", itemNumber: 4, control: "Packaging", itemText: "Net weight or net volume of the product", regulationRef: "R 420.403(7)(c)", required: true },
  { key: "potency-variance-statement", itemNumber: 5, control: "Packaging", itemText: "Statement that the actual THC/CBD value may vary from the reported value by 10%", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "activation-time", itemNumber: 6, control: "Packaging", itemText: "Activation time expressed in words or through a pictogram", regulationRef: "R 420.504(1)(g)", required: true },
  { key: "universal-symbol", itemNumber: 7, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "warn-driving", itemNumber: 8, control: "Packaging", itemText: "Warning: \"It is illegal to drive a motor vehicle while under the influence of marihuana.\"", regulationRef: "R 420.504(1)(j)(i)", required: true },
  { key: "warn-poison-control", itemNumber: 9, control: "Packaging", itemText: "Warning: \"National Poison Control Center 1-800-222-1222.\"", regulationRef: "R 420.504(1)(j)(ii)", required: true },
  { key: "warn-age-au", itemNumber: 10, control: "Packaging", itemText: "For Adult-Use products: \"For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iv)", required: true },
  { key: "warn-pregnancy", itemNumber: 11, control: "Packaging", itemText: "Pregnancy warning verbatim, in legible type and surrounded by a continuous heavy line", regulationRef: "R 420.504(1)(j)(v)", required: true },
  { key: "product-name-modifier", itemNumber: 12, control: "Packaging", itemText: "Product name includes a modifier (\"marijuana product\", \"THC product\" or \"cannabis product\") in the same or larger font", regulationRef: "R 420.403(7)(a)", required: true },
  { key: "ingredients", itemNumber: 13, control: "Packaging", itemText: "Ingredients, including excipients and diluents, in descending order by weight", regulationRef: "R 420.403(7)(b)", required: true },
  { key: "inactive-ingredients", itemNumber: 14, control: "Packaging", itemText: "Non-marihuana inactive ingredients listed, FDA-approved for the intended use and below the maximum concentration", regulationRef: "R 420.403(6)", required: true },
  { key: "metrc-tag", itemNumber: 15, control: "Labeling", itemText: "METRC package tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "potency-values", itemNumber: 16, control: "Labeling", itemText: "THC and CBD concentration as reported by the laboratory", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "lab-name-and-date", itemNumber: 17, control: "Labeling", itemText: "Name of the laboratory that performed passing compliance testing, and the test analysis date", regulationRef: "R 420.504(1)(h)", required: true },
  { key: "date-produced", itemNumber: 18, control: "Labeling", itemText: "Date the product was produced", regulationRef: "R 420.403(7)(e)", required: true },
  { key: "warn-age-med", itemNumber: 19, control: "Packaging", itemText: "For Medical products ONLY: \"For use by registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iii)", required: false },
];

const GENERIC_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Producer state licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "packager-licence", itemNumber: 3, control: "Packaging", itemText: "Packager name and licence number, if different from the producer", regulationRef: "R 420.504(1)(b)", required: false },
  { key: "net-weight", itemNumber: 4, control: "Packaging", itemText: "Net weight in US customary or metric units", regulationRef: "R 420.504(1)(e)", required: true },
  { key: "potency-variance-statement", itemNumber: 5, control: "Packaging", itemText: "Statement that the actual THC/CBD value may vary from the reported value by 10%", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "activation-time", itemNumber: 6, control: "Packaging", itemText: "Activation time expressed in words or through a pictogram", regulationRef: "R 420.504(1)(g)", required: true },
  { key: "universal-symbol", itemNumber: 7, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "warn-driving", itemNumber: 8, control: "Packaging", itemText: "Warning: \"It is illegal to drive a motor vehicle while under the influence of marihuana.\"", regulationRef: "R 420.504(1)(j)(i)", required: true },
  { key: "warn-poison-control", itemNumber: 9, control: "Packaging", itemText: "Warning: \"National Poison Control Center 1-800-222-1222.\"", regulationRef: "R 420.504(1)(j)(ii)", required: true },
  { key: "warn-age-au", itemNumber: 10, control: "Packaging", itemText: "For Adult-Use products: \"For use by individuals 21 years of age or older or registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iv)", required: true },
  { key: "warn-pregnancy", itemNumber: 11, control: "Packaging", itemText: "Pregnancy warning verbatim, in legible type and surrounded by a continuous heavy line", regulationRef: "R 420.504(1)(j)(v)", required: true },
  { key: "metrc-tag", itemNumber: 12, control: "Labeling", itemText: "METRC package tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "potency-values", itemNumber: 13, control: "Labeling", itemText: "THC and CBD concentration as reported by the laboratory", regulationRef: "R 420.504(1)(f)", required: true },
  { key: "lab-name-and-date", itemNumber: 14, control: "Labeling", itemText: "Name of the laboratory that performed passing compliance testing, and the test analysis date", regulationRef: "R 420.504(1)(h)", required: true },
  { key: "warn-age-med", itemNumber: 15, control: "Packaging", itemText: "For Medical products ONLY: \"For use by registered qualifying patients only. Keep out of reach of children.\"", regulationRef: "R 420.504(1)(j)(iii)", required: false },
];

const BULK_TRANSFER_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "business-name", itemNumber: 1, control: "Packaging", itemText: "Business or trade name printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "producer-licence", itemNumber: 2, control: "Packaging", itemText: "Licence number printed", regulationRef: "R 420.504(1)(a)", required: true },
  { key: "universal-symbol", itemNumber: 3, control: "Packaging", itemText: "Universal symbol present", regulationRef: "R 420.504(1)(i)", required: true },
  { key: "metrc-tag", itemNumber: 4, control: "Labeling", itemText: "METRC package/transfer tag printed and legible", regulationRef: "R 420.504(1)(a); R 420.502(1)", required: true },
  { key: "strain-name", itemNumber: 5, control: "Labeling", itemText: "Name of the strain", regulationRef: "R 420.504(1)(d)", required: true },
  { key: "harvest-date", itemNumber: 6, control: "Labeling", itemText: "Date of harvest", regulationRef: "R 420.504(1)(c)", required: true },
  { key: "seed-strain", itemNumber: 7, control: "Labeling", itemText: "Seed strain, if applicable", regulationRef: "CRA Best Practices 23-Feb-2023 p.41 (no rule located)", required: false },
];

// Product types that share a list, per the bulletin's own groupings: a raw
// pre-roll is shake/trim (p.52) so it takes the Flower list; a vape cart and an
// infused pre-roll are both "inhalable compound concentrate" (p.44) so they take
// the Concentrate list. Fewer lists, and each one traceable to a page.
/**
 * Bumped whenever the CONTENT of these lists changes deliberately.
 *
 * A state's seeded copy carries the version it was written from; a boot pass
 * replaces it only when this number is higher. That is the one sanctioned way to
 * push a correction onto an already-seeded state — without it the 2026-08-30
 * rewrite would never have reached a database that already held the old set.
 *
 * v1 — the original set, citing R 420.701-705 (the hearings chapter). Wrong.
 * v2 — 2026-08-30, rebuilt from R 420.502/504/403/404 + the CRA bulletin.
 * v3 — 2026-08-30, stable `key` added to every requirement.
 */
export const LABEL_CHECKLIST_VERSION = 4;

export const LABEL_CHECKLIST_TEMPLATES: Record<string, ChecklistTemplateItem[]> = {
  Flower: FLOWER_CHECKLIST,
  "Pre-Roll": FLOWER_CHECKLIST,
  "Infused Pre-Roll": CONCENTRATE_CHECKLIST,
  Edible: EDIBLE_CHECKLIST,
  Concentrate: CONCENTRATE_CHECKLIST,
  Vape: CONCENTRATE_CHECKLIST,
  Topical: TOPICAL_CHECKLIST,
  Generic: GENERIC_CHECKLIST,
  BulkTransfer: BULK_TRANSFER_CHECKLIST,
};

// Normalize the many ways "bulk/wholesale" might be stored to the single
// canonical check. Anything else (incl. null/"Retail") is treated as retail.
export function isBulkSaleType(saleType: string | null | undefined): boolean {
  const s = (saleType ?? "").trim().toLowerCase();
  return s === "bulk" || s === "wholesale" || s.startsWith("bulk");
}

// Session 68 — bridge the create-batch dropdown's productType values to the
// LABEL_CHECKLIST_TEMPLATES keys above. The dropdown offers labels like
// "Vape Cartridge" that don't equal the template key ("Vape"); without this
// alias the seed lookup returned [] → an empty checklist → the labeling
// approval gate passed VACUOUSLY (signing nothing). Tincture and Capsule are
// oral, mg-dosed ingestibles with no MI-specific rule of their own, so they
// ride the Edible checklist (R 420.702). "Other" → the universal Generic core.
// Anything NOT listed here still falls through to a direct key match below, so
// the six product types whose dropdown label already equals the template key
// (Edible, Concentrate, Topical, Pre-Roll, plus Flower) keep working unchanged.
const PRODUCT_TYPE_TO_CHECKLIST_KEY: Record<string, string> = {
  "Vape Cartridge": "Vape",
  // 2026-08-27 — added with the template map below. Dual Chamber was in NEITHER
  // vocabulary, so it resolved to an empty checklist — and an empty checklist fails
  // CLOSED, blocking label approval on a product type that has existed since July.
  "Dual Chamber Vape Cartridge": "Vape",
  "Tincture": "Edible",
  "Capsule": "Edible",
  "Other": "Generic",
};

// Resolve a batch's productType to its checklist template. Order: normalize →
// alias map → direct key match → []. Returning [] is now SAFE because the
// approval gate fails closed on an empty checklist (Session 68); a [] here means
// "no template for this product type" and approval is blocked until one exists.
export function checklistTemplateFor(
  productType: string | null | undefined,
  saleType?: string | null,
): ChecklistTemplateItem[] {
  return checklistTemplateFrom(LABEL_CHECKLIST_TEMPLATES, productType, saleType);
}

/**
 * The same resolution, against a SUPPLIED set of templates.
 *
 * Phase 5 — which questions a label is checked against is a STATE rule, so the
 * set now comes from the facility's rule set rather than from the constants in
 * this file. What does NOT move is the vocabulary: PRODUCT_TYPE_TO_CHECKLIST_KEY
 * maps a batch's product type onto a checklist key ("Vape Cartridge" -> "Vape"),
 * and that is an app naming concern, not something a regulator has a view on.
 *
 * ⛔ Returning [] stays SAFE and deliberate: the approval gate fails CLOSED on an
 * empty checklist (Session 68), so an unmapped product type blocks approval
 * rather than waving a label through unchecked.
 */
export function checklistTemplateFrom(
  templates: Record<string, ChecklistTemplateItem[]>,
  productType: string | null | undefined,
  saleType?: string | null,
): ChecklistTemplateItem[] {
  // Bulk/wholesale transfer overrides the product-type consumer checklist:
  // a bulk package is a transfer unit, not a retail-ready consumer unit.
  if (isBulkSaleType(saleType)) return templates["BulkTransfer"] ?? BULK_TRANSFER_CHECKLIST;
  const key = (productType ?? "").trim();
  const mapped = PRODUCT_TYPE_TO_CHECKLIST_KEY[key] ?? key;
  return templates[mapped] ?? [];
}

// Session 68 aliased the CHECKLIST lookup but not the label TEMPLATE lookup, so
// a "Vape Cartridge" batch seeded the right checklist while the template query
// went looking for a template whose productType was literally "Vape Cartridge".
// The batch reported "No label template exists… Create one in Label Studio" while
// pointing the operator at a template that was already sitting there.
//
// 2026-08-27 — that fix borrowed the CHECKLIST map, and the two vocabularies are
// not the same list. Label Studio stores SIX product types; the checklist has NINE
// keys. "Infused Pre-Roll" is a real checklist key and not a Label Studio type at
// all, so it passed through the borrowed map unchanged and hit the same wall the
// alias was added to remove — as did "Dual Chamber Vape Cartridge", which is in
// neither map. Two vocabularies, two maps, both explicit and covering every one of
// the ten product types, so a new type cannot silently fall through again.
//
// ⚠️ Keep this in step with PRODUCT_TYPES (cannaqms/src/lib/productTypes.ts, the
// ten canonical categories) and with the six types Label Studio offers.
const PRODUCT_TYPE_TO_LABEL_TEMPLATE_KEY: Record<string, string> = {
  Flower: "Flower",
  "Pre-Roll": "Pre-Roll",
  // Label Studio has no infused pre-roll template: the label is a pre-roll label
  // whose warning and potency blocks differ, which is template CONTENT, not a
  // different template type.
  "Infused Pre-Roll": "Pre-Roll",
  "Vape Cartridge": "Vape",
  // Two chambers, one cartridge — the label is a vape label. The per-chamber
  // testing regime that makes it its own product type does not change that.
  "Dual Chamber Vape Cartridge": "Vape",
  Concentrate: "Concentrate",
  Edible: "Edible",
  Tincture: "Edible",
  Capsule: "Edible",
  Topical: "Topical",
};

/**
 * The Label Studio template key for a batch's product type.
 *
 * Returns null when the type has no template type it belongs to — "Other", or a
 * product type added to PRODUCT_TYPES without being mapped here. Null is deliberate
 * and better than passing the raw type through: a query for a template that cannot
 * exist returns nothing and reports "no template, create one", sending someone to
 * Label Studio to build a template for a type it does not offer.
 */
export function labelTemplateKeyFor(productType: string | null | undefined): string | null {
  const key = (productType ?? "").trim();
  if (!key) return null;
  return PRODUCT_TYPE_TO_LABEL_TEMPLATE_KEY[key] ?? null;
}
