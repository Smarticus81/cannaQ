import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/**
 * Polymorphic attachment store. One row per uploaded file, immutable once
 * inserted. To "remove" an attachment users mark it Voided (with reason +
 * Part 11 e-signature) or Superseded (when replaced); the underlying object in
 * GCS is never deleted, so the historical record is always retrievable.
 *
 * `parentTable` + `parentId` form the polymorphic FK. Allowed parent tables
 * (string-checked at the route layer): documents, training_records, lots,
 * batch_records, batch_testing, non_conformances, capas, complaints,
 * incoming_inspections, suppliers, supplier_qualifications, field_actions.
 */
export const attachmentsTable = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),

    parentTable: text("parent_table").notNull(),
    parentId: integer("parent_id").notNull(),

    // "primary" | "supplementary". Documents enforce ≤1 active "primary".
    kind: text("kind").notNull().default("supplementary"),

    objectPath: text("object_path").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    description: text("description"),

    // "Active" | "Superseded" | "Voided"
    status: text("status").notNull().default("Active"),

    uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id),
    uploadedByName: text("uploaded_by_name").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),

    // Set when this attachment is replaced by a newer one (Documents:
    // primary file gets replaced -> this row's status becomes Superseded
    // and supersededByAttachmentId points at the replacement).
    supersededByAttachmentId: integer("superseded_by_attachment_id"),

    // For Documents primary files: snapshot of the doc revision the file
    // belongs to. Set when the doc is approved; locks the file to that rev.
    documentRevisionSnapshot: text("document_revision_snapshot"),

    // Voiding (Part 11): file stays in GCS, row remains, but is excluded
    // from "active" reads.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: integer("voided_by_user_id").references(() => usersTable.id),
    voidedByName: text("voided_by_name"),
    voidedReason: text("voided_reason"),
    voidedInitials: text("voided_initials"),
    voidedMeaning: text("voided_meaning"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    parentIdx: index("attachments_parent_idx").on(t.parentTable, t.parentId),
    statusIdx: index("attachments_status_idx").on(t.status),
    uploaderIdx: index("attachments_uploader_idx").on(t.uploadedByUserId),
    // Enforces "at most one Active primary attachment per (parent_table,
    // parent_id)" at the DB layer so concurrent uploads cannot create two
    // active primaries even if the application-side supersede logic races.
    oneActivePrimaryPerParent: uniqueIndex("attachments_one_active_primary_per_parent")
      .on(t.parentTable, t.parentId)
      .where(sql`${t.kind} = 'primary' AND ${t.status} = 'Active'`),
  }),
);


// Raw bytes for DB-backed attachment storage (Railway Postgres). We store files
// in the database itself instead of a third-party object store. Keyed by the same
// object_path recorded on attachmentsTable; kept in its own table so the metadata
// table stays light. Bytes are retained even when a metadata row is Voided.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const attachmentBlobsTable = pgTable("attachment_blobs", {
  objectPath: text("object_path").primaryKey(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
