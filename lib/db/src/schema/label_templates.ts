import { pgTable, serial, text, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// MI MRA product categories that drive both static-block reuse and template
// defaults. New categories must be added explicitly so the seed and dropdown
// stay in sync.
export const PRODUCT_TYPES = [
  "Flower",
  "Pre-Roll",
  "Edible",
  "Concentrate",
  "Vape",
  "Topical",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

// A reusable static text block (e.g. "Pregnancy Warning", "Poison Control").
// Versioned + approvable so a regulatory change creates a new version without
// silently mutating prior labels.
export const labelStaticBlocksTable = pgTable("label_static_blocks", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  productType: text("product_type").notNull(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  regulationRef: text("regulation_ref"),
  version: integer("version").notNull().default(1),
  approvedById: integer("approved_by_id").references(() => usersTable.id),
  approvedByName: text("approved_by_name"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Region kinds the renderer knows how to lay out. Adding a new kind requires
// matching renderer support in the PDF and HTML preview code.
export const REGION_KINDS = [
  "brand-header",
  "product-info",
  "strain",
  "thc-cbd",
  "net-weight",
  "dates",
  "batch-metrc",
  "static-block",
  "divider",
  "spacer",
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

export const REGION_ALIGN = ["left", "center", "right"] as const;
export type RegionAlign = (typeof REGION_ALIGN)[number];

// One region in a template's vertical region list. Kept as a JSON column rather
// than a child table because regions are always edited as a whole and have no
// queryable cardinality requirement.
export const regionConfigSchema = z.object({
  id: z.string(),
  kind: z.enum(REGION_KINDS),
  enabled: z.boolean(),
  order: z.number().int(),
  fontSize: z.number().min(4).max(72).optional(),
  fontWeight: z.enum(["normal", "bold"]).optional(),
  align: z.enum(REGION_ALIGN).optional(),
  staticBlockId: z.number().int().optional(),
  customText: z.string().optional(),
  label: z.string().optional(),
});
export type RegionConfig = z.infer<typeof regionConfigSchema>;

// Session 39 (Tier 3 #12a) — label-template lifecycle: Draft → Regulatory
// Approved → Marketing Approved → Approved, plus a terminal Retired state.
// Distinct signers on the two approvals (Reg ≠ Mktg), and the originator
// (createdById) cannot sign either approval — mirrors CAPA Gate 1 segregation
// of duties (21 CFR Part 11).
//
// The legacy `approvedById` / `approvedByName` / `approvalDate` columns are
// retained — they get stamped at the moment Marketing signs the second of the
// two approvals, so downstream renderers (buildRenderedLabel) keep working
// without modification. The new per-approver columns hold the audit trail.
export const LABEL_TEMPLATE_STATUSES = [
  "draft",
  "regulatory_approved",
  "marketing_approved",
  "approved",
  "retired",
] as const;
export type LabelTemplateStatus = (typeof LABEL_TEMPLATE_STATUSES)[number];

export const labelTemplatesTable = pgTable("label_templates", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  productType: text("product_type").notNull(),
  name: text("name").notNull(),
  widthIn: real("width_in").notNull().default(2.0),
  heightIn: real("height_in").notNull().default(4.0),
  version: integer("version").notNull().default(1),
  regions: jsonb("regions").notNull().default([]),
  isDefault: boolean("is_default").notNull().default(false),
  // Session 39 — lifecycle state. Drives which approval action is exposed next
  // and which writes are still allowed. Legacy rows pre-Session-39 are
  // back-filled by the migration based on `approval_date`.
  status: text("status").notNull().default("draft"),
  // Originator — recorded at create time so the segregation-of-duties check
  // can refuse to let the same user sign their own approvals.
  createdById: integer("created_by_id").references(() => usersTable.id),
  createdByName: text("created_by_name"),
  // Regulatory approval (first signer). Required body fields: initials,
  // signatureMeaning. Actor.role must be in APPROVER_ROLES.
  regulatoryApproverId: integer("regulatory_approver_id").references(() => usersTable.id),
  regulatoryApproverName: text("regulatory_approver_name"),
  regulatoryApproverInitials: text("regulatory_approver_initials"),
  regulatoryApprovedAt: timestamp("regulatory_approved_at", { withTimezone: true }),
  regulatoryApproverMeaning: text("regulatory_approver_meaning"),
  // Marketing approval (second signer, distinct from regulatory).
  marketingApproverId: integer("marketing_approver_id").references(() => usersTable.id),
  marketingApproverName: text("marketing_approver_name"),
  marketingApproverInitials: text("marketing_approver_initials"),
  marketingApprovedAt: timestamp("marketing_approved_at", { withTimezone: true }),
  marketingApproverMeaning: text("marketing_approver_meaning"),
  // Retirement (terminal state; preserves row + audit trail rather than
  // hard-deleting, so prior labels referencing this template stay auditable).
  retiredById: integer("retired_by_id").references(() => usersTable.id),
  retiredByName: text("retired_by_name"),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retireReason: text("retire_reason"),
  // Legacy "fully approved" summary columns. Stamped on the Marketing-sign
  // transition (status → "approved") and cleared on edit/retire. Kept so the
  // renderer's `template.approvalDate`-based draft watermark logic continues
  // to work without changes.
  approvedById: integer("approved_by_id").references(() => usersTable.id),
  approvedByName: text("approved_by_name"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  // 2026-07-22 — bring-your-own-label model: the template is an APPROVED PROOF
  // + format lock + variable-field list, NOT an in-app design. `formatSpec`
  // records the locked format (e.g. { fontFamily, fontSizes, layoutNotes };
  // the physical size stays in widthIn/heightIn). `fieldList` is the set of
  // standard variable-field keys (a subset of the label-data export columns)
  // this template carries, so a batch's data file maps cleanly onto it. The
  // single Quality "meets state requirements" sign-off reuses the
  // regulatoryApprover* columns above.
  // 2026-08-31 — WHICH PRODUCTS this template is for. A recipe IS a finished
  // product ("a recipe = a finished product", recipes.ts), so a product here is
  // a recipe LINEAGE.
  //
  // ⛔ LINEAGE ids, never recipe row ids. "New Version" clones a recipe into a
  // NEW ROW and freezes the old one, so a link to a row would be orphaned by the
  // next version of the very product it names. Every version of a product shares
  // its lineageId, which is what this holds.
  //
  // Empty or null means "any product of this type" — a generic template, which
  // is what every template written before this column was one of.
  // ⛔ A lineage of a DIFFERENT product type may not be linked (his ruling
  // 2026-08-31): it would make the grouping lie.
  productLineageIds: jsonb("product_lineage_ids").$type<number[]>(),
  // 2026-08-31 — label-control step 4. WHAT THE STICKER CARRIES: the plain list
  // of requirement keys this template's approved proof prints for itself.
  //
  // Simpler than a packaging design's `requirementTargets`. A design has to say
  // WHERE a requirement is met, because it is the artefact that can push one
  // onto the label; a template is the end of that chain, so a requirement is
  // either on the sticker or it is not, and there is no target to choose.
  //
  // ⛔ Only a requirement whose control is "Packaging" may ever be claimed here
  // — the same rule the design lives under. A template having a THC *field*
  // does not verify this batch's *number*, so nothing that changes with the
  // batch can be subtracted, and the per-print check can never end up empty.
  //
  // ⛔ The list FREEZES at approval: the write route refuses once the template
  // leaves draft, because the Quality signature is what makes the claim count.
  // Editing the layout knocks the template back to draft and the list is
  // claimable again — deliberately, since a re-drawn sticker may carry less.
  coverageKeys: jsonb("coverage_keys").$type<string[]>(),
  // 2026-09-02 — THE ONE WAY PAST THE "CARRIES CANNOT BE EMPTY" GATE.
  //
  // His question 2026-09-01: "Why would we ever allow that?" — why would anyone
  // sign a label as meeting state requirements while claiming it prints none of
  // them. There is exactly one honest answer: a brand-only sticker (a logo, a
  // strain name on the side of a jar) that sits BESIDE the compliance label and
  // carries nothing on its own.
  //
  // So an empty list is still allowed, but it has to be SAID rather than left
  // empty by accident. The approval refuses an empty coverage list unless this
  // is ticked, and ticking it forces the list empty — a sticker cannot both
  // carry nothing and carry something.
  brandOnly: boolean("brand_only").notNull().default(false),
  // 2026-09-02 — PACKAGE FIRST, THEN LABEL. His ruling: "We go package approval,
  // then label approval. No label then package." The reasoning is his too — the
  // label is the flexible surface. A pouch is committed a million at a time, so
  // whatever might change (his example: the testing lab, if you ever switch labs)
  // belongs on the label, and that choice can only be made once the pouch is
  // settled.
  //
  // ⛔ HALF-REFUSED, not refused — his words, 2026-09-02. Signing a label for a
  // product with no approved packaging design is refused UNLESS a written reason
  // is given, which is then part of the record. Same shape as the CAPA
  // segregation-of-duties override: a control that makes the work impossible
  // gets worked around outside the system, so the way through is recorded rather
  // than removed.
  //
  // ⛔ SET BY THE SERVER ONLY, never through the PATCH allowlist, and cleared
  // when a signature no longer needs one.
  packagingOrderOverrideReason: text("packaging_order_override_reason"),
  packagingOrderOverrideById: integer("packaging_order_override_by_id").references(() => usersTable.id),
  packagingOrderOverrideByName: text("packaging_order_override_by_name"),
  packagingOrderOverrideAt: timestamp("packaging_order_override_at", { withTimezone: true }),
  formatSpec: jsonb("format_spec"),
  fieldList: jsonb("field_list"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLabelStaticBlockSchema = createInsertSchema(labelStaticBlocksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLabelStaticBlock = z.infer<typeof insertLabelStaticBlockSchema>;
export type LabelStaticBlock = typeof labelStaticBlocksTable.$inferSelect;

export const insertLabelTemplateSchema = createInsertSchema(labelTemplatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLabelTemplate = z.infer<typeof insertLabelTemplateSchema>;
export type LabelTemplate = typeof labelTemplatesTable.$inferSelect;
