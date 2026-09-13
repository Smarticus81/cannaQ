CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text,
	"active_facility_id" integer,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"initials" text NOT NULL,
	"role" text DEFAULT 'Operator' NOT NULL,
	"departments" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "company_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"license_number" text,
	"address" text,
	"city" text,
	"state" text,
	"zip" text,
	"phone" text,
	"email" text,
	"contact_person" text,
	"supplier_scoring_enabled" boolean DEFAULT false NOT NULL,
	"time_zone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulatory_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"max_thc_per_serving" real DEFAULT 10 NOT NULL,
	"max_thc_per_container" real DEFAULT 200 NOT NULL,
	"potency_tolerance_pct" real DEFAULT 10 NOT NULL,
	"retention_years" integer DEFAULT 4 NOT NULL,
	"tracing_system" text,
	"additional_config" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulatory_config_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "supplier_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"file_type" text NOT NULL,
	"file_name" text NOT NULL,
	"file_path" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_name" text NOT NULL,
	"contact_person" text,
	"email" text,
	"phone" text,
	"address" text,
	"license_number" text,
	"supplier_type" text NOT NULL,
	"status" text DEFAULT 'Pending Review' NOT NULL,
	"quality_rating" text,
	"notes" text,
	"requalification_interval_years" integer DEFAULT 1 NOT NULL,
	"risk_tier" text,
	"risk_tier_rationale" text,
	"risk_tier_set_at" timestamp with time zone,
	"risk_tier_set_by_name" text,
	"reviewed_risk_tier" text,
	"reviewed_risk_tier_at" timestamp with time zone,
	"reviewed_risk_score" integer,
	"reviewed_risk_factors" text[],
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_inspection_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"inspection_id" integer NOT NULL,
	"item_name" text NOT NULL,
	"material_type" text,
	"supplier_item_code" text,
	"lot_number" text,
	"metrc_tag" text,
	"strain_type" text,
	"thc_pct" real,
	"cbd_pct" real,
	"potency_source" text,
	"potency_tested_at" date,
	"expiry_date" date,
	"quantity_received" real,
	"quantity_uom" text,
	"result" text DEFAULT 'Pass' NOT NULL,
	"notes" text,
	"disposition" text,
	"disposition_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"inspection_number" text NOT NULL,
	"supplier_id" integer,
	"supplier_name" text,
	"po_manifest_number" text,
	"inspection_date" date NOT NULL,
	"inspected_by" integer,
	"inspected_by_name" text,
	"result" text DEFAULT 'Pending' NOT NULL,
	"inspection_notes" text,
	"state_rationale" text,
	"state_rationale_by_name" text,
	"state_rationale_at" timestamp with time zone,
	"pass_approver_name" text,
	"pass_approver_initials" text,
	"pass_approver_meaning" text,
	"pass_approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incoming_inspections_inspection_number_unique" UNIQUE("inspection_number")
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"item_name" text NOT NULL,
	"item_type" text NOT NULL,
	"supplier_id" integer,
	"lot_number" text,
	"quantity" real DEFAULT 0 NOT NULL,
	"unit_of_measure" text NOT NULL,
	"reorder_point" real,
	"reorder_quantity" real,
	"notes" text,
	"source_inspection_item_id" integer,
	"is_starter_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_source_inspection_item_id_unique" UNIQUE("source_inspection_item_id")
);
--> statement-breakpoint
CREATE TABLE "batch_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"batch_number" text NOT NULL,
	"batch_type" text NOT NULL,
	"process_type" text DEFAULT 'Kitchen' NOT NULL,
	"product_type" text NOT NULL,
	"sale_type" text DEFAULT 'Retail' NOT NULL,
	"strain_name" text,
	"strain_type" text,
	"product_name" text NOT NULL,
	"status" text DEFAULT 'in_production' NOT NULL,
	"scheduled_output_quantity" real,
	"output_quantity" real,
	"cases_produced" integer,
	"cartons_produced" integer,
	"unit_of_measure" text,
	"metrc_package_id" text,
	"production_date" date,
	"expiration_date" date,
	"remediation_status" text,
	"approved_by" integer,
	"approval_name" text,
	"approval_initials" text,
	"approval_date" timestamp with time zone,
	"approval_meaning" text,
	"notes" text,
	"recipe_id" integer,
	"label_net_weight" real,
	"label_net_weight_unit" text,
	"spec_doc_id" integer,
	"spec_revision_at_link" text,
	"spec_linked_at" timestamp with time zone,
	"spec_doc_snapshot" jsonb,
	"spec_sections_snapshot" jsonb,
	"spec_process_steps_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_records_batch_number_unique" UNIQUE("batch_number")
);
--> statement-breakpoint
CREATE TABLE "batch_ingredients" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"inventory_item_id" integer,
	"lot_id" integer,
	"ingredient_name" text NOT NULL,
	"lot_number" text,
	"planned_quantity" real,
	"actual_quantity" real,
	"unit_of_measure" text NOT NULL,
	"kind" text DEFAULT 'Ingredient' NOT NULL,
	"supplier_id" integer,
	"supplier_lot_number" text,
	"received_at" timestamp with time zone,
	"expiration_date" date,
	"inv_decremented_qty" real DEFAULT 0 NOT NULL,
	"lot_committed_qty" real DEFAULT 0 NOT NULL,
	"parent_ingredient_id" integer,
	"short_draw_approved_by_name" text,
	"short_draw_approved_initials" text,
	"short_draw_reason" text,
	"short_draw_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_testing" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"sequence_number" integer DEFAULT 1 NOT NULL,
	"chamber" text,
	"phase" text DEFAULT 'result' NOT NULL,
	"sample_weight" real,
	"sample_uom" text,
	"sample_pulled_at" date,
	"sample_pulled_by_name" text,
	"testing_agency_id" integer,
	"testing_agency" text NOT NULL,
	"submitted_date" date,
	"result_date" date,
	"test_result" text DEFAULT 'Pending' NOT NULL,
	"result_values" jsonb,
	"thc_pct" real,
	"cbd_pct" real,
	"total_cannabinoids" real,
	"microbials_pass" boolean,
	"pesticides_pass" boolean,
	"heavy_metals_pass" boolean,
	"residual_solvents_pass" boolean,
	"vitamin_e_acetate" real,
	"mct_oil_pass" boolean,
	"coa_url" text,
	"notes" text,
	"sample_metrc_tag" text,
	"thc_mg_per_serving" real,
	"cbd_mg_per_serving" real,
	"thc_mg_per_package" real,
	"cbd_mg_per_package" real,
	"label_claim_thc" real,
	"label_claim_cbd" real,
	"potency_within_tolerance" boolean,
	"pull_source" text,
	"pulled_at" timestamp with time zone,
	"lab_result_raw" jsonb,
	"verified_by_name" text,
	"verified_by_initials" text,
	"verified_meaning" text,
	"verified_at" timestamp with time zone,
	"sample_collected_at" timestamp with time zone,
	"sample_transferred_at" timestamp with time zone,
	"source_package_tag" text,
	"source_remaining_qty" real,
	"source_remaining_uom" text,
	"lab_collector_name" text,
	"observer_name" text,
	"coc_metrc_identified" boolean DEFAULT false NOT NULL,
	"coc_observed_throughout" boolean DEFAULT false NOT NULL,
	"coc_no_assist" boolean DEFAULT false NOT NULL,
	"coc_retest_confirmed" boolean,
	"coc_signed_by_name" text,
	"coc_signed_by_initials" text,
	"coc_signed_meaning" text,
	"coc_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_label_prints" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"label_template_id" integer,
	"label_template_name" text,
	"label_template_version" integer,
	"printed_by_id" integer,
	"printed_by_name" text,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" integer,
	"reviewed_by_name" text,
	"reviewer_initials" text,
	"reviewer_meaning" text,
	"reviewed_at" timestamp with time zone,
	"row_count" integer,
	"export_format" text
);
--> statement-breakpoint
CREATE TABLE "batch_labeling" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"product_type" text NOT NULL,
	"label_version" text,
	"metrc_tag_number" text,
	"label_notes" text,
	"approved_by" integer,
	"approval_name" text,
	"approval_initials" text,
	"approval_meaning" text,
	"approval_date" timestamp with time zone,
	"checklist_complete_pct" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_labeling_batch_id_unique" UNIQUE("batch_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"labeling_id" integer NOT NULL,
	"product_type" text NOT NULL,
	"item_number" integer NOT NULL,
	"item_text" text NOT NULL,
	"regulation_ref" text NOT NULL,
	"required" text DEFAULT 'true' NOT NULL,
	"control" text,
	"requirement_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"checklist_item_id" integer NOT NULL,
	"response" text NOT NULL,
	"notes" text,
	"responded_by" integer,
	"responded_by_name" text,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_responses_checklist_item_id_unique" UNIQUE("checklist_item_id")
);
--> statement-breakpoint
CREATE TABLE "label_static_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"product_type" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"regulation_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_by_id" integer,
	"approved_by_name" text,
	"approval_date" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"product_type" text NOT NULL,
	"name" text NOT NULL,
	"width_in" real DEFAULT 2 NOT NULL,
	"height_in" real DEFAULT 4 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_id" integer,
	"created_by_name" text,
	"regulatory_approver_id" integer,
	"regulatory_approver_name" text,
	"regulatory_approver_initials" text,
	"regulatory_approved_at" timestamp with time zone,
	"regulatory_approver_meaning" text,
	"marketing_approver_id" integer,
	"marketing_approver_name" text,
	"marketing_approver_initials" text,
	"marketing_approved_at" timestamp with time zone,
	"marketing_approver_meaning" text,
	"retired_by_id" integer,
	"retired_by_name" text,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"approved_by_id" integer,
	"approved_by_name" text,
	"approval_date" timestamp with time zone,
	"product_lineage_ids" jsonb,
	"coverage_keys" jsonb,
	"brand_only" boolean DEFAULT false NOT NULL,
	"packaging_order_override_reason" text,
	"packaging_order_override_by_id" integer,
	"packaging_order_override_by_name" text,
	"packaging_order_override_at" timestamp with time zone,
	"format_spec" jsonb,
	"field_list" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corrective_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"nc_id" integer NOT NULL,
	"action_description" text NOT NULL,
	"assigned_to" integer,
	"assigned_to_name" text,
	"due_date" date,
	"status" text DEFAULT 'Open' NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nc_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"nc_id" integer NOT NULL,
	"description" text NOT NULL,
	"due_date" date,
	"task_owner_user_id" integer,
	"task_owner_name" text,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" integer,
	"completed_by_name" text,
	"performed_on" date,
	"performed_by_user_id" integer,
	"performed_by_name" text,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "non_conformances" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"nc_number" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"severity_rationale" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"source" text NOT NULL,
	"identified_at" date,
	"reported_by_name" text,
	"reported_by_user_id" integer,
	"owner_user_id" integer,
	"owner_name" text,
	"batch_id" integer,
	"supplier_id" integer,
	"source_inspection_id" integer,
	"source_complaint_id" integer,
	"disposition" text,
	"destruction_record_id" integer,
	"use_as_is_approver_name" text,
	"use_as_is_approver_initials" text,
	"use_as_is_approver_meaning" text,
	"use_as_is_approved_at" timestamp with time zone,
	"use_as_is_rationale" text,
	"root_cause" text,
	"root_causes" text[],
	"skip_capa_rationale" text,
	"nc_type_as_found" text,
	"nc_type_confirmed" text,
	"affected_inventory_item_id" integer,
	"affected_lot_id" integer,
	"affected_document_id" integer,
	"product_type" text,
	"product_name" text,
	"lot_number" text,
	"department" text,
	"approved_by" integer,
	"approval_name" text,
	"approval_initials" text,
	"approval_date" timestamp with time zone,
	"mgmt_acknowledged_by" integer,
	"mgmt_acknowledged_name" text,
	"mgmt_acknowledged_initials" text,
	"mgmt_acknowledged_at" timestamp with time zone,
	"mgmt_acknowledged_notes" text,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "non_conformances_nc_number_unique" UNIQUE("nc_number")
);
--> statement-breakpoint
CREATE TABLE "complaint_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"complaint_id" integer NOT NULL,
	"description" text NOT NULL,
	"due_date" date,
	"task_owner_user_id" integer,
	"task_owner_name" text,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" integer,
	"completed_by_name" text,
	"performed_on" date,
	"performed_by_user_id" integer,
	"performed_by_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"complaint_number" text NOT NULL,
	"received_date" date NOT NULL,
	"customer_name" text,
	"product_name" text,
	"batch_id" integer,
	"nc_id" integer,
	"capa_id" integer,
	"complaint_type" text NOT NULL,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"investigation" text,
	"resolution" text,
	"root_causes" text[],
	"no_action_required" boolean DEFAULT false NOT NULL,
	"no_action_rationale" text,
	"field_action_id" integer,
	"closed_at" timestamp with time zone,
	"reporter_name" text,
	"reporter_email" text,
	"reporter_phone" text,
	"lot_number" text,
	"severity_rationale" text,
	"mdr_reportable" boolean DEFAULT false NOT NULL,
	"mdard_reportable" boolean DEFAULT false NOT NULL,
	"fda_reportable" boolean DEFAULT false NOT NULL,
	"cra_reportable" boolean DEFAULT false NOT NULL,
	"reportability_triage" jsonb,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_complaint_number_unique" UNIQUE("complaint_number")
);
--> statement-breakpoint
CREATE TABLE "field_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"fa_number" text NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'Initiated' NOT NULL,
	"title" text NOT NULL,
	"initiation_reason" text NOT NULL,
	"affected_batches" text,
	"scope_description" text,
	"response_actions" text,
	"due_diligence_notes" text,
	"closure_notes" text,
	"closed_by" integer,
	"closed_by_name" text,
	"closed_by_initials" text,
	"closed_by_meaning" text,
	"closed_at" timestamp with time zone,
	"product_type" text,
	"product_name" text,
	"lot_number" text,
	"department" text,
	"source_nc_id" integer,
	"source_complaint_id" integer,
	"linked_capa_id" integer,
	"requested_by_id" integer,
	"requested_by_name" text,
	"requested_at" timestamp with time zone,
	"reviewed_by_id" integer,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"gate0_approver_id" integer,
	"gate0_approver_name" text,
	"gate0_approver_initials" text,
	"gate0_approver_meaning" text,
	"gate0_approved_at" timestamp with time zone,
	"gate1_approver_id" integer,
	"gate1_approver_name" text,
	"gate1_approver_initials" text,
	"gate1_approver_meaning" text,
	"gate1_approved_at" timestamp with time zone,
	"gate2_approver_id" integer,
	"gate2_approver_name" text,
	"gate2_approver_initials" text,
	"gate2_approver_meaning" text,
	"gate2_approved_at" timestamp with time zone,
	"last_rejection_at" timestamp with time zone,
	"last_rejection_stage" text,
	"last_rejection_by_id" integer,
	"last_rejection_by_name" text,
	"last_rejection_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_actions_fa_number_unique" UNIQUE("fa_number")
);
--> statement-breakpoint
CREATE TABLE "packaging_designs" (
	"id" serial PRIMARY KEY NOT NULL,
	"design_name" text NOT NULL,
	"product_type" text NOT NULL,
	"version" text DEFAULT '1.0' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"artwork_url" text,
	"checklist_complete_pct" real,
	"checklist_items" jsonb,
	"proof_is_artwork" boolean DEFAULT false NOT NULL,
	"approved_states" jsonb,
	"product_lineage_ids" jsonb,
	"requirement_targets" jsonb,
	"requirement_notes" jsonb,
	"approved_by" integer,
	"approval_name" text,
	"approval_initials" text,
	"approval_date" timestamp with time zone,
	"quality_approver_id" integer,
	"quality_approver_name" text,
	"quality_approver_initials" text,
	"quality_approver_meaning" text,
	"quality_approved_at" timestamp with time zone,
	"manager_approver_id" integer,
	"manager_approver_name" text,
	"manager_approver_initials" text,
	"manager_approver_meaning" text,
	"manager_approved_at" timestamp with time zone,
	"notes" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" integer NOT NULL,
	"operation" text NOT NULL,
	"changed_by" integer,
	"changed_by_name" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"compliance_recipients" text DEFAULT '' NOT NULL,
	"inventory_recipients" text DEFAULT '' NOT NULL,
	"send_hour_utc" integer DEFAULT 12 NOT NULL,
	"send_day_of_week" integer DEFAULT 1 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_compliance_sent_at" timestamp with time zone,
	"last_inventory_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capa_action_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"capa_id" integer NOT NULL,
	"sequence_number" integer DEFAULT 1 NOT NULL,
	"action_description" text NOT NULL,
	"assigned_to_id" integer,
	"assigned_to_name" text,
	"due_date" date,
	"status" text DEFAULT 'Open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_id" integer,
	"completed_by_name" text,
	"verified_at" timestamp with time zone,
	"verified_by_id" integer,
	"verified_by_name" text,
	"notes" text,
	"performed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capas" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"capa_number" text NOT NULL,
	"type" text DEFAULT 'Corrective' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"source_nc_id" integer,
	"source_complaint_id" integer,
	"root_cause_analysis" text,
	"rca_method" text,
	"rca_methods" text[],
	"rca_investigator_name" text,
	"effectiveness_criteria" text,
	"effectiveness_check_due" date,
	"effectiveness_verified_at" timestamp with time zone,
	"effectiveness_verified_by_id" integer,
	"effectiveness_verified_by_name" text,
	"effectiveness_verified_by_initials" text,
	"effectiveness_outcome" text,
	"effectiveness_notes" text,
	"stage" text DEFAULT 'Initiation' NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"originator_id" integer,
	"originator_name" text,
	"effectiveness_owner_id" integer,
	"effectiveness_owner_name" text,
	"ec_owner_segregation_override_reason" text,
	"ec_owner_segregation_override_by" text,
	"ec_owner_segregation_override_at" timestamp with time zone,
	"gate0_approver_id" integer,
	"gate0_approver_name" text,
	"gate0_approver_initials" text,
	"gate0_approver_at" timestamp with time zone,
	"gate0_approver_meaning" text,
	"gate0_approved_at" timestamp with time zone,
	"gate1_approver1_id" integer,
	"gate1_approver1_name" text,
	"gate1_approver1_initials" text,
	"gate1_approver1_at" timestamp with time zone,
	"gate1_approver1_meaning" text,
	"gate1_approver2_id" integer,
	"gate1_approver2_name" text,
	"gate1_approver2_initials" text,
	"gate1_approver2_at" timestamp with time zone,
	"gate1_approver2_meaning" text,
	"gate1_approved_at" timestamp with time zone,
	"gate2_approver_id" integer,
	"gate2_approver_name" text,
	"gate2_approver_initials" text,
	"gate2_approver_at" timestamp with time zone,
	"gate2_approver_meaning" text,
	"gate2_outcome" text,
	"last_rejection_at" timestamp with time zone,
	"last_rejection_stage" text,
	"last_rejection_by_id" integer,
	"last_rejection_by_name" text,
	"last_rejection_comment" text,
	"last_rejection_target" text,
	"opened_by_id" integer,
	"opened_by_name" text,
	"closed_by_id" integer,
	"closed_by_name" text,
	"closed_by_initials" text,
	"closure_notes" text,
	"closed_at" timestamp with time zone,
	"product_type" text,
	"product_name" text,
	"lot_number" text,
	"department" text,
	"investigation_due_date" date,
	"action_planning_due_date" date,
	"ec_planning_due_date" date,
	"correction_pa_closure_due_date" date,
	"ec_check_closure_due_date" date,
	"root_causes" text[],
	"risk_level" text,
	"risk_rationale" text,
	"risk_released" boolean,
	"risk_customer_affected" boolean,
	"risk_labeling_impact" boolean,
	"risk_in_house_only" boolean,
	"risk_pre_bulk" boolean,
	"risk_revised_at" timestamp with time zone,
	"risk_revised_by_name" text,
	"risk_revised_reason" text,
	"risk_revised_from" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capas_capa_number_unique" UNIQUE("capa_number")
);
--> statement-breakpoint
CREATE TABLE "training_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"record_number" text NOT NULL,
	"employee_name" text NOT NULL,
	"employee_id" text,
	"department" text,
	"training_type" text NOT NULL,
	"topic" text NOT NULL,
	"description" text,
	"document_reference" text,
	"trainer_name" text,
	"assigned_date" date NOT NULL,
	"due_date" date,
	"completed_date" date,
	"status" text DEFAULT 'Assigned' NOT NULL,
	"score" integer,
	"passing_score" integer,
	"supervised_task_qty" integer,
	"notes" text,
	"created_by_name" text,
	"training_session_id" text,
	"session_attachment_id" integer,
	"assigned_to_user_id" integer,
	"document_id" integer,
	"document_revision_snapshot" text,
	"acknowledgment_text" text,
	"signed_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"signed_by_user_id" integer,
	"signed_by_full_name" text,
	"trainer_signed_initials" text,
	"trainer_signed_meaning" text,
	"trainer_signed_at" timestamp with time zone,
	"trainer_signed_by_user_id" integer,
	"trainer_signed_by_full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_records_record_number_unique" UNIQUE("record_number")
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" serial NOT NULL,
	"revision" text NOT NULL,
	"status" text NOT NULL,
	"summary_of_changes" text,
	"change_severity" text,
	"retraining_method" text,
	"author_name" text,
	"reviewer_name" text,
	"reviewer_signed_at" timestamp with time zone,
	"approved_by_name" text,
	"approval_date" date,
	"effective_date" date,
	"obsoleted_at" timestamp with time zone,
	"obsoleted_by_name" text,
	"admin_action" text,
	"admin_reason" text,
	"admin_by_name" text,
	"admin_by_initials" text,
	"admin_meaning" text,
	"content_snapshot" jsonb,
	"content_snapshot_at" timestamp with time zone,
	"content_snapshot_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"doc_number" text NOT NULL,
	"title" text NOT NULL,
	"document_type" text NOT NULL,
	"revision" text DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"owner_name" text,
	"department" text,
	"departments" text[],
	"description" text,
	"scope" text,
	"body_markdown" text,
	"is_starter_default" boolean DEFAULT false NOT NULL,
	"recipe_id" integer,
	"effective_date" date,
	"review_date" date,
	"approved_by_name" text,
	"approval_date" date,
	"summary_of_changes" text,
	"review_round" integer DEFAULT 0 NOT NULL,
	"change_severity" text,
	"retraining_method" text,
	"created_by_name" text,
	"created_by_user_id" integer,
	"assigned_reviewer_id" integer,
	"assigned_reviewer_name" text,
	"assigned_approver_id" integer,
	"assigned_approver_name" text,
	"reviewer_signed_at" timestamp with time zone,
	"reviewer_signed_name" text,
	"reviewer_signed_initials" text,
	"reviewer_signed_meaning" text,
	"approver_signed_at" timestamp with time zone,
	"approver_signed_initials" text,
	"approver_signed_meaning" text,
	"recipe_confirmed_at" timestamp with time zone,
	"recipe_confirmed_version" integer,
	"recipe_update_flagged" boolean DEFAULT false NOT NULL,
	"review_interval_years" integer DEFAULT 3 NOT NULL,
	"next_review_date" date,
	"planned_effective_date" date,
	"obsoleted_at" timestamp with time zone,
	"obsoleted_by_name" text,
	"obsoleted_meaning" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"rescinded_at" timestamp with time zone,
	"rescinded_reason" text,
	"rescinded_by_name" text,
	"rescinded_to_status" text,
	"rescinded_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_doc_number_unique" UNIQUE("doc_number")
);
--> statement-breakpoint
CREATE TABLE "document_favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"document_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_document_favorites_user_doc" UNIQUE("clerk_user_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_qualifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"qual_number" text NOT NULL,
	"qualification_type" text NOT NULL,
	"record_type" text,
	"risk_level" text DEFAULT 'Medium' NOT NULL,
	"status" text DEFAULT 'Scheduled' NOT NULL,
	"assessor_name" text,
	"assessment_date" date,
	"expiry_date" date,
	"issuer" text,
	"certificate_number" text,
	"score" integer,
	"findings" text,
	"corrective_actions_required" text,
	"audit_reason" text,
	"corrections" jsonb,
	"corrections_rationale" text,
	"closure_verification" text,
	"closure_date" date,
	"quality_signed_name" text,
	"quality_signed_initials" text,
	"quality_signed_at" timestamp with time zone,
	"manager_signed_name" text,
	"manager_signed_initials" text,
	"manager_signed_at" timestamp with time zone,
	"approved_by_name" text,
	"approval_date" date,
	"notes" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_qualifications_qual_number_unique" UNIQUE("qual_number")
);
--> statement-breakpoint
CREATE TABLE "batch_outputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"lot_id" integer NOT NULL,
	"quantity" real NOT NULL,
	"unit_of_measure" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"lot_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"quantity_delta" real DEFAULT 0 NOT NULL,
	"resulting_quantity" real NOT NULL,
	"related_lot_id" integer,
	"related_batch_id" integer,
	"reason" text,
	"notes" text,
	"performed_by" integer,
	"performed_by_name" text,
	"signed_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"lot_number" text,
	"item_name" text NOT NULL,
	"item_type" text NOT NULL,
	"unit_of_measure" text NOT NULL,
	"original_quantity" real NOT NULL,
	"current_quantity" real NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"is_cannabis" boolean DEFAULT true NOT NULL,
	"available_as_ingredient" boolean DEFAULT false NOT NULL,
	"supplier_id" integer,
	"inventory_item_id" integer,
	"source_inspection_id" integer,
	"source_batch_id" integer,
	"parent_lot_id" integer,
	"metrc_package_id" text,
	"expiration_date" date,
	"thc_pct" real,
	"cbd_pct" real,
	"potency_source" text,
	"potency_tested_at" date,
	"notes" text,
	"created_by" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"lot_id" integer NOT NULL,
	"customer_name" text NOT NULL,
	"customer_license" text,
	"shipped_quantity" real NOT NULL,
	"unit_of_measure" text NOT NULL,
	"manifest_number" text,
	"status" text DEFAULT 'Shipped' NOT NULL,
	"shipped_date" date NOT NULL,
	"shipped_by" integer,
	"shipped_by_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment_blobs" (
	"object_path" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_table" text NOT NULL,
	"parent_id" integer NOT NULL,
	"kind" text DEFAULT 'supplementary' NOT NULL,
	"object_path" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"description" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"uploaded_by_user_id" integer,
	"uploaded_by_name" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by_attachment_id" integer,
	"document_revision_snapshot" text,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" integer,
	"voided_by_name" text,
	"voided_reason" text,
	"voided_initials" text,
	"voided_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_action_lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_action_id" integer NOT NULL,
	"lot_id" integer NOT NULL,
	"quarantined_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_action_lots_unique" UNIQUE("field_action_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "field_action_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_action_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"notes" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_action_batches_unique" UNIQUE("field_action_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "fa_response_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_action_id" integer NOT NULL,
	"store_name" text NOT NULL,
	"store_license_number" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_email" text,
	"notification_date" date,
	"method" text,
	"confirmation_reference" text,
	"units_affected" integer,
	"units_returned" integer,
	"product_returned" boolean DEFAULT false NOT NULL,
	"product_destroyed" boolean DEFAULT false NOT NULL,
	"response_form_received" boolean DEFAULT false NOT NULL,
	"response_form_received_date" date,
	"all_items_accounted" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by_user_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipe_id" integer NOT NULL,
	"ingredient_name" text NOT NULL,
	"planned_quantity" real,
	"unit_of_measure" text DEFAULT 'g' NOT NULL,
	"kind" text DEFAULT 'Ingredient' NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_type" text NOT NULL,
	"subtype" text,
	"product_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"reference_unit_count" integer DEFAULT 100 NOT NULL,
	"lineage_id" integer,
	"superseded_by_recipe_id" integer,
	"content_revised_at" timestamp with time zone,
	"grandfathered_at" timestamp with time zone,
	"notes" text,
	"net_weight" real,
	"net_weight_unit" text,
	"serving_size" text,
	"serving_strength_mg" real,
	"servings_per_package" integer,
	"dual_chamber_two_oils" boolean,
	"dual_chamber_combined_draw" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_process_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipe_id" integer NOT NULL,
	"step_number" integer DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"template" text,
	"instructions" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_process_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"recipe_step_id" integer,
	"step_number" integer DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"template" text,
	"instructions" text,
	"step_kind" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"field_values" jsonb,
	"rendered_text" text,
	"performed_by_user_id" integer,
	"performed_by_name" text,
	"signed_initials" text,
	"signed_meaning" text,
	"performed_at" timestamp with time zone,
	"notes" text,
	"cosign_required" boolean DEFAULT false NOT NULL,
	"supervisor_user_id" integer,
	"supervisor_name" text,
	"supervisor_initials" text,
	"supervisor_meaning" text,
	"supervisor_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destruction_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"metrc_tag" text NOT NULL,
	"destroyed_at" timestamp with time zone NOT NULL,
	"destroyed_by_name" text NOT NULL,
	"witness_name" text,
	"weight" real,
	"weight_uom" text,
	"method" text,
	"notes" text,
	"reason" text,
	"non_cannabis_material" text,
	"mixture_confirmed" boolean DEFAULT false NOT NULL,
	"signed_by_name" text,
	"signed_by_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"disposal_route" text,
	"hauler_name" text,
	"manifest_number" text,
	"source_batch_id" integer,
	"source_lot_number" text,
	"surveillance_confirmed" boolean DEFAULT false NOT NULL,
	"surveillance_camera_ref" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"metrc_adjustment_reason" text,
	"archived_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destruction_record_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"destruction_record_id" integer NOT NULL,
	"metrc_tag" text NOT NULL,
	"item_name" text,
	"amount" real,
	"uom" text,
	"reason" text,
	"source_batch_id" integer,
	"note" text,
	"metrc_synced" boolean DEFAULT false NOT NULL,
	"metrc_sync_error" text,
	"metrc_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_qualifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"operator_user_id" integer NOT NULL,
	"recipe_id" integer NOT NULL,
	"status" text DEFAULT 'In Training' NOT NULL,
	"required_supervised_batches" integer DEFAULT 5 NOT NULL,
	"qualified_at" timestamp with time zone,
	"qualified_by_supervisor_user_id" integer,
	"qualified_by_supervisor_name" text,
	"signed_initials" text,
	"signed_meaning" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_operator_recipe" UNIQUE("operator_user_id","recipe_id")
);
--> statement-breakpoint
CREATE TABLE "regulatory_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"published_date" date,
	"raw_text" text,
	"ai_summary" text,
	"severity" text DEFAULT 'Informational' NOT NULL,
	"impacted_documents" jsonb,
	"impacted_label_templates" jsonb,
	"suggested_actions" jsonb,
	"linked_actions" jsonb,
	"ai_model" text,
	"status" text DEFAULT 'New' NOT NULL,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_metrc_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"source_tag" text,
	"stage_label" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"metrc_tag" text,
	"range_start" text,
	"range_end" text,
	"range_count" integer,
	"quantity" numeric,
	"uom" text,
	"label_status" text DEFAULT 'labeled' NOT NULL,
	"dispensary_name" text,
	"labeled_by_user_id" integer,
	"labeled_by_name" text,
	"labeled_at" timestamp with time zone,
	"recorded_by_user_id" integer,
	"recorded_by_name" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrc_package_created_at" timestamp with time zone,
	"metrc_sync_error" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_user_id" integer,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_candidate_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"complaint_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"status" text DEFAULT 'suspected' NOT NULL,
	"match_basis" text DEFAULT 'manual' NOT NULL,
	"entered_value" text,
	"note" text,
	"recorded_by_user_id" integer,
	"recorded_by_name" text,
	"resolved_by_user_id" integer,
	"resolved_by_name" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_risk_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"direction" text NOT NULL,
	"from_tier" text NOT NULL,
	"to_tier" text NOT NULL,
	"from_score" integer NOT NULL,
	"to_score" integer NOT NULL,
	"rationale" text NOT NULL,
	"factors_added" text[],
	"factors_removed" text[],
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"reviewed_by_user_id" integer,
	"reviewed_by_name" text,
	"reviewed_by_initials" text,
	"reviewed_meaning" text,
	"reviewed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"license_number" text NOT NULL,
	"license_type" text DEFAULT 'Retailer' NOT NULL,
	"address1" text,
	"address_city" text,
	"address_state" text,
	"address_postal_code" text,
	"main_phone" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transporter_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"transporter_facility_license_number" text NOT NULL,
	"driver_name" text,
	"driver_occupational_license_number" text,
	"driver_license_number" text,
	"phone_number_for_questions" text,
	"vehicle_make" text,
	"vehicle_model" text,
	"vehicle_license_plate_number" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_manifests" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"batch_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"transfer_type_name" text,
	"recipient_id" integer,
	"recipient_license_number" text,
	"recipient_name" text,
	"planned_route" text,
	"estimated_departure_date_time" timestamp with time zone,
	"estimated_arrival_date_time" timestamp with time zone,
	"transporter_facility_license_number" text,
	"driver_name" text,
	"driver_occupational_license_number" text,
	"driver_license_number" text,
	"vehicle_make" text,
	"vehicle_model" text,
	"vehicle_license_plate_number" text,
	"phone_number_for_questions" text,
	"gross_weight" numeric,
	"gross_unit_of_weight_name" text,
	"metrc_template_id" integer,
	"metrc_manifest_number" text,
	"pushed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_by_name" text,
	"signed_by_user_id" integer,
	"signed_by_name" text,
	"signed_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_manifest_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"manifest_id" integer NOT NULL,
	"package_label" text NOT NULL,
	"item_name" text,
	"quantity" numeric,
	"uom" text,
	"gross_weight" numeric,
	"gross_unit_of_weight_name" text,
	"wholesale_price" numeric,
	"source_tag_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"name" text NOT NULL,
	"license_type" text DEFAULT 'State' NOT NULL,
	"license_number" text NOT NULL,
	"issuer" text,
	"issue_date" date,
	"expiry_date" date,
	"status" text DEFAULT 'Active' NOT NULL,
	"notes" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_dashboard_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"base_template" text,
	"layout" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_dashboard_preferences_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "product_type_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_type" text NOT NULL,
	"shelf_life_days" integer,
	"default_net_weight" real,
	"default_net_weight_unit" text,
	"serving_size" text,
	"servings_per_package" integer,
	"activation_time" text,
	"updated_by_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_type_settings_product_type_unique" UNIQUE("product_type")
);
--> statement-breakpoint
CREATE TABLE "product_subtypes" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_type" text NOT NULL,
	"name" text NOT NULL,
	"default_net_weight" real,
	"default_net_weight_unit" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_check_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"check_id" integer NOT NULL,
	"metrc_tag" text NOT NULL,
	"item_name" text,
	"category" text,
	"uom" text,
	"system_qty" real,
	"counted_qty" real,
	"variance" real,
	"counted" boolean DEFAULT false NOT NULL,
	"reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_check_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"facility_id" integer,
	"cadence" text DEFAULT 'Quarterly' NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"updated_by_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer,
	"check_number" text NOT NULL,
	"period_label" text,
	"status" text DEFAULT 'In Progress' NOT NULL,
	"count_type" text DEFAULT 'Full' NOT NULL,
	"scheduled_date" timestamp with time zone,
	"metrc_snapshot_at" timestamp with time zone,
	"counted_by_name" text,
	"completed_at" timestamp with time zone,
	"signed_by_name" text,
	"signed_by_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by_name" text,
	"cancelled_by_initials" text,
	"cancelled_meaning" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_checks_check_number_unique" UNIQUE("check_number")
);
--> statement-breakpoint
CREATE TABLE "management_review_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_name" text,
	"trigger" text DEFAULT 'auto' NOT NULL,
	"period_start" text,
	"period_end" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "management_review_action_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"description" text NOT NULL,
	"owner_user_id" integer,
	"owner_name" text,
	"due_date" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_name" text,
	"carried_from_review_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "management_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer,
	"review_date" text,
	"period_start" text,
	"period_end" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"attendees" jsonb,
	"section_notes" jsonb,
	"outputs" text,
	"general_notes" text,
	"signed_by_user_id" integer,
	"signed_by_name" text,
	"signed_initials" text,
	"signed_meaning" text,
	"signed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"license_number" text,
	"license_type" text,
	"state" text DEFAULT 'MI' NOT NULL,
	"address" text,
	"city" text,
	"zip" text,
	"phone" text,
	"contact_person" text,
	"time_zone" text,
	"metrc_base_url" text,
	"metrc_license_number" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_facilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"facility_id" integer NOT NULL,
	"role_at_facility" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_metrc_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer NOT NULL,
	"vendor_key" text,
	"user_key" text,
	"updated_by_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"facility_id" integer,
	"revision_at_request" text,
	"what_is_wrong" text NOT NULL,
	"why_it_matters" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"raised_by_user_id" integer,
	"raised_by_name" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" integer,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_revision" text
);
--> statement-breakpoint
CREATE TABLE "user_onboarding" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_revision" integer,
	"completed_at" timestamp with time zone,
	"deferred_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_attachments" ADD CONSTRAINT "supplier_attachments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_inspection_items" ADD CONSTRAINT "incoming_inspection_items_inspection_id_incoming_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."incoming_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_inspections" ADD CONSTRAINT "incoming_inspections_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_inspections" ADD CONSTRAINT "incoming_inspections_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_records" ADD CONSTRAINT "batch_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_ingredients" ADD CONSTRAINT "batch_ingredients_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_ingredients" ADD CONSTRAINT "batch_ingredients_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_ingredients" ADD CONSTRAINT "batch_ingredients_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_testing" ADD CONSTRAINT "batch_testing_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_testing" ADD CONSTRAINT "batch_testing_testing_agency_id_suppliers_id_fk" FOREIGN KEY ("testing_agency_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_label_prints" ADD CONSTRAINT "batch_label_prints_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_label_prints" ADD CONSTRAINT "batch_label_prints_printed_by_id_users_id_fk" FOREIGN KEY ("printed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_label_prints" ADD CONSTRAINT "batch_label_prints_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_labeling" ADD CONSTRAINT "batch_labeling_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_labeling" ADD CONSTRAINT "batch_labeling_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_labeling_id_batch_labeling_id_fk" FOREIGN KEY ("labeling_id") REFERENCES "public"."batch_labeling"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_responses" ADD CONSTRAINT "checklist_responses_checklist_item_id_checklist_items_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "public"."checklist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_responses" ADD CONSTRAINT "checklist_responses_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_static_blocks" ADD CONSTRAINT "label_static_blocks_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_regulatory_approver_id_users_id_fk" FOREIGN KEY ("regulatory_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_marketing_approver_id_users_id_fk" FOREIGN KEY ("marketing_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_retired_by_id_users_id_fk" FOREIGN KEY ("retired_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_packaging_order_override_by_id_users_id_fk" FOREIGN KEY ("packaging_order_override_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_nc_id_non_conformances_id_fk" FOREIGN KEY ("nc_id") REFERENCES "public"."non_conformances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nc_corrections" ADD CONSTRAINT "nc_corrections_nc_id_non_conformances_id_fk" FOREIGN KEY ("nc_id") REFERENCES "public"."non_conformances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nc_corrections" ADD CONSTRAINT "nc_corrections_task_owner_user_id_users_id_fk" FOREIGN KEY ("task_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nc_corrections" ADD CONSTRAINT "nc_corrections_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nc_corrections" ADD CONSTRAINT "nc_corrections_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_source_inspection_id_incoming_inspections_id_fk" FOREIGN KEY ("source_inspection_id") REFERENCES "public"."incoming_inspections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_source_complaint_id_complaints_id_fk" FOREIGN KEY ("source_complaint_id") REFERENCES "public"."complaints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_destruction_record_id_destruction_records_id_fk" FOREIGN KEY ("destruction_record_id") REFERENCES "public"."destruction_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_affected_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("affected_inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_affected_lot_id_lots_id_fk" FOREIGN KEY ("affected_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_affected_document_id_documents_id_fk" FOREIGN KEY ("affected_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_mgmt_acknowledged_by_users_id_fk" FOREIGN KEY ("mgmt_acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_corrections" ADD CONSTRAINT "complaint_corrections_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_actions" ADD CONSTRAINT "field_actions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_actions" ADD CONSTRAINT "field_actions_gate0_approver_id_users_id_fk" FOREIGN KEY ("gate0_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_actions" ADD CONSTRAINT "field_actions_gate1_approver_id_users_id_fk" FOREIGN KEY ("gate1_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_actions" ADD CONSTRAINT "field_actions_gate2_approver_id_users_id_fk" FOREIGN KEY ("gate2_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_actions" ADD CONSTRAINT "field_actions_last_rejection_by_id_users_id_fk" FOREIGN KEY ("last_rejection_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_designs" ADD CONSTRAINT "packaging_designs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_designs" ADD CONSTRAINT "packaging_designs_quality_approver_id_users_id_fk" FOREIGN KEY ("quality_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_designs" ADD CONSTRAINT "packaging_designs_manager_approver_id_users_id_fk" FOREIGN KEY ("manager_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capa_action_items" ADD CONSTRAINT "capa_action_items_capa_id_capas_id_fk" FOREIGN KEY ("capa_id") REFERENCES "public"."capas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capa_action_items" ADD CONSTRAINT "capa_action_items_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capa_action_items" ADD CONSTRAINT "capa_action_items_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capa_action_items" ADD CONSTRAINT "capa_action_items_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_source_nc_id_non_conformances_id_fk" FOREIGN KEY ("source_nc_id") REFERENCES "public"."non_conformances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_source_complaint_id_complaints_id_fk" FOREIGN KEY ("source_complaint_id") REFERENCES "public"."complaints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_effectiveness_verified_by_id_users_id_fk" FOREIGN KEY ("effectiveness_verified_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_originator_id_users_id_fk" FOREIGN KEY ("originator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_effectiveness_owner_id_users_id_fk" FOREIGN KEY ("effectiveness_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_gate0_approver_id_users_id_fk" FOREIGN KEY ("gate0_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_gate1_approver1_id_users_id_fk" FOREIGN KEY ("gate1_approver1_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_gate1_approver2_id_users_id_fk" FOREIGN KEY ("gate1_approver2_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_gate2_approver_id_users_id_fk" FOREIGN KEY ("gate2_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_last_rejection_by_id_users_id_fk" FOREIGN KEY ("last_rejection_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capas" ADD CONSTRAINT "capas_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_trainer_signed_by_user_id_users_id_fk" FOREIGN KEY ("trainer_signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_qualifications" ADD CONSTRAINT "supplier_qualifications_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_outputs" ADD CONSTRAINT "batch_outputs_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_outputs" ADD CONSTRAINT "batch_outputs_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_related_lot_id_lots_id_fk" FOREIGN KEY ("related_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_related_batch_id_batch_records_id_fk" FOREIGN KEY ("related_batch_id") REFERENCES "public"."batch_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_source_inspection_id_incoming_inspections_id_fk" FOREIGN KEY ("source_inspection_id") REFERENCES "public"."incoming_inspections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_source_batch_id_batch_records_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."batch_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipped_by_users_id_fk" FOREIGN KEY ("shipped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_action_lots" ADD CONSTRAINT "field_action_lots_field_action_id_field_actions_id_fk" FOREIGN KEY ("field_action_id") REFERENCES "public"."field_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_action_lots" ADD CONSTRAINT "field_action_lots_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_action_batches" ADD CONSTRAINT "field_action_batches_field_action_id_field_actions_id_fk" FOREIGN KEY ("field_action_id") REFERENCES "public"."field_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_action_batches" ADD CONSTRAINT "field_action_batches_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fa_response_actions" ADD CONSTRAINT "fa_response_actions_field_action_id_field_actions_id_fk" FOREIGN KEY ("field_action_id") REFERENCES "public"."field_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fa_response_actions" ADD CONSTRAINT "fa_response_actions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_process_steps" ADD CONSTRAINT "recipe_process_steps_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_process_steps" ADD CONSTRAINT "batch_process_steps_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_process_steps" ADD CONSTRAINT "batch_process_steps_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_process_steps" ADD CONSTRAINT "batch_process_steps_supervisor_user_id_users_id_fk" FOREIGN KEY ("supervisor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_record_lines" ADD CONSTRAINT "destruction_record_lines_destruction_record_id_destruction_records_id_fk" FOREIGN KEY ("destruction_record_id") REFERENCES "public"."destruction_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_qualifications" ADD CONSTRAINT "operator_qualifications_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_qualifications" ADD CONSTRAINT "operator_qualifications_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_qualifications" ADD CONSTRAINT "operator_qualifications_qualified_by_supervisor_user_id_users_id_fk" FOREIGN KEY ("qualified_by_supervisor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_metrc_tags" ADD CONSTRAINT "batch_metrc_tags_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_metrc_tags" ADD CONSTRAINT "batch_metrc_tags_labeled_by_user_id_users_id_fk" FOREIGN KEY ("labeled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_metrc_tags" ADD CONSTRAINT "batch_metrc_tags_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_metrc_tags" ADD CONSTRAINT "batch_metrc_tags_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_candidate_batches" ADD CONSTRAINT "complaint_candidate_batches_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_candidate_batches" ADD CONSTRAINT "complaint_candidate_batches_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_candidate_batches" ADD CONSTRAINT "complaint_candidate_batches_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_candidate_batches" ADD CONSTRAINT "complaint_candidate_batches_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_changes" ADD CONSTRAINT "supplier_risk_changes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_changes" ADD CONSTRAINT "supplier_risk_changes_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_manifests" ADD CONSTRAINT "batch_manifests_batch_id_batch_records_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_manifests" ADD CONSTRAINT "batch_manifests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_manifests" ADD CONSTRAINT "batch_manifests_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_manifest_packages" ADD CONSTRAINT "batch_manifest_packages_manifest_id_batch_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."batch_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_check_lines" ADD CONSTRAINT "inventory_check_lines_check_id_inventory_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."inventory_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_review_action_items" ADD CONSTRAINT "management_review_action_items_review_id_management_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."management_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_review_action_items" ADD CONSTRAINT "management_review_action_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_reviews" ADD CONSTRAINT "management_reviews_snapshot_id_management_review_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."management_review_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_reviews" ADD CONSTRAINT "management_reviews_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_reviews" ADD CONSTRAINT "management_reviews_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facilities" ADD CONSTRAINT "user_facilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facilities" ADD CONSTRAINT "user_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_metrc_credentials" ADD CONSTRAINT "facility_metrc_credentials_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_change_requests" ADD CONSTRAINT "document_change_requests_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_parent_idx" ON "attachments" USING btree ("parent_table","parent_id");--> statement-breakpoint
CREATE INDEX "attachments_status_idx" ON "attachments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attachments_uploader_idx" ON "attachments" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_one_active_primary_per_parent" ON "attachments" USING btree ("parent_table","parent_id") WHERE "attachments"."kind" = 'primary' AND "attachments"."status" = 'Active';--> statement-breakpoint
CREATE UNIQUE INDEX "user_facilities_user_facility_key" ON "user_facilities" USING btree ("user_id","facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_metrc_credentials_facility_key" ON "facility_metrc_credentials" USING btree ("facility_id");