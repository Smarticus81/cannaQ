import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchRecordsTable } from "./batch_records";
import { usersTable } from "./users";

// Session 73 — METRC Tag History (tag lineage). A batch is identified by its
// process-start METRC tag (= its Batch Number, frozen — Session 72). As product
// changes form (bulk → repackaged) and is split into final units, it accrues a
// CHAIN of downstream METRC tags. This table records that chain as a tree:
//
//   • Root        = the process-start tag = the Batch Number (sourceTag = null).
//   • Every node  references its Source tag (the parent). "Source = Parent" is
//                   Michigan/METRC's own term: any package that creates a new
//                   package is the *source* of it. The UI labels nodes
//                   Source / Child.
//   • A node is   either a SINGLE new tag (a bulk form change) OR a RANGE of
//                   sequential child tags stored compactly as first + last
//                   (every unit in between is covered). METRC tags run out
//                   mid-batch, so one split event may record MULTIPLE
//                   non-contiguous ranges — each stored as its own sibling row
//                   under the same Source + stage, so complaint lookup naturally
//                   checks them all.
//   • The latest  leaf tag is what prints on labels; the Batch Number never
//                   changes.
//
// Append-only — corrections go through the universal Cancel pattern (reason +
// Manager/Quality/Admin approval, recoverable, audited); NEVER hard-delete
// (21 CFR Part 11). Schema is additive → self-applies on boot via ensureSchema.
//
// Tag formats vary by state (multi-state by design) so NO format is enforced —
// tags are stored as entered, trimmed only (consistent with batch_records).
export const batchMetrcTagsTable = pgTable("batch_metrc_tags", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => batchRecordsTable.id, { onDelete: "cascade" }),
  // The parent/Source METRC tag this node derived from. The first downstream
  // node's source = the Batch Number (the process-start tag). Null only if a
  // caller records a root-level node directly (normally the Batch Number is the
  // implicit root and the first recorded node points at it).
  sourceTag: text("source_tag"),
  // e.g. "Process start", "Bulk — baked", "Final packaging".
  stageLabel: text("stage_label").notNull(),
  // 'single' (one new tag) or 'range' (a first–last span of sequential tags).
  kind: text("kind").notNull().default("single"),
  // Set when kind = 'single'.
  metrcTag: text("metrc_tag"),
  // Set when kind = 'range'. range_count is an optional convenience total.
  rangeStart: text("range_start"),
  rangeEnd: text("range_end"),
  rangeCount: integer("range_count"),
  // Weight/qty at this stage (per-stage total for v1) + its unit.
  quantity: numeric("quantity"),
  uom: text("uom"),
  // JIT commit 2 (label-later) — a packaged run starts UNLABELED when packaged
  // "label later" (finalize=false); the order-time Label & Finalize step flips it
  // to 'labeled', stamps who/when + the retail destination (dispensary), and moves
  // the batch to Finished Goods. Default 'labeled' so every pre-existing run stays
  // back-compatible (those were labeled at final packaging). No new METRC tag is
  // created at labeling — the units already carry their packaging-run tags.
  labelStatus: text("label_status").notNull().default("labeled"),
  dispensaryName: text("dispensary_name"),
  labeledByUserId: integer("labeled_by_user_id").references(() => usersTable.id),
  labeledByName: text("labeled_by_name"),
  labeledAt: timestamp("labeled_at", { withTimezone: true }),
  // Part 11 attribution — WHO recorded this node.
  recordedByUserId: integer("recorded_by_user_id").references(() => usersTable.id),
  recordedByName: text("recorded_by_name"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  // METRC write-back sync (create-package). CannaQMS is the operator's single
  // surface; the actual package is created in the state system (METRC) underneath.
  // metrcPackageCreatedAt is stamped when this node's package is successfully
  // created in METRC (drives the "In METRC ✓" badge and makes create idempotent —
  // a synced node is never re-created). metrcSyncError holds the last plain-language
  // failure (e.g. "source package not in facility") so a failed push is surfaced,
  // never silently diverged. Both null on a mirror-only / not-yet-synced node.
  metrcPackageCreatedAt: timestamp("metrc_package_created_at", { withTimezone: true }),
  metrcSyncError: text("metrc_sync_error"),
  // Universal Cancel pattern — recoverable, audited, never hard-deleted.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledReason: text("cancelled_reason"),
  cancelledByUserId: integer("cancelled_by_user_id").references(() => usersTable.id),
  cancelledByName: text("cancelled_by_name"),
  cancelledByInitials: text("cancelled_by_initials"),
  cancelledMeaning: text("cancelled_meaning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBatchMetrcTagSchema = createInsertSchema(batchMetrcTagsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type BatchMetrcTag = typeof batchMetrcTagsTable.$inferSelect;
export type InsertBatchMetrcTag = z.infer<typeof insertBatchMetrcTagSchema>;
