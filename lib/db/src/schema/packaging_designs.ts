import { pgTable, serial, text, integer, real, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const packagingDesignsTable = pgTable("packaging_designs", {
  id: serial("id").primaryKey(),
  designName: text("design_name").notNull(),
  productType: text("product_type").notNull(),
  version: text("version").notNull().default("1.0"),
  status: text("status").notNull().default("Draft"),
  artworkUrl: text("artwork_url"),
  checklistCompletePct: real("checklist_complete_pct"),
  // 2026-08-09 — persist the actual checked item ids (was localStorage-only;
  // only the pct synced, so checkmarks didn't follow the design across browsers).
  checklistItems: jsonb("checklist_items").$type<string[]>(),
  // 2026-08-09 — when true AND a proof file is attached, the uploaded proof
  // counts as the artwork of record, so an Artwork URL is no longer required.
  proofIsArtwork: boolean("proof_is_artwork").notNull().default(false),
  // 2026-08-31 — label-control step 1. A packaging design is CORPORATE: it is
  // approved for one or more states, and it declares which of those states'
  // labelling requirements the packaging itself carries.
  //
  // `approvedStates` holds normalized upper-case state names (see
  // regulatoryRules.normalizeState) so the two stored shapes ("MI" on a facility,
  // "Michigan" in regulatory_config) cannot drift apart here.
  //
  // `requirementTargets` maps a requirement KEY to where this operator meets it:
  // "Packaging" (this design carries it) or "Labeling" (not the packaging, so it
  // is checked before every print unless the LABEL claims it). Absence means
  // "Labeling" — the safe default, so a design that declares nothing subtracts
  // nothing. What the sticker carries is the label template's own statement and
  // is not recorded here; see the note on COVERAGE_TARGETS below.
  // ⛔ Only a requirement whose control is "Packaging" may ever be set to
  // "Packaging"; a per-batch value is not verifiable once, here.
  approvedStates: jsonb("approved_states").$type<string[]>(),
  // 2026-09-02 — WHICH PRODUCTS this pouch is for. His ruling 09-01, and the
  // domain fact that settled it: in Michigan an edible pouch is specific to the
  // edible AND its flavour, because the pouch prints the ingredients, while
  // cartridges share one pouch across every strain and every H/I/S. Per-type
  // alone is therefore factually wrong the moment artwork prints anything
  // recipe-derived.
  //
  // Deliberately the SAME field as label_templates.productLineageIds, with the
  // same two meanings, so the two artefacts can finally be compared at one grain:
  //   empty or null — every product of this type (the cartridge pouch);
  //   populated     — only those products (the cookie pouch).
  //
  // ⛔ LINEAGE ids, never recipe row ids. "New Version" clones a recipe into a
  // NEW ROW and freezes the old one, so a link to a row would be orphaned by the
  // next version of the very product it names.
  //
  // ⛔ Unlike a label, a product may hold MANY approved packaging designs — a
  // pouch, a carton and a tube all carry things. Coverage across them INTERSECTS
  // (see lib/packagingCoverage.ts), which is why no one-approved gate belongs
  // here.
  productLineageIds: jsonb("product_lineage_ids").$type<number[]>(),
  requirementTargets: jsonb("requirement_targets").$type<Record<string, string>>(),
  // Optional free text against a requirement, keyed the same way. Today it is
  // the "why not" behind a NotApplicable answer — never required, because the
  // answer itself is already attributed in the audit log.
  requirementNotes: jsonb("requirement_notes").$type<Record<string, string>>(),
  // Legacy single-approval columns (retained for historical rows).
  approvedBy: integer("approved_by").references(() => usersTable.id),
  approvalName: text("approval_name"),
  approvalInitials: text("approval_initials"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  // 2026-07-22 — retail packaging is approved ONCE before the initial order and
  // requires TWO Part 11 e-signatures: Quality (compliance / meets state
  // requirements) + Manager (business sign-off). If a Regulatory role is added
  // later it takes the Quality slot. The design becomes "Approved" only when
  // BOTH are signed. Each slot records signer id + name + initials + signing
  // meaning + timestamp (21 CFR Part 11 attribution).
  qualityApproverId: integer("quality_approver_id").references(() => usersTable.id),
  qualityApproverName: text("quality_approver_name"),
  qualityApproverInitials: text("quality_approver_initials"),
  qualityApproverMeaning: text("quality_approver_meaning"),
  qualityApprovedAt: timestamp("quality_approved_at", { withTimezone: true }),
  managerApproverId: integer("manager_approver_id").references(() => usersTable.id),
  managerApproverName: text("manager_approver_name"),
  managerApproverInitials: text("manager_approver_initials"),
  managerApproverMeaning: text("manager_approver_meaning"),
  managerApprovedAt: timestamp("manager_approved_at", { withTimezone: true }),
  notes: text("notes"),
  // 2026-09-01 — WHY a design was rejected. Rejecting used to write only the
  // status, so the record said a design was turned back but never what was wrong
  // with it; the reviewer's reasoning lived in somebody's memory. Required at the
  // moment of rejection and shown on the design, and CLEARED when the design
  // leaves Rejected, so a stale reason cannot sit under a design that has since
  // been fixed and re-submitted.
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/**
 * Where an operator meets a labelling requirement.
 *
 * "Packaging"   — this design's artwork carries it. Verified ONCE, when the
 *                 design is approved, and subtracted from every later print.
 * ⛔ "LabelStudio" WAS a third answer here and was REMOVED 2026-09-01, his
 *    ruling. It let a packaging design declare that the LABEL carries something —
 *    the same fact the label template's own coverage list states, in a second
 *    place, with nothing reconciling the two. You could answer them opposite ways
 *    and the app accepted both, and only the label's answer ever did anything.
 *    His words on hitting it: "am I now adding label requirements for a third
 *    time?" A packaging design now speaks only about the packaging.
 *    Stored "LabelStudio" values are dropped on read and on write; they never
 *    subtracted anything, so nothing changes meaning.
 * "Labeling"    — checked before every print. The default, and the safe one.
 * "NotApplicable" — 2026-08-31. This requirement does not apply to this product
 *                 at all: no health or nutritional claim is made, or this is the
 *                 age statement the product does not use. Without it an optional
 *                 requirement could only be falsely ticked or left blocking
 *                 approval for ever. It is NOT a claim that the pouch carries
 *                 anything, so it is reported separately from what is carried.
 *                 ⛔ Allowed only where the control is "Packaging" — the same
 *                 rule as "Packaging" itself, so nothing that changes with the
 *                 batch can be answered away here.
 *
 * ⛔ Replaces REQUIREMENT_TARGETS in facility_requirement_assignments.ts, which
 * goes away with that table at step 5. Same three values, so a stored row keeps
 * its meaning.
 */
export const COVERAGE_TARGETS = ["Packaging", "Labeling", "NotApplicable"] as const;
export type CoverageTarget = (typeof COVERAGE_TARGETS)[number];

export const insertPackagingDesignSchema = createInsertSchema(packagingDesignsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPackagingDesign = z.infer<typeof insertPackagingDesignSchema>;
export type PackagingDesign = typeof packagingDesignsTable.$inferSelect;
