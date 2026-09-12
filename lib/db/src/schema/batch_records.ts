import { pgTable, serial, text, integer, real, date, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const batchRecordsTable = pgTable("batch_records", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  batchNumber: text("batch_number").notNull().unique(),
  batchType: text("batch_type").notNull(),
  // Session 36 (Tier 3 #14 + Tier 7 C1 scoped) — process_type discriminator.
  // Drives which fields the Batch UI surfaces and which regulatory rules
  // apply. Four values today: Cultivation | Kitchen | Inhalants | Pre-roll.
  // Existing rows pre-date the discriminator and migrate to "Kitchen" — the
  // operator can re-classify any row if the legacy guess is wrong. The full
  // cultivation field set (nutrients, env, lifecycle, genealogy) is deferred
  // to Tier 7 C2/C3; this session ships only the discriminator.
  processType: text("process_type").notNull().default("Kitchen"),
  productType: text("product_type").notNull(),
  // Follow-up (06-24) — distribution channel for the finished batch, which
  // drives the labeling control set. "Retail" = retail-ready consumer product
  // (full consumer label: per-serving potency, warnings, allergens, universal
  // symbol). "Bulk" = bulk/wholesale transfer to another licensee (transfer /
  // manifest label: source lot, total weight, license #, METRC manifest — no
  // consumer serving/warning content). Default "Retail" so existing batches keep
  // their product-type consumer checklist.
  saleType: text("sale_type").notNull().default("Retail"),
  strainName: text("strain_name"),
  // Sativa / Indica / Hybrid classification (optional). Distinct from strainName
  // (the cultivar, e.g. "Blue Dream"). Feeds the Finished Goods strain charts.
  strainType: text("strain_type"),
  productName: text("product_name").notNull(),
  status: text("status").notNull().default("in_production"),
  // Session 38 (Tier 4 #19) — scheduled vs actual production variance.
  // scheduled is the operator's planned output at batch open; outputQuantity
  // is the actual delivered output (existing). Variance % is computed at
  // display time as ((actual - scheduled) / scheduled) * 100 when both are
  // populated. Nullable so legacy rows and partial-data batches don't break.
  scheduledOutputQuantity: real("scheduled_output_quantity"),
  outputQuantity: real("output_quantity"),
  // 2026-08-10 — finished output is recorded by the department lead on the
  // Packaging tab: outputQuantity = units (the Metrc finished-package count,
  // REQUIRED before release), plus how those units are aggregated in Finished
  // Goods. Both nullable; cases/cartons are informational, units gates release.
  casesProduced: integer("cases_produced"),
  cartonsProduced: integer("cartons_produced"),
  unitOfMeasure: text("unit_of_measure"),
  metrcPackageId: text("metrc_package_id"),
  productionDate: date("production_date"),
  // Locked at release from the passing test date + product-type shelf life
  // (edibles: R 420.403, must not be altered once set). Drives FIFO + near-expiry.
  expirationDate: date("expiration_date"),
  remediationStatus: text("remediation_status"),
  approvedBy: integer("approved_by").references(() => usersTable.id),
  approvalName: text("approval_name"),
  approvalInitials: text("approval_initials"),
  approvalDate: timestamp("approval_date", { withTimezone: true }),
  // Session 66 (OQ-11) — Part 11 meaning of the release e-signature, persisted on
  // the record (previously only in the audit log) so it can be displayed.
  approvalMeaning: text("approval_meaning"),
  notes: text("notes"),
  // Session 62 — the recipe/process this batch runs (set at creation from the
  // recipe used). Drives operator competency: solo step-signing requires the
  // operator be Qualified for this recipe. Null on legacy/ad-hoc batches (no gate).
  recipeId: integer("recipe_id"),
  // Session 104 - per-run label net weight (the product SIZE for this batch,
  // e.g. a 1.0 g vs 0.5 g pre-roll). Overrides the recipe default on the label.
  labelNetWeight: real("label_net_weight"),
  labelNetWeightUnit: text("label_net_weight_unit"),
  // Spec-doc link: drives Print Batch Record. Only Approved Specification
  // documents are linkable; revision is snapshotted at link time so reprints
  // remain reproducible (Part 11) even if the spec is later revised.
  specDocId: integer("spec_doc_id"),
  specRevisionAtLink: text("spec_revision_at_link"),
  specLinkedAt: timestamp("spec_linked_at", { withTimezone: true }),
  // Immutable snapshot of the spec doc + its sections at link time. Print
  // Batch Record always renders from these — never from the live tables —
  // so reprints stay reproducible (Part 11) even if the spec is later
  // revised or its sections edited in a new Draft.
  specDocSnapshot: jsonb("spec_doc_snapshot").$type<{
    id: number; docNumber: string; title: string; revision: string;
    approvedByName: string | null; approvalDate: string | null;
  } | null>(),
  specSectionsSnapshot: jsonb("spec_sections_snapshot").$type<Array<{
    id: number; sortOrder: number; kind: string; title: string; bodyMarkdown: string | null;
  }> | null>(),
  // Session 61 — when the linked doc is a Work Instruction backed by a recipe,
  // its recipe process steps are snapshotted at link time too, so an executed
  // batch proves the exact approved procedure (revision) it ran against (Part 11).
  specProcessStepsSnapshot: jsonb("spec_process_steps_snapshot").$type<Array<{
    id: number; stepNumber: number; sortOrder: number; description: string; template: string | null;
  }> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchRecordSchema = createInsertSchema(batchRecordsTable).omit({ id: true, batchNumber: true, createdAt: true, updatedAt: true });
export type InsertBatchRecord = z.infer<typeof insertBatchRecordSchema>;
export type BatchRecord = typeof batchRecordsTable.$inferSelect;
