-- Session 43 — Drizzle ↔ DB schema resync.
--
-- Generated from lib/db/src/schema/*.ts. Idempotent: every ADD COLUMN
-- uses IF NOT EXISTS so columns already present in the dump are no-ops.
-- Brings the restored Railway dump up to whatever Drizzle currently
-- expects, closing the gap left by Session 11-era drizzle-kit push
-- changes that never landed as canonical migration .sql files.
--
-- Safety choices:
--   * Skips serial/PK columns — table existence is assumed.
--   * Skips foreign keys, unique constraints, and indexes — fixes
--     are scoped to column presence only.
--   * Adds NOT NULL only when a DEFAULT can be inferred.

BEGIN;

-- ===== attachments.ts :: attachments =====
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "parent_table" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "parent_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'supplementary' NOT NULL;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "object_path" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "content_type" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "size_bytes" bigint;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "sha256" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Active' NOT NULL;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "uploaded_by_user_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "uploaded_by_name" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "superseded_by_attachment_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "document_revision_snapshot" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_by_user_id" integer;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_by_name" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_reason" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_initials" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "voided_meaning" text;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== audit_log.ts :: audit_log =====
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "table_name" text;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "row_id" integer;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "operation" text;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "changed_by" integer;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "changed_by_name" text;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "changed_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "before_state" jsonb;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "after_state" jsonb;

-- ===== batch_ingredients.ts :: batch_ingredients =====
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "inventory_item_id" integer;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "ingredient_name" text;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "planned_quantity" real;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "actual_quantity" real;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'Ingredient' NOT NULL;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "supplier_lot_number" text;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "received_at" timestamp with time zone;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "inv_decremented_qty" real DEFAULT 0 NOT NULL;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "batch_ingredients" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_labeling.ts :: batch_labeling =====
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "label_version" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "metrc_tag_number" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "label_notes" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "approved_by" integer;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "approval_name" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "approval_initials" text;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "checklist_complete_pct" real;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "batch_labeling" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_labeling.ts :: checklist_items =====
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "labeling_id" integer;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "item_number" integer;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "item_text" text;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "regulation_ref" text;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "required" text DEFAULT 'true' NOT NULL;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_labeling.ts :: checklist_responses =====
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "checklist_item_id" integer;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "response" text;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "responded_by" integer;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "responded_by_name" text;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "checklist_responses" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_labeling.ts :: batch_label_prints =====
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "label_template_id" integer;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "label_template_name" text;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "label_template_version" integer;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "printed_by_id" integer;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "printed_by_name" text;
ALTER TABLE "batch_label_prints" ADD COLUMN IF NOT EXISTS "printed_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_records.ts :: batch_records =====
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "batch_number" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "batch_type" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "process_type" text DEFAULT 'Kitchen' NOT NULL;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "strain_name" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'in_production' NOT NULL;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "scheduled_output_quantity" real;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "output_quantity" real;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "metrc_package_id" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "production_date" date;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "remediation_status" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "approved_by" integer;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "approval_name" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "approval_initials" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "spec_doc_id" integer;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "spec_revision_at_link" text;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "spec_linked_at" timestamp with time zone;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "spec_doc_snapshot" jsonb;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "spec_sections_snapshot" jsonb;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "batch_records" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== batch_testing.ts :: batch_testing =====
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "sequence_number" integer DEFAULT 1 NOT NULL;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "phase" text DEFAULT 'result' NOT NULL;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "sample_weight" real;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "sample_uom" text;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "sample_pulled_at" date;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "sample_pulled_by_name" text;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "testing_agency_id" integer;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "testing_agency" text;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "submitted_date" date;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "result_date" date;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "test_result" text DEFAULT 'Pending' NOT NULL;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "result_values" jsonb;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "thc_pct" real;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "cbd_pct" real;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "total_cannabinoids" real;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "microbials_pass" boolean;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "pesticides_pass" boolean;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "heavy_metals_pass" boolean;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "residual_solvents_pass" boolean;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "vitamin_e_acetate" real;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "mct_oil_pass" boolean;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "coa_url" text;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "batch_testing" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== capas.ts :: capas =====
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "capa_number" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'Corrective' NOT NULL;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "source_nc_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "source_complaint_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "root_cause_analysis" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "rca_method" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "rca_methods" text[];
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_criteria" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_check_due" date;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_verified_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_verified_by_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_verified_by_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_verified_by_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_outcome" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_notes" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "stage" text DEFAULT 'Initiation' NOT NULL;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Open' NOT NULL;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "originator_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "originator_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_owner_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "effectiveness_owner_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approver_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approver_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approver_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approver_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approver_meaning" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate0_approved_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver1_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver1_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver1_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver1_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver1_meaning" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver2_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver2_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver2_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver2_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approver2_meaning" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate1_approved_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_approver_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_approver_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_approver_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_approver_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_approver_meaning" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "gate2_outcome" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_stage" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_by_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_by_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_comment" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "last_rejection_target" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "opened_by_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "opened_by_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "closed_by_id" integer;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "closed_by_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "closed_by_initials" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "closure_notes" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "investigation_due_date" date;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "action_planning_due_date" date;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "ec_planning_due_date" date;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "root_causes" text[];
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_level" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_rationale" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_released" boolean;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_customer_affected" boolean;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_labeling_impact" boolean;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_in_house_only" boolean;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_pre_bulk" boolean;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_revised_at" timestamp with time zone;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_revised_by_name" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_revised_reason" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "risk_revised_from" text;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "capas" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== capas.ts :: capa_action_items =====
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "capa_id" integer;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "sequence_number" integer DEFAULT 1 NOT NULL;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "action_description" text;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "assigned_to_id" integer;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "assigned_to_name" text;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Open' NOT NULL;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "completed_by_id" integer;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "completed_by_name" text;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "verified_by_id" integer;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "verified_by_name" text;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "capa_action_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== company_profile.ts :: company_profile =====
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "company_name" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "license_number" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "city" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "zip" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "contact_person" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== complaints.ts :: complaints =====
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "complaint_number" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "received_date" date;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "customer_name" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "complaint_type" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "severity" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Open' NOT NULL;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "investigation" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "resolution" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "field_action_id" integer;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "reporter_name" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "reporter_email" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "reporter_phone" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "severity_rationale" text;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "mdr_reportable" boolean DEFAULT false NOT NULL;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "mdard_reportable" boolean DEFAULT false NOT NULL;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "fda_reportable" boolean DEFAULT false NOT NULL;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== conversations.ts :: conversations =====
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== digest_settings.ts :: digest_settings =====
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "compliance_recipients" text DEFAULT '' NOT NULL;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "inventory_recipients" text DEFAULT '' NOT NULL;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "send_hour_utc" integer DEFAULT 12 NOT NULL;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "send_day_of_week" integer DEFAULT 1 NOT NULL;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "enabled" integer DEFAULT 1 NOT NULL;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "last_compliance_sent_at" timestamp with time zone;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "last_inventory_sent_at" timestamp with time zone;
ALTER TABLE "digest_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== document_sections.ts :: document_sections =====
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "document_id" integer;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "body_markdown" text;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== documents.ts :: documents =====
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "doc_number" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_type" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "revision" text DEFAULT '1.0' NOT NULL;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Draft' NOT NULL;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "owner_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "effective_date" date;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "review_date" date;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "approved_by_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "approval_date" date;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "summary_of_changes" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "change_severity" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "assigned_reviewer_id" integer;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "assigned_reviewer_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "assigned_approver_id" integer;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "assigned_approver_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reviewer_signed_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reviewer_signed_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reviewer_signed_initials" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reviewer_signed_meaning" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "approver_signed_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "approver_signed_initials" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "approver_signed_meaning" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "review_interval_years" integer DEFAULT 3 NOT NULL;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "next_review_date" date;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "obsoleted_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "obsoleted_by_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "obsoleted_meaning" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== documents.ts :: document_revisions =====
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "revision" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "summary_of_changes" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "change_severity" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "author_name" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "reviewer_name" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "reviewer_signed_at" timestamp with time zone;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "approved_by_name" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "approval_date" date;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "effective_date" date;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "obsoleted_at" timestamp with time zone;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "obsoleted_by_name" text;
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== fa_response_actions.ts :: fa_response_actions =====
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "field_action_id" integer;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "store_name" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "store_license_number" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "contact_name" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "contact_phone" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "contact_email" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "notification_date" date;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "method" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "confirmation_reference" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "units_affected" integer;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "units_returned" integer;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "product_returned" boolean DEFAULT false NOT NULL;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "product_destroyed" boolean DEFAULT false NOT NULL;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "fa_response_actions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== field_action_lots.ts :: field_action_lots =====
ALTER TABLE "field_action_lots" ADD COLUMN IF NOT EXISTS "field_action_id" integer;
ALTER TABLE "field_action_lots" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "field_action_lots" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone;
ALTER TABLE "field_action_lots" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "field_action_lots" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== field_actions.ts :: field_actions =====
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "fa_number" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "action_type" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Initiated' NOT NULL;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "initiation_reason" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "affected_batches" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "scope_description" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "response_actions" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "due_diligence_notes" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "closure_notes" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "closed_by" integer;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "closed_by_name" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "closed_by_initials" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "source_nc_id" integer;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "source_complaint_id" integer;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "linked_capa_id" integer;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "field_actions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== incoming_inspections.ts :: incoming_inspections =====
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "inspection_number" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "supplier_name" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "po_manifest_number" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "inspection_date" date;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "inspected_by" integer;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "inspected_by_name" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "result" text DEFAULT 'Pending' NOT NULL;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "inspection_notes" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "state_rationale" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "state_rationale_by_name" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "state_rationale_at" timestamp with time zone;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "pass_approver_name" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "pass_approver_initials" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "pass_approver_meaning" text;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "pass_approved_at" timestamp with time zone;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "incoming_inspections" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== incoming_inspections.ts :: incoming_inspection_items =====
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "inspection_id" integer;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "item_name" text;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "supplier_item_code" text;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "expiry_date" date;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "quantity_received" real;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "quantity_uom" text;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "result" text DEFAULT 'Pass' NOT NULL;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "incoming_inspection_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== inventory.ts :: inventory_items =====
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "item_name" text;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "item_type" text;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "quantity" real DEFAULT 0 NOT NULL;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "reorder_point" real;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "reorder_quantity" real;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "source_inspection_item_id" integer;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== label_templates.ts :: label_static_blocks =====
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "body" text;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "regulation_ref" text;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "approved_by_id" integer;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "approved_by_name" text;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "label_static_blocks" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== label_templates.ts :: label_templates =====
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "width_in" real DEFAULT 2.0 NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "height_in" real DEFAULT 4.0 NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regions" jsonb DEFAULT ARRAY[]::text[] NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'draft' NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "created_by_id" integer;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regulatory_approver_id" integer;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regulatory_approver_name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regulatory_approver_initials" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regulatory_approved_at" timestamp with time zone;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "regulatory_approver_meaning" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "marketing_approver_id" integer;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "marketing_approver_name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "marketing_approver_initials" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "marketing_approved_at" timestamp with time zone;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "marketing_approver_meaning" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "retired_by_id" integer;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "retired_by_name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "retire_reason" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "approved_by_id" integer;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "approved_by_name" text;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "label_templates" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== lots.ts :: lots =====
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "item_name" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "item_type" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "original_quantity" real;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "current_quantity" real;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "origin" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Active' NOT NULL;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "inventory_item_id" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "source_inspection_id" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "source_batch_id" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "parent_lot_id" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "metrc_package_id" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "expiration_date" date;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "created_by" integer;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== lots.ts :: lot_events =====
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "event_type" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "quantity_delta" real DEFAULT 0 NOT NULL;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "resulting_quantity" real;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "related_lot_id" integer;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "related_batch_id" integer;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "performed_by" integer;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "performed_by_name" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "signed_initials" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "signed_meaning" text;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "signed_at" timestamp with time zone;
ALTER TABLE "lot_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== lots.ts :: batch_outputs =====
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "quantity" real;
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "batch_outputs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== lots.ts :: shipments =====
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "customer_name" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "customer_license" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "shipped_quantity" real;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "unit_of_measure" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "manifest_number" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Shipped' NOT NULL;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "shipped_date" date;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "shipped_by" integer;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "shipped_by_name" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== messages.ts :: messages =====
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "conversation_id" integer;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "content" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== non_conformances.ts :: non_conformances =====
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "nc_number" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "severity" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Open' NOT NULL;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "batch_id" integer;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "disposition" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "use_as_is_approver_name" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "use_as_is_approver_initials" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "use_as_is_approver_meaning" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "use_as_is_approved_at" timestamp with time zone;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "root_cause" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "root_causes" text[];
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "lot_number" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "approved_by" integer;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "approval_name" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "approval_initials" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "mgmt_acknowledged_by" integer;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "mgmt_acknowledged_name" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "mgmt_acknowledged_initials" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "mgmt_acknowledged_at" timestamp with time zone;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "mgmt_acknowledged_notes" text;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "non_conformances" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== non_conformances.ts :: nc_corrections =====
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "nc_id" integer;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "task_owner_user_id" integer;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "task_owner_name" text;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "completed" boolean DEFAULT false NOT NULL;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "completed_by_user_id" integer;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "completed_by_name" text;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "performed_by_user_id" integer;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "performed_by_name" text;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "performed_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "nc_corrections" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== non_conformances.ts :: corrective_actions =====
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "nc_id" integer;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "action_description" text;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "assigned_to" integer;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "assigned_to_name" text;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Open' NOT NULL;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "verified_by" integer;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "corrective_actions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== packaging_designs.ts :: packaging_designs =====
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "design_name" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "version" text DEFAULT '1.0' NOT NULL;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Draft' NOT NULL;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "artwork_url" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "checklist_complete_pct" real;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "approved_by" integer;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "approval_name" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "approval_initials" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "approval_date" timestamp with time zone;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "packaging_designs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== recipes.ts :: recipes =====
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "product_name" text;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== recipes.ts :: recipe_items =====
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "recipe_id" integer;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "ingredient_name" text;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "planned_quantity" real;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "unit_of_measure" text DEFAULT 'g' NOT NULL;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'Ingredient' NOT NULL;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
ALTER TABLE "recipe_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== regulatory_config.ts :: regulatory_config =====
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "max_thc_per_serving" real DEFAULT 10 NOT NULL;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "max_thc_per_container" real DEFAULT 200 NOT NULL;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "potency_tolerance_pct" real DEFAULT 10 NOT NULL;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "retention_years" integer DEFAULT 4 NOT NULL;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "tracing_system" text;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "additional_config" jsonb;
ALTER TABLE "regulatory_config" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== supplier_qualifications.ts :: supplier_qualifications =====
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "qual_number" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "qualification_type" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "risk_level" text DEFAULT 'Medium' NOT NULL;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Scheduled' NOT NULL;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "assessor_name" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "assessment_date" date;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "expiry_date" date;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "score" integer;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "findings" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "corrective_actions_required" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "approved_by_name" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "approval_date" date;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "supplier_qualifications" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== suppliers.ts :: suppliers =====
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "supplier_name" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "contact_person" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "license_number" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "supplier_type" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Pending Review' NOT NULL;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "quality_rating" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "requalification_interval_years" integer DEFAULT 1 NOT NULL;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "risk_tier" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "risk_tier_rationale" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "risk_tier_set_at" timestamp with time zone;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "risk_tier_set_by_name" text;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== suppliers.ts :: supplier_attachments =====
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "supplier_id" integer;
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "file_type" text;
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "file_path" text;
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "supplier_attachments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== training_records.ts :: training_records =====
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "record_number" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "employee_name" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "employee_id" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "training_type" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "topic" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "document_reference" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "trainer_name" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "assigned_date" date;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "completed_date" date;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'Assigned' NOT NULL;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "score" integer;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "passing_score" integer;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "assigned_to_user_id" integer;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "document_id" integer;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "document_revision_snapshot" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "acknowledgment_text" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "signed_initials" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "signed_meaning" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "signed_at" timestamp with time zone;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "signed_by_user_id" integer;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "signed_by_full_name" text;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "training_records" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- ===== users.ts :: users =====
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "clerk_user_id" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "full_name" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "initials" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'Operator' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

COMMIT;
