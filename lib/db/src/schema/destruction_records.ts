import { pgTable, serial, text, real, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Session 49 — METRC destruction record tracking.
//
// Michigan CRA requires a METRC destruction tag whenever product is destroyed.
// Critically, in Michigan one METRC destruction number can cover MANY batches
// destroyed in a single event. That is why this is a SEPARATE table with a
// many-to-one relationship FROM non_conformances (non_conformances.destruction_record_id
// -> destruction_records.id), NOT a single destruction_metrc_tag column on the
// NC. Jonathan explicitly chose the table model (see Session 49 starter):
//   "In Michigan, many batches can be destroyed with one METRC number."
//
// metrcTag is intentionally NOT unique — operators may reuse / amend a tag.
export const destructionRecordsTable = pgTable("destruction_records", {
  id: serial("id").primaryKey(),
  // Multi-facility Phase 1 (2026-08-28) — the licensed SITE this record belongs to.
  // Nullable for now: existing rows are backfilled to the one facility, and Phase 2
  // is what makes every write set it and every read filter on it.
  facilityId: integer("facility_id"),
  metrcTag: text("metrc_tag").notNull(),
  // When the destruction event physically happened. Distinct from createdAt.
  destroyedAt: timestamp("destroyed_at", { withTimezone: true }).notNull(),
  destroyedByName: text("destroyed_by_name").notNull(),
  // Michigan CRA generally requires a witness for destruction; not strictly
  // required by every facility's SOP, so nullable here.
  witnessName: text("witness_name"),
  weight: real("weight"),
  weightUom: text("weight_uom"), // "g" | "oz" | "lb" | "units" — free text for now
  // e.g. "Denaturing - kitty litter + soap", "Incineration via licensed waste co", etc.
  method: text("method"),
  notes: text("notes"),
  // Compliance fields (R 420.211, 2026-07-28).
  // Structured reason for the destruction (waste reconciliation + reporting).
  reason: text("reason"), // Failed Test | Expired | Damaged | Recall | Return | Other
  // "Rendered unusable" evidence: what the product was ground/mixed with, and a
  // confirmation the resulting waste mixture is at least 50% non-marijuana.
  nonCannabisMaterial: text("non_cannabis_material"),
  mixtureConfirmed: boolean("mixture_confirmed").notNull().default(false),
  // 21 CFR Part 11 e-signature of the person recording the destruction, captured
  // at creation (initials matched to the signed-in user, plus a signing meaning).
  signedByName: text("signed_by_name"),
  signedByInitials: text("signed_by_initials"),
  signedMeaning: text("signed_meaning"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  // Gaps 4-6 (R 420.211 waste management, 2026-07-28).
  // Gap 4 — how the destroyed material physically left the facility, and the
  // hauler manifest when a licensed waste company hauled it off-site.
  disposalRoute: text("disposal_route"),
  haulerName: text("hauler_name"),
  manifestNumber: text("manifest_number"),
  // Gap 5 — provenance link back to the source. sourceBatchId is a soft FK to
  // batch_records.id (no hard constraint — a destruction event may predate or
  // outlive the batch row); sourceLotNumber is the METRC source package/lot tag
  // as free text so external lots not tied to an app batch still record.
  sourceBatchId: integer("source_batch_id"),
  sourceLotNumber: text("source_lot_number"),
  // Gap 6 — Michigan CRA requires destruction to occur on the facility's video
  // surveillance system. Attestation flag + optional camera/location reference.
  surveillanceConfirmed: boolean("surveillance_confirmed").notNull().default(false),
  surveillanceCameraRef: text("surveillance_camera_ref"),
  // Session 52 (2026-08-07) — Open→Closed lifecycle. A record is Open while
  // packages accumulate; Close & Sign captures the Part 11 signature and locks
  // it. Existing (already-signed) rows backfill to Closed (see ensureSchema).
  status: text("status").notNull().default("Open"), // "Open" | "Closed"
  // Michigan METRC package-adjustment reason this destruction maps to. Our own
  // granular `reason` stays for the quality record.
  metrcAdjustmentReason: text("metrc_adjustment_reason"), // "Waste" | "Spoilage"
  // Session 50 — soft archive. Archived records drop out of the default list
  // and the NC link-selector dropdown but stay queryable for the archived
  // view. Nullable; null = active.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // Session 51 — soft Cancel (Part 11). QMS records are never hard-deleted;
  // Cancel retains the row, is recoverable (Uncancel), and requires a Part 11
  // e-signature (initials + meaning) from a Manager/Quality/Admin plus a
  // rationale. Cancelled records leave the Active list. All nullable; null
  // cancelledAt = not cancelled.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDestructionRecordSchema = createInsertSchema(destructionRecordsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDestructionRecord = z.infer<typeof insertDestructionRecordSchema>;
export type DestructionRecord = typeof destructionRecordsTable.$inferSelect;
