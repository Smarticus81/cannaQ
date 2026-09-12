import { pgTable, serial, integer, text, date, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";

// 2026-08-10 — a Correction is a tracked open-action, not just a note. It
// carries the date the supplier COMMITTED to (what they told us) and the date
// it was actually COMPLETED. An empty completedDate means the correction is
// still OPEN, which blocks recording Pass and setting a Closure date. Dates are
// stored as "YYYY-MM-DD" strings (JSONB), matching the date-only convention.
export type SupplierCorrection = {
  text: string;
  committedDate?: string | null;
  completedDate?: string | null;
};

// Coerce legacy (plain-string) and current (object) correction shapes into one
// normalized SupplierCorrection[]. Legacy string entries become open actions
// with no dates. Empty-text entries are dropped. Use this everywhere corrections
// are read or gated so the two historical shapes never diverge in behavior.
export function normalizeCorrections(raw: unknown): SupplierCorrection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c): SupplierCorrection => {
      if (typeof c === "string") return { text: c, committedDate: null, completedDate: null };
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        return {
          text: typeof o.text === "string" ? o.text : "",
          committedDate: typeof o.committedDate === "string" && o.committedDate ? o.committedDate : null,
          completedDate: typeof o.completedDate === "string" && o.completedDate ? o.completedDate : null,
        };
      }
      return { text: "", committedDate: null, completedDate: null };
    })
    .filter((c) => c.text.trim() !== "");
}

// A correction is open until it has a completion date.
export const isCorrectionOpen = (c: SupplierCorrection): boolean => !c.completedDate;

export const supplierQualificationsTable = pgTable("supplier_qualifications", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull().references(() => suppliersTable.id, { onDelete: "cascade" }),
  qualNumber: text("qual_number").notNull().unique(),
  qualificationType: text("qualification_type").notNull(),
  // SQ-Certificates (2026-08) — distinguishes a lightweight "Certificate on
  // file" record (issuer + cert/license # + expiry + attached file) from a full
  // "Audit" assessment (risk, score, findings, corrective actions, Pass/Fail).
  // Nullable so legacy rows stay unclassified; the UI infers their kind from
  // audit signals. New records set it explicitly ("Certificate" | "Audit").
  recordType: text("record_type"),
  riskLevel: text("risk_level").notNull().default("Medium"),
  status: text("status").notNull().default("Scheduled"),
  assessorName: text("assessor_name"),
  assessmentDate: date("assessment_date"),
  expiryDate: date("expiry_date"),
  // Session 97 (certificates / #11) — optional certificate metadata so a
  // qualification record reads cleanly as a certificate (license, CoA, ISO…).
  // Both nullable; the actual certificate file attaches via the polymorphic
  // attachments panel (parentTable "supplier_qualifications").
  issuer: text("issuer"),
  certificateNumber: text("certificate_number"),
  score: integer("score"),
  findings: text("findings"),
  correctiveActionsRequired: text("corrective_actions_required"),
  // 2026-08-10 — audit flow restructure. `findings` now holds Audit Observations
  // (conforming/non-conforming). Corrective actions (CAPAs) are the SUPPLIER's,
  // not tracked here; `corrections` are minor fixes listed individually, with a
  // rationale when none are required. Closure captures a completion-verification
  // note (may include the score rationale) and the audit closure date.
  auditReason: text("audit_reason"),
  corrections: jsonb("corrections").$type<SupplierCorrection[]>(),
  correctionsRationale: text("corrections_rationale"),
  closureVerification: text("closure_verification"),
  closureDate: date("closure_date"),
  // 2026-08-10 — lightweight two-party sign-off so Quality AND Manager are aware
  // of the audit outcome. Role-gated at the /sign endpoint; not a heavy gate.
  qualitySignedName: text("quality_signed_name"),
  qualitySignedInitials: text("quality_signed_initials"),
  qualitySignedAt: timestamp("quality_signed_at", { withTimezone: true }),
  managerSignedName: text("manager_signed_name"),
  managerSignedInitials: text("manager_signed_initials"),
  managerSignedAt: timestamp("manager_signed_at", { withTimezone: true }),
  approvedByName: text("approved_by_name"),
  approvalDate: date("approval_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSupplierQualSchema = createInsertSchema(supplierQualificationsTable).omit({
  id: true,
  qualNumber: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplierQual = z.infer<typeof insertSupplierQualSchema>;
export type SupplierQualification = typeof supplierQualificationsTable.$inferSelect;
