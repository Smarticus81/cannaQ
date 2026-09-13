import { MEMBERSHIP_SCHEMA_SQL } from "./membershipSchema";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { ONBOARDING_SCHEMA_SQL } from "./onboardingSchema";

// Session 59.2 — auto-apply idempotent schema on startup so a schema change no
// longer requires manually running SQL in the Railway console. Every statement
// here is idempotent (IF NOT EXISTS), so it is safe to run on every boot and is
// a no-op once applied. When a future feature needs a new table/column, append
// its idempotent DDL to the block below and it ships with the next deploy —
// push code, the app migrates itself.
//
// NOTE: this is intentionally a simple "ensure" pass, not a full migration
// framework. It only holds additive, idempotent DDL. Anything destructive or
// data-moving still goes through a reviewed migration file.
const SCHEMA_SQL = `
-- Session 59 — FDA process steps (recipe master + per-batch baker e-sign).
CREATE TABLE IF NOT EXISTS recipe_process_steps (
  id           SERIAL PRIMARY KEY,
  recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number  INTEGER NOT NULL DEFAULT 1,
  description  TEXT NOT NULL,
  template     TEXT,
  instructions TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipe_process_steps_recipe ON recipe_process_steps(recipe_id);

CREATE TABLE IF NOT EXISTS batch_process_steps (
  id                   SERIAL PRIMARY KEY,
  batch_id             INTEGER NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
  recipe_step_id       INTEGER,
  step_number          INTEGER NOT NULL DEFAULT 1,
  description          TEXT NOT NULL,
  template             TEXT,
  instructions         TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  completed            BOOLEAN NOT NULL DEFAULT false,
  field_values         JSONB,
  rendered_text        TEXT,
  performed_by_user_id INTEGER REFERENCES users(id),
  performed_by_name    TEXT,
  signed_initials      TEXT,
  signed_meaning       TEXT,
  performed_at         TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_process_steps_batch ON batch_process_steps(batch_id);

-- Upgrade tables created by an earlier draft of the Session 59 migration.
ALTER TABLE recipe_process_steps ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS field_values JSONB;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS rendered_text TEXT;

-- Session 60 — hybrid doc<->process bridge: a controlled document may optionally
-- be backed by a recipe, so its "process_steps" section renders from the same
-- recipe_process_steps the operator executes (single source of truth).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS recipe_id INTEGER;

-- Session 96 — starter document library: a readable on-screen body for
-- SOP/Policy/Manual docs, plus a flag marking the removable pre-approved
-- starter set seeded into a new facility.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS body_markdown TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_starter_default BOOLEAN NOT NULL DEFAULT false;

-- Starter inventory catalog: flag marking the removable pre-approved starter
-- items seeded into a new facility (see seedStarterInventory.ts).
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_starter_default BOOLEAN NOT NULL DEFAULT false;

-- Incoming-inspection failed-item disposition (RTV / Scrap / Use As Is / Rework).
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS disposition_notes TEXT;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS metrc_tag TEXT;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS strain_type TEXT;
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS strain_type TEXT;
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS expiration_date DATE;
ALTER TABLE fa_response_actions ADD COLUMN IF NOT EXISTS response_form_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fa_response_actions ADD COLUMN IF NOT EXISTS response_form_received_date DATE;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS checklist_items JSONB;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS proof_is_artwork BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS approved_states JSONB;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS requirement_targets JSONB;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS requirement_notes JSONB;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS product_lineage_ids JSONB;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS coverage_keys JSONB;
-- 2026-09-02 - a brand-only sticker is the one label allowed to carry nothing.
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS brand_only BOOLEAN NOT NULL DEFAULT FALSE;
-- 2026-09-02 - a packaging design says which products it is for, like a label does.
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS product_lineage_ids JSONB;
-- 2026-09-02 - package approval comes before label approval; signing out of
-- order needs a written reason, which is kept on the label.
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS packaging_order_override_reason TEXT;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS packaging_order_override_by_id INTEGER REFERENCES users(id);
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS packaging_order_override_by_name TEXT;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS packaging_order_override_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS recipe_confirmed_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS recipe_confirmed_version INTEGER;
ALTER TABLE regulatory_updates ADD COLUMN IF NOT EXISTS linked_actions JSONB;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS audit_reason TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS corrections JSONB;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS corrections_rationale TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS closure_verification TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS closure_date DATE;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS quality_signed_name TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS quality_signed_initials TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS quality_signed_at TIMESTAMPTZ;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS manager_signed_name TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS manager_signed_initials TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS manager_signed_at TIMESTAMPTZ;

-- Management Review Phase 2 — recordable, Part 11-signed review + action items.
CREATE TABLE IF NOT EXISTS management_reviews (
  id                  SERIAL PRIMARY KEY,
  snapshot_id         INTEGER REFERENCES management_review_snapshots(id),
  review_date         TEXT,
  period_start        TEXT,
  period_end          TEXT,
  status              TEXT NOT NULL DEFAULT 'draft',
  attendees           JSONB,
  section_notes       JSONB,
  outputs             TEXT,
  general_notes       TEXT,
  signed_by_user_id   INTEGER REFERENCES users(id),
  signed_by_name      TEXT,
  signed_initials     TEXT,
  signed_meaning      TEXT,
  signed_at           TIMESTAMPTZ,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS management_review_action_items (
  id                      SERIAL PRIMARY KEY,
  review_id               INTEGER NOT NULL REFERENCES management_reviews(id) ON DELETE CASCADE,
  description             TEXT NOT NULL,
  owner_user_id           INTEGER REFERENCES users(id),
  owner_name              TEXT,
  due_date                TEXT,
  status                  TEXT NOT NULL DEFAULT 'Open',
  completed_at            TIMESTAMPTZ,
  completed_by_name       TEXT,
  carried_from_review_id  INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session 61 — WI batch provenance: snapshot the linked doc's backing-recipe
-- process steps onto the batch at link time (proves "ran against revision X").
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS spec_process_steps_snapshot JSONB;

-- Session 62 (IN PROGRESS) — competency-based training for recipe-backed WIs.
-- Schema only so far; server routes + client are not built yet. The columns are
-- additive and inert until the gate/co-sign/qualify routes land, so this is safe
-- to deploy on its own.
CREATE TABLE IF NOT EXISTS operator_qualifications (
  id                              SERIAL PRIMARY KEY,
  operator_user_id                INTEGER NOT NULL REFERENCES users(id),
  recipe_id                       INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  status                          TEXT NOT NULL DEFAULT 'In Training',
  required_supervised_batches     INTEGER NOT NULL DEFAULT 2,
  qualified_at                    TIMESTAMPTZ,
  qualified_by_supervisor_user_id INTEGER REFERENCES users(id),
  qualified_by_supervisor_name    TEXT,
  signed_initials                 TEXT,
  signed_meaning                  TEXT,
  revoked_at                      TIMESTAMPTZ,
  revoked_reason                  TEXT,
  revoked_by_name                 TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_operator_recipe UNIQUE (operator_user_id, recipe_id)
);
CREATE INDEX IF NOT EXISTS idx_operator_qual_operator ON operator_qualifications(operator_user_id);
CREATE INDEX IF NOT EXISTS idx_operator_qual_recipe   ON operator_qualifications(recipe_id);

-- batch knows its recipe (drives the competency gate)
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS recipe_id INTEGER;

-- Session 66 (OQ-11) — persist the Part 11 meaning of the batch release signature
-- on the record so it can be displayed (was previously captured only in the audit log).
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS approval_meaning TEXT;

-- step co-sign fields (an unqualified operator's step stays pending until a
-- supervisor co-signs to complete it)
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS cosign_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS supervisor_user_id INTEGER;
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS supervisor_name TEXT;
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS supervisor_initials TEXT;
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS supervisor_meaning TEXT;
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS supervisor_signed_at TIMESTAMPTZ;

-- 2026-08-19 — marks the one step seeded onto every batch where the operator
-- records the bulk package tag and signing creates that package in METRC.
-- Null on every ordinary step.
ALTER TABLE batch_process_steps ADD COLUMN IF NOT EXISTS step_kind TEXT;

-- 2026-08-19 (same day) — the step first shipped using {metrc_tag}, which
-- Session 111 had already defined as "a METRC tag this batch drew FROM"; the
-- sign dialog dutifully prefilled it with the source lot. Renamed to
-- {new_package_tag}. Rewrites only UNSIGNED steps, so a Part 11 record can
-- never be altered, and is a no-op once every row is on the new token.
UPDATE batch_process_steps
   SET template = REPLACE(template, '{metrc_tag}', '{new_package_tag}')
 WHERE step_kind = 'metrc_package'
   AND completed = false
   AND cosign_required = false
   AND template LIKE '%{metrc_tag}%';

-- Session 79 (Step 3) — how much of each ingredient's actual quantity has been
-- pulled from its linked lot via the signed "confirm ingredients" e-signature.
-- Mirrors inv_decremented_qty but tracks the LOT draw-down (the visible ledger),
-- so a re-sign after an edit moves only the delta.
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS lot_committed_qty REAL NOT NULL DEFAULT 0;

-- Session 66 — E5 Regulatory Intelligence Agent (Tier 6 Wave 1). Stores ingested
-- regulatory bulletins with the agent's advisory summary/severity/impact mapping
-- and the human reviewer's disposition. Additive + idempotent.
CREATE TABLE IF NOT EXISTS regulatory_updates (
  id                       SERIAL PRIMARY KEY,
  source                   TEXT NOT NULL,
  title                    TEXT NOT NULL,
  source_url               TEXT,
  published_date           DATE,
  raw_text                 TEXT,
  ai_summary               TEXT,
  severity                 TEXT NOT NULL DEFAULT 'Informational',
  impacted_documents       JSONB,
  impacted_label_templates JSONB,
  suggested_actions        JSONB,
  ai_model                 TEXT,
  status                   TEXT NOT NULL DEFAULT 'New',
  reviewed_by_name         TEXT,
  reviewed_at              TIMESTAMPTZ,
  review_notes             TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regulatory_updates_status ON regulatory_updates(status);

-- Phase 5 step 2 (2026-08-30) — a checklist question now records WHICH control it
-- belongs to: "Packaging" (approved once with the design) or "Labeling" (checked
-- before every print). Nullable on purpose — rows seeded before today have no
-- control recorded, and back-filling them would be guessing at questions whose
-- citations were wrong anyway.
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS control TEXT;

-- Phase 5 step 3a — the requirement's STABLE key. itemNumber is positional and
-- shifts whenever a list is rebuilt (the 2026-08-30 rewrite renumbered every one),
-- so an ANSWERED row needs this to stay traceable to the requirement it was
-- actually answering — and a facility's choice of which checklist a requirement
-- belongs to has to hang off it rather than off a position.
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS requirement_key TEXT;
-- ⛔ RETIRED 2026-08-31 — facility_requirement_assignments.
-- (⚠️ NO BACKTICKS IN HERE. This whole block is a JS template literal, so one
-- backtick ends the string and the file stops compiling. It did.)
--
-- It stored ONE answer per SITE for where a labelling requirement is met. That
-- was the wrong shape: coverage belongs to the ARTEFACT that does the carrying,
-- so it now lives on the packaging design (packaging_designs.requirement_targets)
-- and, next, on the label template. Its routes and its schema definition are gone.
--
-- ⚠️ The CREATE is removed so a NEW database never grows a dead table, and no DROP
-- is issued so an existing one keeps the answers recorded on 2026-08-30. Dropping
-- it is irreversible and dead rows cost nothing.


-- Phase 5 Slice 2 (2026-08-30) — the PER-STATE rule sets.
--
-- The table has existed since the Session 43 resync, but ONLY as a set of
-- ALTER TABLE ADD COLUMN statements, so a database created from scratch never
-- got it at all. Created here properly and idempotently, which also gives a
-- fresh install the rule sets on first boot.
CREATE TABLE IF NOT EXISTS regulatory_config (
  id                       SERIAL PRIMARY KEY,
  state                    TEXT,
  max_thc_per_serving      REAL NOT NULL DEFAULT 10,
  max_thc_per_container    REAL NOT NULL DEFAULT 200,
  potency_tolerance_pct    REAL NOT NULL DEFAULT 10,
  retention_years          INTEGER NOT NULL DEFAULT 4,
  tracing_system           TEXT,
  additional_config        JSONB,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rule set per state. The Drizzle schema has always declared state unique;
-- the resync migration never actually created the constraint, so lookups could
-- have been ambiguous. Safe to add: only one row has ever existed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_regulatory_config_state ON regulatory_config(state);

-- Michigan, Illinois and New York. Values read from each state's own published
-- rules, 2026-08-30 — see the session notes for the section citations:
--   MI  R 420.x                     10 mg / 200 mg / 10% / 5 yr / METRC
--   IL  8 Ill. Adm. Code 1300       10 mg / 100 mg / 15% / 5 yr / METRC
--       (1300.920(d) serving+package; 1300.930(b)(8) tolerance is stated as
--        "not below 85% or above 115% of the labeled amount" = 15%;
--        1300.155/.455 records 5 yr — NOT the 90-day video figure)
--   NY  9 NYCRR 123.6 / 125         10 mg / 100 mg / 15% / 5 yr / METRC
--       (123.6(f)(1) serving+package; labeled potency variance 85-115% = 15%;
--        five years per record category, NOT one blanket provision)
--
-- ⛔ INSERT ... WHERE NOT EXISTS rather than ON CONFLICT: an existing row is
-- the CUSTOMER'S, possibly hand-tuned, and must never be overwritten by a boot
-- pass. Michigan already exists in the validation database and is left exactly
-- as it stands.
INSERT INTO regulatory_config (state, max_thc_per_serving, max_thc_per_container, potency_tolerance_pct, retention_years, tracing_system)
SELECT 'MI', 10, 200, 10, 5, 'METRC'
WHERE NOT EXISTS (SELECT 1 FROM regulatory_config WHERE state = 'MI');

INSERT INTO regulatory_config (state, max_thc_per_serving, max_thc_per_container, potency_tolerance_pct, retention_years, tracing_system)
SELECT 'IL', 10, 100, 15, 5, 'METRC'
WHERE NOT EXISTS (SELECT 1 FROM regulatory_config WHERE state = 'IL');

INSERT INTO regulatory_config (state, max_thc_per_serving, max_thc_per_container, potency_tolerance_pct, retention_years, tracing_system)
SELECT 'NY', 10, 100, 15, 5, 'METRC'
WHERE NOT EXISTS (SELECT 1 FROM regulatory_config WHERE state = 'NY');

-- ⛔ REPAIR of a seed that has silently done nothing since Session 36. That
-- migration set Michigan's required-analyte list with WHERE state = 'Michigan',
-- but the row has always been keyed 'MI', so the UPDATE matched no rows and
-- additional_config stayed NULL. Verified NULL in the live database 2026-08-30.
-- Illinois and New York are deliberately left NULL: their required panels are
-- real but the testing screen's analyte KEYS are a vocabulary decision, and
-- inventing keys it does not understand would be worse than an empty list.
UPDATE regulatory_config
SET additional_config = COALESCE(additional_config, '{}'::jsonb)
                      || jsonb_build_object('requiredAnalytes', jsonb_build_array('thc_pct', 'cbd_pct'))
WHERE state = 'MI'
  AND (additional_config IS NULL OR NOT (additional_config ? 'requiredAnalytes'));

-- Phase 5 Slice 3 step 1 (2026-08-30) — MICHIGAN'S SAFETY PANELS, moved out of
-- the screen and into the state's own rule set.
--
-- The panel list, its per-panel rule citations and the "Michigan CRA R 420.305"
-- heading were all typed into BatchDetail.tsx, which made the SCREEN the source
-- of truth for what a state requires. Adding a state meant editing the screen.
-- These are Michigan's five panels EXACTLY as the screen hardcoded them, so the
-- Testing tab renders identically — that is how we know the move is safe.
--
-- appliesTo preserves the Session 82 product-form gate: residual solvents only
-- on solvent-processed forms, the MCT-oil check only on vapes. Collecting a test
-- the form does not require was a compliance-accuracy problem, not just clutter.
--
-- ⛔ Merged with || so the requiredAnalytes set above is not clobbered, and
-- skipped entirely if a safetyPanels key already exists, so a hand-edited list
-- survives a redeploy.
UPDATE regulatory_config
SET additional_config = COALESCE(additional_config, '{}'::jsonb) || jsonb_build_object(
  'safetyPanels', jsonb_build_object(
    'heading', 'Michigan CRA R 420.305',
    'panels', jsonb_build_array(
      jsonb_build_object('key','microbialsPass','label','Microbials','citation','R 420.305(3)(c)','appliesTo','all'),
      jsonb_build_object('key','pesticidesPass','label','Pesticides','citation','R 420.305(3)(d)','appliesTo','all'),
      jsonb_build_object('key','heavyMetalsPass','label','Heavy Metals','citation','R 420.305(3)(e)','appliesTo','all'),
      jsonb_build_object('key','residualSolventsPass','label','Residual Solvents','citation','R 420.305(3)(f)','appliesTo','concentrate'),
      jsonb_build_object('key','mctOilPass','label','MCT Oil','formLabel','MCT Oil (vape)','citation','CRA Best Practices - MCT (vape)','appliesTo','vape')
    )
  )
)
WHERE state = 'MI'
  AND (additional_config IS NULL OR NOT (additional_config ? 'safetyPanels'));

-- ILLINOIS safety panels — 8 Ill. Adm. Code 1300.700(a)(1)-(6), amended eff.
-- 2026-05-01. Five contaminant panels; (6) active-ingredient analysis is the
-- potency section of the tab, not a pass/fail panel, so it is not listed here.
-- ⚠️ Illinois requires MYCOTOXINS, which Michigan does not — it is the first
-- panel with no legacy column, so it lives only in result_values.
-- ⚠️ Residual solvents are gated to solvent-processed forms, as Michigan does.
-- The Illinois rule sets limits split by inhalation vs non-inhalation rather
-- than naming the forms, so this gate is a reading of it, not a quotation.
-- ⛔ Water activity and moisture are NOT in the Illinois panel — verified
-- against 1300.700 rather than assumed from other states.
UPDATE regulatory_config
SET additional_config = COALESCE(additional_config, '{}'::jsonb) || jsonb_build_object(
  'safetyPanels', jsonb_build_object(
    'heading', 'Illinois 8 Ill. Adm. Code 1300.700',
    'panels', jsonb_build_array(
      jsonb_build_object('key','microbialsPass','label','Microbials','citation','1300.700(a)(1)','appliesTo','all'),
      jsonb_build_object('key','mycotoxinsPass','label','Mycotoxins','citation','1300.700(a)(2)','appliesTo','all'),
      jsonb_build_object('key','pesticidesPass','label','Pesticides','citation','1300.700(a)(3)','appliesTo','all'),
      jsonb_build_object('key','residualSolventsPass','label','Residual Solvents','citation','1300.700(a)(4)','appliesTo','concentrate'),
      jsonb_build_object('key','heavyMetalsPass','label','Heavy Metals','citation','1300.700(a)(5)','appliesTo','all')
    )
  )
)
WHERE state = 'IL'
  AND (additional_config IS NULL OR NOT (additional_config ? 'safetyPanels'));

-- NEW YORK safety panels — 9 NYCRR 130.22, with the product-form conditions
-- from OCM's laboratory testing guidance. Terpenes and the cannabinoid profile
-- are analyte readings rather than pass/fail panels, so they are not listed.
-- ⚠️ TWO panels apply to more than one product form, which is why appliesTo
-- accepts an array: residual solvents on concentrates AND edibles, water
-- activity on flower AND solid edibles. Moisture is flower only.
UPDATE regulatory_config
SET additional_config = COALESCE(additional_config, '{}'::jsonb) || jsonb_build_object(
  'safetyPanels', jsonb_build_object(
    'heading', 'New York 9 NYCRR 130.22',
    'panels', jsonb_build_array(
      jsonb_build_object('key','microbialsPass','label','Microbials','citation','9 NYCRR 130.22','appliesTo','all'),
      jsonb_build_object('key','mycotoxinsPass','label','Mycotoxins','citation','9 NYCRR 130.22','appliesTo','all'),
      jsonb_build_object('key','pesticidesPass','label','Pesticides','citation','9 NYCRR 130.22','appliesTo','all'),
      jsonb_build_object('key','heavyMetalsPass','label','Metals','citation','9 NYCRR 130.22','appliesTo','all'),
      jsonb_build_object('key','residualSolventsPass','label','Residual Solvents','citation','9 NYCRR 130.22','appliesTo',jsonb_build_array('concentrate','edible')),
      jsonb_build_object('key','waterActivityPass','label','Water Activity','citation','9 NYCRR 130.22','appliesTo',jsonb_build_array('flower','edible')),
      jsonb_build_object('key','moisturePass','label','Moisture Content','citation','9 NYCRR 130.22','appliesTo','flower')
    )
  )
)
WHERE state = 'NY'
  AND (additional_config IS NULL OR NOT (additional_config ? 'safetyPanels'));

-- Session 67 — production qualification threshold. The supervised-batch
-- requirement is owned by code (no DB-client edit needed). Force the column
-- default to the production value (5). The Session 66 boot-time UPDATE that
-- clamped existing In-Training rows DOWN to the validation value (2) has been
-- removed: rewriting an operator's required count on every boot is not
-- production-safe, and raising the bar (vs. the old clamp lowering it) never
-- strands anyone mid-qualification. Existing In-Training rows keep whatever
-- value they were created with; new qualifications get 5 (schema default +
-- explicit insert in routes/batches.ts).
ALTER TABLE operator_qualifications ALTER COLUMN required_supervised_batches SET DEFAULT 5;

-- Session 67 (Item 5) — persist the Part 11 meaning of signature on the batch
-- labeling approval (was previously mis-stored into the name field). Additive.
ALTER TABLE batch_labeling ADD COLUMN IF NOT EXISTS approval_meaning TEXT;

-- Session 73 — METRC Tag History (tag lineage). A batch carries a TREE of the
-- METRC tags it accrues as product changes form and is repackaged: the root is
-- the process-start tag (= the Batch Number, frozen), every node references its
-- Source/parent tag, and a node is either a single new tag or a first–last
-- RANGE of sequential child tags (a single split can record several
-- non-contiguous ranges as sibling rows). Append-only + universal Cancel
-- pattern (never hard-delete — Part 11). Additive + idempotent.
CREATE TABLE IF NOT EXISTS batch_metrc_tags (
  id                    SERIAL PRIMARY KEY,
  batch_id              INTEGER NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
  source_tag            TEXT,
  stage_label           TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'single',
  metrc_tag             TEXT,
  range_start           TEXT,
  range_end             TEXT,
  range_count           INTEGER,
  quantity              NUMERIC,
  uom                   TEXT,
  recorded_by_user_id   INTEGER REFERENCES users(id),
  recorded_by_name      TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at          TIMESTAMPTZ,
  cancelled_reason      TEXT,
  cancelled_by_user_id  INTEGER REFERENCES users(id),
  cancelled_by_name     TEXT,
  cancelled_by_initials TEXT,
  cancelled_meaning     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_metrc_tags_batch  ON batch_metrc_tags(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_metrc_tags_source ON batch_metrc_tags(source_tag);

-- Session 74 — METRC Tag Lineage Phase 2 (complaint traceability). A complaint
-- links to zero/one/several CANDIDATE batches (tag torn or tossed; two lots of
-- the same strain); the investigation resolves them to confirmed/ruled_out. A
-- confirmed row also sets complaints.batch_id. A complaint may still close with
-- no confirmed batch. Kept (never hard-deleted) so the trail survives — Part 11.
-- Additive + idempotent.
CREATE TABLE IF NOT EXISTS complaint_candidate_batches (
  id                   SERIAL PRIMARY KEY,
  complaint_id         INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  batch_id             INTEGER NOT NULL REFERENCES batch_records(id),
  status               TEXT NOT NULL DEFAULT 'suspected',
  match_basis          TEXT NOT NULL DEFAULT 'manual',
  entered_value        TEXT,
  note                 TEXT,
  recorded_by_user_id  INTEGER REFERENCES users(id),
  recorded_by_name     TEXT,
  resolved_by_user_id  INTEGER REFERENCES users(id),
  resolved_by_name     TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaint_candidates_complaint ON complaint_candidate_batches(complaint_id);
CREATE INDEX IF NOT EXISTS idx_complaint_candidates_batch     ON complaint_candidate_batches(batch_id);

-- Session 75 — connect the quality events. A complaint links to the internal
-- NC opened to investigate it (many complaints → one NC). Soft link (bare
-- integer, validated at the app layer), consistent with the other cross-event
-- references (field_actions.source_nc_id, complaints.field_action_id). Additive.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS nc_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_complaints_nc ON complaints(nc_id);
-- Session 101 — CRA is the primary reporting authority for a MI marihuana
-- product adverse reaction (notify CRA + log in METRC within 1 business day,
-- R 420.214b). cra_reportable drives the notification banner; reportability_triage
-- stores the yes/no triage answers for the audit trail.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS cra_reportable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS reportability_triage JSONB;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS capa_id INTEGER;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS root_causes TEXT[];
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS no_action_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS no_action_rationale TEXT;

-- Session 101 (#3) — complaint containment corrections log.
CREATE TABLE IF NOT EXISTS complaint_corrections (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  performed_on DATE,
  performed_by_user_id INTEGER,
  performed_by_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session 76 — Field Action request → approval workflow. An Operator may not
-- open a Field Action directly; they submit a REQUEST (status "Requested") that
-- a Quality/Manager (approver role) approves before the FA — and its mandatory
-- CAPA — is opened. All additive; existing FAs keep status "Initiated" and
-- leave these columns null. Soft-attributed (user id + name), matching the
-- close/quarantine attribution already on this table.
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS requested_by_id   INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS requested_by_name TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS requested_at      TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS reviewed_by_id    INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS reviewed_by_name  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;
CREATE INDEX IF NOT EXISTS idx_field_actions_status ON field_actions(status);

-- Session 63.4 — Field Action gate reviews (0/1/2). Gate 3 is the existing
-- closure signature and needs no columns. Additive + nullable.
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate0_approver_id       INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate0_approver_name     TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate0_approver_initials TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate0_approver_meaning  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate0_approved_at       TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate1_approver_id       INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate1_approver_name     TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate1_approver_initials TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate1_approver_meaning  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate1_approved_at       TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate2_approver_id       INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate2_approver_name     TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate2_approver_initials TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate2_approver_meaning  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS gate2_approved_at       TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS last_rejection_at       TIMESTAMPTZ;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS last_rejection_stage    TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS last_rejection_by_id    INTEGER;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS last_rejection_by_name  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS last_rejection_comment  TEXT;
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS closed_by_meaning       TEXT;

-- Session 63.5 — per-store "all items accounted for". Closing a field action is
-- blocked while any response action still has this false.
ALTER TABLE fa_response_actions ADD COLUMN IF NOT EXISTS all_items_accounted BOOLEAN NOT NULL DEFAULT false;

-- Step 1 (inventory/lots unification) — the lots table becomes the single
-- shared on-hand ledger for ALL materials. is_cannabis marks the rows that get
-- METRC tags and appear on the cannabis-only Lot Traceability view. Default
-- true so every pre-existing (all-cannabis) lot stays visible there; receiving
-- sets it explicitly from the supplier type. Additive.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS is_cannabis BOOLEAN NOT NULL DEFAULT true;
-- 2026-08 — a vendor/mfg lot number is an OPTIONAL, NON-unique attribute:
-- packaging has none, and the same mfg lot can be received on different dates.
-- The lot's real key is its id. Drop NOT NULL + UNIQUE, and null out the old
-- synthetic "RCV-<n>" placeholders that only existed to satisfy the old rule.
ALTER TABLE lots ALTER COLUMN lot_number DROP NOT NULL;
ALTER TABLE lots DROP CONSTRAINT IF EXISTS lots_lot_number_unique;
ALTER TABLE lots DROP CONSTRAINT IF EXISTS lots_lot_number_key;
DROP INDEX IF EXISTS lots_lot_number_unique;
DROP INDEX IF EXISTS lots_lot_number_key;
UPDATE lots SET lot_number = NULL WHERE lot_number ~ '^RCV-[0-9]+$';
CREATE INDEX IF NOT EXISTS idx_lots_inventory_item ON lots(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_lots_is_cannabis ON lots(is_cannabis);

-- Material Type on received items — chosen at receiving, drives the lot's
-- is_cannabis (any "Cannabis – …" value) and its item type. Additive.
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS material_type TEXT;

-- Follow-up #2 (post-Session 79) — intermediates-as-ingredient. A produced lot
-- (cannabutter, distillate, etc.) is finished-goods by default and excluded
-- from the raw-material Inventory rollup (listInventoryView filters out
-- origin = 'produced'). Once it passes test it can be RELEASED for downstream
-- use as an ingredient via a Part 11-signed disposition, which flips this flag
-- true so the lot appears on Inventory + the ingredient lot-picker like a raw
-- material. Default false so existing produced lots are unaffected. Additive.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS available_as_ingredient BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_lots_available_as_ingredient ON lots(available_as_ingredient);

-- Follow-up (06-24) — batch distribution channel ("Retail" vs "Bulk"), which
-- selects the labeling control set: retail-ready consumer label vs a bulk /
-- wholesale transfer (manifest) label. Default 'Retail' so existing batches keep
-- their product-type consumer checklist. Additive.
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'Retail';

-- BR-1/BR-3 (Expiration tracking, 2026-07-13) — expiry carried on the shared lot
-- ledger, the receiving line, and the batch ingredient/material line. The lots
-- and incoming_inspection_items columns already exist in the drizzle schema but
-- were only applied via a manual drizzle-kit push; adding them here (idempotent)
-- guarantees the live DB has them without anyone running push. batch_ingredients
-- .expiration_date is new. All additive + idempotent.
ALTER TABLE lots                     ADD COLUMN IF NOT EXISTS expiration_date DATE;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE batch_ingredients        ADD COLUMN IF NOT EXISTS expiration_date DATE;

-- Potency on the lot ledger (2026-09-06) — Michigan requires transferred cannabis
-- to be tested, so a received cannabis lot arrives with a COA. Receiving captures
-- THC/CBD off that COA (typed, or pulled from the Metrc lab results attached to
-- the incoming package); a produced lot derives them from its own batch test.
-- potency_source records WHICH of those three it was, so the Inventory screen can
-- show a hand-entered number differently from a state-system one. NULL = unknown,
-- never zero. Mirrored on the receiving line so the values are captured before the
-- inspection passes and the lot is created. All additive + idempotent.
ALTER TABLE lots                      ADD COLUMN IF NOT EXISTS thc_pct REAL;
ALTER TABLE lots                      ADD COLUMN IF NOT EXISTS cbd_pct REAL;
ALTER TABLE lots                      ADD COLUMN IF NOT EXISTS potency_source TEXT;
ALTER TABLE lots                      ADD COLUMN IF NOT EXISTS potency_tested_at DATE;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS thc_pct REAL;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS cbd_pct REAL;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS potency_source TEXT;
ALTER TABLE incoming_inspection_items ADD COLUMN IF NOT EXISTS potency_tested_at DATE;

-- Label product-type vocabulary (2026-09-06) — Label Studio kept its own six-item
-- product list while the rest of the app used the canonical ten. The one that
-- mattered was "Vape" vs "Vape Cartridge": /label-studio/products matches
-- product_type EXACTLY, so a vape label could never find a vape cartridge recipe,
-- could never name a product, and therefore could never be approved. The UI now
-- imports the shared list, which leaves existing rows saved under the old spelling
-- pointing at a type that no longer appears in the picker. Remap them.
--
-- ONLY "Vape" moves: the other five old values (Flower, Pre-Roll, Edible,
-- Concentrate, Topical) are spelled identically in the canonical list. Guarded so
-- re-running is a no-op, and so it cannot clobber a row already saying
-- "Vape Cartridge".
UPDATE label_templates     SET product_type = 'Vape Cartridge' WHERE product_type = 'Vape';
UPDATE label_static_blocks SET product_type = 'Vape Cartridge' WHERE product_type = 'Vape';

-- SRS-1 Part 2 (2026-07-13) — supplier risk-tier change review workflow.
-- Effective (officially-reviewed) auto-computed tier on the supplier, plus a
-- signed change log. Increases apply immediately + need acknowledgement;
-- decreases are held until approved. All additive + idempotent.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reviewed_risk_tier TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reviewed_risk_tier_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reviewed_risk_score INTEGER;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reviewed_risk_factors TEXT[];

-- Separation of duties (2026-08-06) — who created the supplier, so the creator
-- can't approve their own record. Additive + idempotent; legacy rows stay NULL.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by_id INTEGER;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by_name TEXT;

-- Management Review (2026-08-06) — stored QMS-health snapshots. The live view
-- shows the latest; regenerated quarterly (lazily) or via the Update button.
CREATE TABLE IF NOT EXISTS management_review_snapshots (
  id                SERIAL PRIMARY KEY,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by_name TEXT,
  trigger           TEXT NOT NULL DEFAULT 'auto',
  period_start      TEXT,
  period_end        TEXT,
  data              JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_risk_changes (
  id                   SERIAL PRIMARY KEY,
  supplier_id          INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  direction            TEXT NOT NULL,
  from_tier            TEXT NOT NULL,
  to_tier              TEXT NOT NULL,
  from_score           INTEGER NOT NULL,
  to_score             INTEGER NOT NULL,
  rationale            TEXT NOT NULL,
  factors_added        TEXT[],
  factors_removed      TEXT[],
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT NOT NULL DEFAULT 'Pending',
  reviewed_by_user_id  INTEGER REFERENCES users(id),
  reviewed_by_name     TEXT,
  reviewed_by_initials TEXT,
  reviewed_meaning     TEXT,
  reviewed_at          TIMESTAMPTZ,
  superseded_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_risk_changes_supplier ON supplier_risk_changes(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_risk_changes_status   ON supplier_risk_changes(status);

-- JIT commit 2 (label-later) — packaged runs carry a label status so units can be
-- packaged now ("package a portion — label later", finalize=false) and LABELED
-- later at order time. Default 'labeled' keeps every existing run back-compatible;
-- a fulfillment (finalize=false) packaging run is recorded 'unlabeled', and the
-- order-time Label & Finalize step flips it + stamps the retail destination and
-- the Part 11 signer, then finalizes the batch to Finished Goods. All additive.
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS label_status       TEXT NOT NULL DEFAULT 'labeled';
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS dispensary_name    TEXT;
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS labeled_by_user_id INTEGER;
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS labeled_by_name    TEXT;
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS labeled_at         TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_batch_metrc_tags_label_status ON batch_metrc_tags(label_status);

-- METRC write-back sync (create-package). CannaQMS is the operator's single
-- surface; the package is created in METRC underneath. metrc_package_created_at
-- is stamped when this node's package is successfully created in METRC (drives
-- "In METRC ✓" and makes create idempotent — a synced node is never re-created);
-- metrc_sync_error holds the last plain-language failure so a failed push is
-- surfaced, never silently diverged. Both null on mirror-only/not-yet-synced. Additive.
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS metrc_package_created_at TIMESTAMPTZ;
ALTER TABLE batch_metrc_tags ADD COLUMN IF NOT EXISTS metrc_sync_error         TEXT;

-- Outbound manifest (Metrc outgoing transfer) — Phase 1: CannaQMS is the manifest
-- system of record (pre-flight + printable manifest); Metrc sync (as an outgoing
-- template) is Phase 2. Ships to any licensed recipient (retailer/processor/lab).
-- A saved recipient directory + transporter presets avoid re-typing licenses.
-- All additive + idempotent; inert until the manifest routes/UI land.
CREATE TABLE IF NOT EXISTS transfer_recipients (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  license_number       TEXT NOT NULL,
  license_type         TEXT NOT NULL DEFAULT 'Retailer',
  address1             TEXT,
  address_city         TEXT,
  address_state        TEXT,
  address_postal_code  TEXT,
  main_phone           TEXT,
  notes                TEXT,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_recipients_active ON transfer_recipients(active);

CREATE TABLE IF NOT EXISTS transporter_presets (
  id                                    SERIAL PRIMARY KEY,
  label                                 TEXT NOT NULL,
  transporter_facility_license_number   TEXT NOT NULL,
  driver_name                           TEXT,
  driver_occupational_license_number    TEXT,
  driver_license_number                 TEXT,
  phone_number_for_questions            TEXT,
  vehicle_make                          TEXT,
  vehicle_model                         TEXT,
  vehicle_license_plate_number          TEXT,
  active                                BOOLEAN NOT NULL DEFAULT true,
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transporter_presets_active ON transporter_presets(active);

CREATE TABLE IF NOT EXISTS batch_manifests (
  id                                    SERIAL PRIMARY KEY,
  batch_id                              INTEGER NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
  status                                TEXT NOT NULL DEFAULT 'draft',
  transfer_type_name                    TEXT,
  recipient_id                          INTEGER,
  recipient_license_number              TEXT,
  recipient_name                        TEXT,
  planned_route                         TEXT,
  estimated_departure_date_time         TIMESTAMPTZ,
  estimated_arrival_date_time           TIMESTAMPTZ,
  transporter_facility_license_number   TEXT,
  driver_name                           TEXT,
  driver_occupational_license_number    TEXT,
  driver_license_number                 TEXT,
  vehicle_make                          TEXT,
  vehicle_model                         TEXT,
  vehicle_license_plate_number          TEXT,
  phone_number_for_questions            TEXT,
  gross_weight                          NUMERIC,
  gross_unit_of_weight_name             TEXT,
  metrc_template_id                     INTEGER,
  metrc_manifest_number                 TEXT,
  pushed_at                             TIMESTAMPTZ,
  created_by_user_id                    INTEGER REFERENCES users(id),
  created_by_name                       TEXT,
  signed_by_user_id                     INTEGER REFERENCES users(id),
  signed_by_name                        TEXT,
  signed_initials                       TEXT,
  signed_meaning                        TEXT,
  signed_at                             TIMESTAMPTZ,
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_manifests_batch  ON batch_manifests(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_manifests_status ON batch_manifests(status);

CREATE TABLE IF NOT EXISTS batch_manifest_packages (
  id                         SERIAL PRIMARY KEY,
  manifest_id                INTEGER NOT NULL REFERENCES batch_manifests(id) ON DELETE CASCADE,
  package_label              TEXT NOT NULL,
  item_name                  TEXT,
  quantity                   NUMERIC,
  uom                        TEXT,
  gross_weight               NUMERIC,
  gross_unit_of_weight_name  TEXT,
  wholesale_price            NUMERIC,
  source_tag_run_id          INTEGER,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_manifest_packages_manifest ON batch_manifest_packages(manifest_id);

-- 2026-07-22 — Labeling: two-signer retail-packaging approval (Quality + Manager)
-- and label-template proof/format-lock/field-list columns. Additive + idempotent.
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS quality_approver_id INTEGER;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS quality_approver_name TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS quality_approver_initials TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS quality_approver_meaning TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS quality_approved_at TIMESTAMPTZ;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS manager_approver_id INTEGER;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS manager_approver_name TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS manager_approver_initials TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS manager_approver_meaning TEXT;
ALTER TABLE packaging_designs ADD COLUMN IF NOT EXISTS manager_approved_at TIMESTAMPTZ;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS format_spec JSONB;
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS field_list JSONB;
-- #3 per-run label-print second-person review
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS reviewed_by_id INTEGER;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS reviewer_initials TEXT;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS reviewer_meaning TEXT;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS row_count INTEGER;
ALTER TABLE batch_label_prints ADD COLUMN IF NOT EXISTS export_format TEXT;

-- Session 102 — per-product-type label attributes (Settings -> Product Setup).
-- Shelf-life drives the computed expiration; default net weight + serving info +
-- activation time flow into the label data export. Replaces the hardcoded
-- LABEL_SHELF_LIFE_DAYS map in routes/batches.ts. Seeded on first read by
-- routes/product_settings.ts.
CREATE TABLE IF NOT EXISTS product_type_settings (
  id                      SERIAL PRIMARY KEY,
  product_type            TEXT NOT NULL UNIQUE,
  shelf_life_days         INTEGER,
  default_net_weight      REAL,
  default_net_weight_unit TEXT,
  serving_size            TEXT,
  servings_per_package    INTEGER,
  activation_time         TEXT,
  updated_by_name         TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session 103 - per-recipe (= per-product) label attributes.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS net_weight REAL;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS net_weight_unit TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS serving_size TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS serving_strength_mg REAL;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS servings_per_package INTEGER;

-- Session 104 - per-run label net weight override on the batch.
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS label_net_weight REAL;
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS label_net_weight_unit TEXT;
-- 2026-08-10 — finished output aggregation recorded on the Packaging tab.
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS cases_produced INTEGER;
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS cartons_produced INTEGER;

-- Dual Chamber Vape Cartridge recipe config (CRA MI_IB_0114, eff. 2026-07-28).
-- Drives how many final-form test groups a batch needs: same oil = 1; two oils =
-- 2 (Chamber A + B); two oils + combined draw = 3 (adds combined Chamber C).
-- Additive + inert until the three-group testing tab lands.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS dual_chamber_two_oils BOOLEAN;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS dual_chamber_combined_draw BOOLEAN;

-- 2026-09-07 — RECIPE RELEASE CONTROL. A batch may only link a released recipe,
-- and a recipe is released when its linked work instruction is Effective (his
-- ruling: "the WI and recipe will release together"). That state is DERIVED from
-- the document, so nothing is mirrored onto recipes.
--
-- grandfathered_at is the ONE-TIME exception: recipes that already existed when
-- the rule landed predate the linked-WI requirement, and blocking them would have
-- made it impossible to open any batch. His call: "Yes, grandfather everything
-- in." The DO block stamps them ONLY on the deploy that first adds the column —
-- a recipe created afterwards must earn its release through a WI, so re-running
-- this must never grandfather anything new.
DO $grandfather$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recipes' AND column_name = 'grandfathered_at'
  ) THEN
    ALTER TABLE recipes ADD COLUMN grandfathered_at TIMESTAMPTZ;
    UPDATE recipes SET grandfathered_at = now();
  END IF;
END $grandfather$;

-- Facility-managed product SUBTYPES — operational sub-forms within a product
-- type (Concentrate: live resin / wax / rosin; Edible: gummy / chocolate). Purely
-- descriptive except size-style subtypes (e.g. a "1g Pre-Roll") which may carry an
-- optional default net weight + unit that pre-fills a recipe's net weight when
-- picked. Recipes reference a subtype BY NAME (recipes.subtype), so deleting a
-- subtype never orphans a recipe. Table is new, so the (product_type, name)
-- unique index is safe inside this block. All additive + idempotent.
CREATE TABLE IF NOT EXISTS product_subtypes (
  id                      SERIAL PRIMARY KEY,
  product_type            TEXT NOT NULL,
  name                    TEXT NOT NULL,
  default_net_weight      REAL,
  default_net_weight_unit TEXT,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_subtype_name ON product_subtypes(product_type, name);
CREATE INDEX IF NOT EXISTS idx_product_subtypes_type ON product_subtypes(product_type);

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS subtype TEXT;

-- Recipe version lineage (2026-08-12) — freeze v1 / spawn v2 change control.
-- lineage_id groups all versions of a product (= the id of the root version);
-- superseded_by_recipe_id points a frozen version at the version that replaced
-- it (NULL on the current head). Backfill existing single-version recipes so
-- each is its own lineage head. All additive + idempotent.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS lineage_id INTEGER;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS superseded_by_recipe_id INTEGER;
UPDATE recipes SET lineage_id = id WHERE lineage_id IS NULL;

-- Recipe <-> work-instruction change control (2026-08-25). content_revised_at is
-- bumped by any BOM/process-step mutation, so a linked WI can tell its procedure
-- moved even when the version number did not. recipe_update_flagged records the
-- author's "this revision needs a recipe update" answer at revision start.
-- Additive + idempotent; NULL/false on existing rows is the correct start state.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS content_revised_at TIMESTAMPTZ;

-- Superseded-revision retention (2026-08-25). document_revisions recorded that a
-- revision existed but never what it said; the sections are edited in place, so the
-- prior revision's text was overwritten by the next draft. content_snapshot freezes
-- the approved content onto the revision row. Additive + idempotent.
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS content_snapshot JSONB;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS content_snapshot_at TIMESTAMPTZ;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS content_snapshot_source TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS recipe_update_flagged BOOLEAN NOT NULL DEFAULT false;

-- Dual Chamber Vape Cartridge testing (CRA MI_IB_0114) — which chamber a test
-- sample covers (A / B / combined C). Null on all non-dual-chamber products.
-- Drives the per-chamber pass + two-passing-retests gating. Additive + idempotent.
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS chamber TEXT;

-- 2026-09-08 — one recipe line, several lots, and the short-draw authorisation.
-- A lot rarely holds exactly what the batch needs; sibling rows carry the extra
-- tags, and a Manager/Quality signature is required to run a line short.
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS parent_ingredient_id INTEGER;
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS short_draw_approved_by_name TEXT;
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS short_draw_approved_initials TEXT;
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS short_draw_reason TEXT;
ALTER TABLE batch_ingredients ADD COLUMN IF NOT EXISTS short_draw_at TIMESTAMPTZ;

-- Lab sample collection (R 420.304(2), 2026-09-08). Michigan requires the
-- business to record the sample the LAB collected, including the date AND TIME
-- collected and transferred, who watched, and a signed chain of custody. The
-- sampled batch is then quarantined until passing results land. Additive.
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS sample_collected_at TIMESTAMPTZ;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS sample_transferred_at TIMESTAMPTZ;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS source_package_tag TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS source_remaining_qty REAL;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS source_remaining_uom TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS lab_collector_name TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS observer_name TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_metrc_identified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_observed_throughout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_no_assist BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_retest_confirmed BOOLEAN;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_signed_by_name TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_signed_by_initials TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_signed_meaning TEXT;
ALTER TABLE batch_testing ADD COLUMN IF NOT EXISTS coc_signed_at TIMESTAMPTZ;

-- Destruction record compliance (R 420.211, 2026-07-28): structured reason,
-- render-unusable evidence (non-cannabis material + >=50% mixture confirmation),
-- and a 21 CFR Part 11 e-signature captured at creation. Additive + idempotent.
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS non_cannabis_material TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS mixture_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS signed_by_name TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS signed_by_initials TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS signed_meaning TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
-- Destruction gaps 4-6 (R 420.211 waste management): disposal route + hauler
-- manifest, source batch/lot provenance link, and video-surveillance attestation.
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS disposal_route TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS hauler_name TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS manifest_number TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS source_batch_id INTEGER;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS source_lot_number TEXT;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS surveillance_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS surveillance_camera_ref TEXT;

-- Session 52 (2026-08-07) — Open→Closed lifecycle + METRC adjustment reason.
-- Records open with packages, then Close & Sign captures the Part 11 signature
-- and locks. Backfill existing (already-signed) records to Closed.
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Open';
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS metrc_adjustment_reason TEXT;
UPDATE destruction_records SET status = 'Closed' WHERE signed_at IS NOT NULL AND status <> 'Closed';

-- Inventory Checks — periodic physical-count reconciliation against METRC.
CREATE TABLE IF NOT EXISTS inventory_checks (
  id SERIAL PRIMARY KEY,
  check_number TEXT NOT NULL UNIQUE,
  period_label TEXT,
  status TEXT NOT NULL DEFAULT 'In Progress',
  count_type TEXT NOT NULL DEFAULT 'Full',
  scheduled_date TIMESTAMPTZ,
  metrc_snapshot_at TIMESTAMPTZ,
  counted_by_name TEXT,
  completed_at TIMESTAMPTZ,
  signed_by_name TEXT,
  signed_by_initials TEXT,
  signed_meaning TEXT,
  signed_at TIMESTAMPTZ,
  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  cancelled_by_name TEXT,
  cancelled_by_initials TEXT,
  cancelled_meaning TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory_check_lines (
  id SERIAL PRIMARY KEY,
  check_id INTEGER NOT NULL REFERENCES inventory_checks(id) ON DELETE CASCADE,
  metrc_tag TEXT NOT NULL,
  item_name TEXT,
  category TEXT,
  uom TEXT,
  system_qty REAL,
  counted_qty REAL,
  variance REAL,
  counted BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory_check_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  cadence TEXT NOT NULL DEFAULT 'Quarterly',
  grace_days INTEGER NOT NULL DEFAULT 0,
  updated_by_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO inventory_check_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- #4 (2026-08-05) — affected finished-goods BATCHES on a field action. Record-
-- only (quarantine handled separately, e.g. via a CAPA). Drives the "suggest
-- stores from manifests" lookup (batch -> outbound manifests -> destination stores).
CREATE TABLE IF NOT EXISTS field_action_batches (
  id               SERIAL PRIMARY KEY,
  field_action_id  INTEGER NOT NULL REFERENCES field_actions(id) ON DELETE CASCADE,
  batch_id         INTEGER NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
  notes            TEXT,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS field_action_batches_unique ON field_action_batches(field_action_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_field_action_batches_fa ON field_action_batches(field_action_id);

-- 2026-08-05 — destruction record LINE ITEMS: one row per METRC package tag
-- destroyed under a destruction record (the header = "Record of Evidence" ref).
-- Michigan CRA requires the full tag of each package on the waste/destruction
-- log. amount/uom auto-fill from METRC/Finished Goods for packaged product;
-- per-line reason lets one session mix reasons.
CREATE TABLE IF NOT EXISTS destruction_record_lines (
  id                     SERIAL PRIMARY KEY,
  destruction_record_id  INTEGER NOT NULL REFERENCES destruction_records(id) ON DELETE CASCADE,
  metrc_tag              TEXT NOT NULL,
  item_name              TEXT,
  amount                 REAL,
  uom                    TEXT,
  reason                 TEXT,
  source_batch_id        INTEGER,
  note                   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_destruction_lines_record ON destruction_record_lines(destruction_record_id);
-- Session 52 Phase 2 (2026-08-07) — per-package METRC adjust/finish sync status.
ALTER TABLE destruction_record_lines ADD COLUMN IF NOT EXISTS metrc_synced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE destruction_record_lines ADD COLUMN IF NOT EXISTS metrc_sync_error TEXT;
ALTER TABLE destruction_record_lines ADD COLUMN IF NOT EXISTS metrc_synced_at TIMESTAMPTZ;

-- SQ-Certificates (2026-08) — record_type distinguishes a lightweight
-- "Certificate on file" record from a full "Audit" assessment. Nullable, so
-- legacy rows stay unclassified and the UI infers their kind from audit
-- signals (score / findings / Pass-Fail outcome). New records set it explicitly.
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS record_type TEXT;
-- Guarantee the Session 97 certificate columns exist on the live DB (originally
-- applied via a manual drizzle-kit push). Idempotent + additive.
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS issuer TEXT;
ALTER TABLE supplier_qualifications ADD COLUMN IF NOT EXISTS certificate_number TEXT;

-- NC closed_at backfill (2026-08-11) — legacy non-conformances marked
-- status='Closed' before POST /approve began stamping closed_at were left with a
-- NULL closed_at. That split (Closed by status, still counted "open" by closed_at)
-- is what made the removed QMS Health strip disagree with the live Quality tiles,
-- and it still skews the NC trend / "closed this week" charts, which key off
-- closed_at. Idempotent + additive: only fills a Closed row's missing timestamp,
-- using updated_at as the best available proxy for the close time. Going forward
-- POST /approve always sets closed_at and PATCH refuses status=Closed, so no new
-- orphans appear.
UPDATE non_conformances SET closed_at = updated_at WHERE status = 'Closed' AND closed_at IS NULL;

-- Document favorites (2026-08-13) - per-user "star" that pins a controlled
-- document to the top of that user's Document Control list. Idempotent + additive.
CREATE TABLE IF NOT EXISTS document_favorites (
  id             SERIAL PRIMARY KEY,
  clerk_user_id  TEXT NOT NULL,
  document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clerk_user_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_document_favorites_user ON document_favorites(clerk_user_id);

-- Session 60 — NC classification (Product vs Process) + what the NC affects.
--
-- Lives here rather than in a migration file run by hand: this pass exists so a
-- schema change ships with the deploy, and doing it any other way took the NC
-- module down on 2026-08-23 when the code went out ahead of the SQL.
--
-- nc_type_as_found / nc_type_confirmed hold "Product" or "Process". Two of them
-- because an NC often starts as a product problem and the investigation lands on
-- a process cause; keeping both is what makes that measurable. Legacy rows stay
-- NULL and report as unclassified — a backfilled guess would pollute the metric.
--
-- The affected_* columns name what is involved as real references rather than
-- typed text, so metrics and supplier scoring can read them. ON DELETE SET NULL,
-- never CASCADE: losing an item, lot or document must not delete a quality record.
ALTER TABLE non_conformances
  ADD COLUMN IF NOT EXISTS nc_type_as_found            TEXT,
  ADD COLUMN IF NOT EXISTS nc_type_confirmed           TEXT,
  ADD COLUMN IF NOT EXISTS affected_inventory_item_id  INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affected_lot_id             INTEGER REFERENCES lots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affected_document_id        INTEGER REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nc_affected_inventory_item ON non_conformances(affected_inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_nc_affected_lot ON non_conformances(affected_lot_id);
CREATE INDEX IF NOT EXISTS idx_nc_affected_document ON non_conformances(affected_document_id);
CREATE INDEX IF NOT EXISTS idx_nc_type_as_found ON non_conformances(nc_type_as_found);

-- Session 62 — complaint corrections become assignable tasks, mirroring
-- nc_corrections. They were a log of work already done, which is why the date
-- field was capped at today; in practice a containment action is assigned to
-- someone with a due date and completed later.
ALTER TABLE complaint_corrections
  ADD COLUMN IF NOT EXISTS due_date              DATE,
  ADD COLUMN IF NOT EXISTS task_owner_user_id    INTEGER,
  ADD COLUMN IF NOT EXISTS task_owner_name       TEXT,
  ADD COLUMN IF NOT EXISTS completed             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS completed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by_user_id  INTEGER,
  ADD COLUMN IF NOT EXISTS completed_by_name     TEXT;

-- Rows that pre-date the task model recorded work already performed, so they are
-- complete by definition. Guarded on performed_on so it only ever touches the old
-- log-style rows and cannot re-close a task someone opens later.
UPDATE complaint_corrections
   SET completed = TRUE
 WHERE completed = FALSE
   AND performed_on IS NOT NULL
   AND due_date IS NULL
   AND task_owner_user_id IS NULL
   AND task_owner_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_complaint_corrections_owner ON complaint_corrections(task_owner_user_id);

-- 2026-08-27 — ADMINISTRATIVE RECORD MOVEMENT.
-- The notice shown at the top of a document after an administrative move, and the
-- permanent record of the move itself on the revision row. These were applied by
-- hand on the day; recorded here so a fresh environment gets them and nobody has to
-- run SQL to bring one up.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_at        TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_reason    TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_by_name   TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_to_status TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rescinded_action    TEXT;

ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_action      TEXT;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_reason      TEXT;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_by_name     TEXT;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_by_initials TEXT;
ALTER TABLE document_revisions ADD COLUMN IF NOT EXISTS admin_meaning     TEXT;

-- 2026-08-27 — the facility time zone, replacing a hardcoded America/New_York.
-- Every date-only column in the system is a calendar day AT THE FACILITY, so this
-- is what decides which day an approval, an effective date or a packagedDate falls
-- on. Null means Eastern, which is what every existing record was written against.
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS time_zone TEXT;

-- 2026-08-27 — the DECLARED effective date: the day a revision goes into force,
-- agreed between reviewer and approver rather than derived from training finishing.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS planned_effective_date DATE;

-- 2026-08-27 — who ran the root cause investigation. Often not the CAPA owner, and
-- sometimes not an app user at all (a contract lab, a supplier engineer).
ALTER TABLE capas ADD COLUMN IF NOT EXISTS rca_investigator_name TEXT;

-- 2026-08-28 — the EC Owner segregation rule is overridable with a written reason,
-- because a small site can have nobody eligible under it.
ALTER TABLE capas ADD COLUMN IF NOT EXISTS ec_owner_segregation_override_reason TEXT;
ALTER TABLE capas ADD COLUMN IF NOT EXISTS ec_owner_segregation_override_by     TEXT;
ALTER TABLE capas ADD COLUMN IF NOT EXISTS ec_owner_segregation_override_at     TIMESTAMPTZ;

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 1. Facilities exist, and everything belongs
-- to one. A FACILITY IS A LICENCE: one company holding a cultivation licence, a
-- processing licence and three retail licences has five facilities, which is
-- exactly how METRC sees it.
--
-- Phase 1 is deliberately invisible to a single-site operator — one facility is
-- seeded from the company profile so today's data has a home, and no screen
-- changes except a Facility card in Settings. Phase 2 adds the query scoping.
CREATE TABLE IF NOT EXISTS facilities (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  license_number TEXT,
  license_type   TEXT,
  state          TEXT NOT NULL DEFAULT 'MI',
  address        TEXT,
  city           TEXT,
  zip            TEXT,
  phone          TEXT,
  contact_person TEXT,
  time_zone      TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed THE facility from the company profile, once. Guarded on the table being
-- empty, so it fires on the first boot after this deploys and never again — it
-- can neither duplicate the site nor overwrite an edited one. The time zone comes
-- across with it, so the calendar the app already dates records against carries on
-- unchanged; company_profile.time_zone is left in place and simply stops being read.
INSERT INTO facilities (name, license_number, state, address, city, zip, phone, contact_person, time_zone)
SELECT COALESCE(NULLIF(btrim(company_name), ''), 'Main Facility'),
       license_number,
       COALESCE(NULLIF(btrim(state), ''), 'MI'),
       address, city, zip, phone, contact_person, time_zone
FROM company_profile
WHERE NOT EXISTS (SELECT 1 FROM facilities)
ORDER BY id
LIMIT 1;

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 1, SLICE 2. Everything belongs to a facility.
--
-- facility_id goes on the ROOT records only — a batch, a lot, an inspection, an
-- NC, a manifest. Line tables (ingredients, process steps, check lines,
-- corrections, revisions) reach their facility through their parent. Repeating
-- the column on every child would be a second copy of the same fact, and two
-- copies of a fact drift: that is exactly how an item's type ended up saying one
-- thing on the catalog row and another on the lot.
--
-- Deliberately NULLABLE. Existing rows are backfilled to the one facility below,
-- but nothing in the app SETS it on insert yet and no query filters on it. That
-- is Phase 2, which is where the column becomes required — and Phase 2 lands
-- before a second facility exists, because a missed filter would show a Michigan
-- operator a Missouri batch.
ALTER TABLE batch_records ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE incoming_inspections ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE label_static_blocks ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE batch_manifests ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE destruction_records ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE inventory_checks ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE inventory_check_settings ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE operator_qualifications ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE non_conformances ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE capas ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE field_actions ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);

-- ⛔ DOCUMENTS ARE BOTH. NULL = corporate: an SOP is written once for the company
-- and goes to every site. A Work Instruction is how ONE plant does the job, so it
-- carries a facility. Only the WIs are backfilled; everything else stays corporate.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS facility_id INTEGER REFERENCES facilities(id);

-- WHO WORKS WHERE. A join table, not a column on users: one human can cover two
-- plants, and a second user account for the same person would split their Part 11
-- signature identity.
${MEMBERSHIP_SCHEMA_SQL}

-- BACKFILL. Every existing record predates facilities, so it belongs to the one
-- facility that was seeded from the company profile. Each statement only touches
-- rows that have no facility yet, so re-running it on the next boot is a no-op and
-- it can never move a record somebody has since assigned somewhere else.
DO $mf$
DECLARE
  v_facility INTEGER;
  v_table    TEXT;
BEGIN
  SELECT id INTO v_facility FROM facilities ORDER BY id LIMIT 1;
  IF v_facility IS NULL THEN
    RETURN; -- no facility yet (no company profile to seed from); nothing to backfill
  END IF;

  -- ⛔ TRIGGERS OFF WHILE BACKFILLING. Every table carries the zzz_cqms_audit
  -- trigger, which writes an audit row per changed row — so filling in a column on
  -- every batch, lot and training record in the system would bury the real audit
  -- trail under thousands of entries saying a facility was assigned on the day
  -- facilities were invented. That is noise in a Part 11 record, and this backfill
  -- is a migration, not somebody's edit. The whole block is one transaction, so a
  -- failure rolls the disable back with it.
  FOREACH v_table IN ARRAY ARRAY['batch_records', 'inventory_items', 'lots', 'incoming_inspections', 'label_templates', 'label_static_blocks', 'batch_manifests', 'shipments', 'destruction_records', 'inventory_checks', 'inventory_check_settings', 'training_records', 'operator_qualifications', 'non_conformances', 'capas', 'complaints', 'field_actions', 'licenses', 'documents']
  LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', v_table);
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY['batch_records', 'inventory_items', 'lots', 'incoming_inspections', 'label_templates', 'label_static_blocks', 'batch_manifests', 'shipments', 'destruction_records', 'inventory_checks', 'inventory_check_settings', 'training_records', 'operator_qualifications', 'non_conformances', 'capas', 'complaints', 'field_actions', 'licenses']
  LOOP
    EXECUTE format('UPDATE %I SET facility_id = $1 WHERE facility_id IS NULL', v_table)
    USING v_facility;
  END LOOP;

  -- Work Instructions only. Every other document stays corporate (NULL).
  UPDATE documents SET facility_id = v_facility
   WHERE facility_id IS NULL AND document_type = 'Work Instruction';

  FOREACH v_table IN ARRAY ARRAY['batch_records', 'inventory_items', 'lots', 'incoming_inspections', 'label_templates', 'label_static_blocks', 'batch_manifests', 'shipments', 'destruction_records', 'inventory_checks', 'inventory_check_settings', 'training_records', 'operator_qualifications', 'non_conformances', 'capas', 'complaints', 'field_actions', 'licenses', 'documents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', v_table);
  END LOOP;

  -- Membership is explicit. Re-granting everyone at every boot would restore
  -- revoked access and expose records to newly registered accounts.
END $mf$;

-- Scoped reads land in Phase 2; the indexes they need are cheap to have now.
CREATE INDEX IF NOT EXISTS idx_batch_records_facility ON batch_records(facility_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_facility ON inventory_items(facility_id);
CREATE INDEX IF NOT EXISTS idx_lots_facility ON lots(facility_id);
CREATE INDEX IF NOT EXISTS idx_incoming_inspections_facility ON incoming_inspections(facility_id);
CREATE INDEX IF NOT EXISTS idx_label_templates_facility ON label_templates(facility_id);
CREATE INDEX IF NOT EXISTS idx_label_static_blocks_facility ON label_static_blocks(facility_id);
CREATE INDEX IF NOT EXISTS idx_batch_manifests_facility ON batch_manifests(facility_id);
CREATE INDEX IF NOT EXISTS idx_shipments_facility ON shipments(facility_id);
CREATE INDEX IF NOT EXISTS idx_destruction_records_facility ON destruction_records(facility_id);
CREATE INDEX IF NOT EXISTS idx_inventory_checks_facility ON inventory_checks(facility_id);
CREATE INDEX IF NOT EXISTS idx_inventory_check_settings_facility ON inventory_check_settings(facility_id);
CREATE INDEX IF NOT EXISTS idx_training_records_facility ON training_records(facility_id);
CREATE INDEX IF NOT EXISTS idx_operator_qualifications_facility ON operator_qualifications(facility_id);
CREATE INDEX IF NOT EXISTS idx_non_conformances_facility ON non_conformances(facility_id);
CREATE INDEX IF NOT EXISTS idx_capas_facility ON capas(facility_id);
CREATE INDEX IF NOT EXISTS idx_complaints_facility ON complaints(facility_id);
CREATE INDEX IF NOT EXISTS idx_field_actions_facility ON field_actions(facility_id);
CREATE INDEX IF NOT EXISTS idx_licenses_facility ON licenses(facility_id);
CREATE INDEX IF NOT EXISTS idx_documents_facility ON documents(facility_id);
CREATE INDEX IF NOT EXISTS idx_user_facilities_facility ON user_facilities(facility_id);

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 1, SLICE 3. The METRC connection per facility.
--
-- A facility IS a licence and METRC issues credentials per licence, so the
-- connection belongs to the site, not to an environment variable shared by the
-- process. The host differs by state, which is why the client has to be built per
-- facility. Both halves null = fall back to the METRC_* env vars, exactly as before.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS metrc_base_url       TEXT;
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS metrc_license_number TEXT;

-- ⛔ THE KEYS LIVE APART FROM THE FACILITY ROW ON PURPOSE. The audit trigger
-- stores the whole row it fired on, so a key kept on the facilities row would be copied
-- into the audit log every time somebody saved the site's address. This table is
-- excluded from the triggers below; the route writes its own masked audit entry so
-- the CHANGE is still recorded without the VALUE.
CREATE TABLE IF NOT EXISTS facility_metrc_credentials (
  id              SERIAL PRIMARY KEY,
  facility_id     INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  vendor_key      TEXT,
  user_key        TEXT,
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS facility_metrc_credentials_facility_key ON facility_metrc_credentials(facility_id);
-- Belt and braces: if an earlier boot ever put an audit trigger on this table, take it off.
DROP TRIGGER IF EXISTS zzz_cqms_audit ON facility_metrc_credentials;

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 2, STEP 1. New records stamp themselves.
--
-- Every API request tells Postgres which facility it is acting for, as a session
-- setting (see middlewares/facilityContext.ts). These DEFAULTs read it back, so a
-- record created by that request belongs to that facility WITHOUT a single route
-- being edited — which is the point. A rule that has to be remembered in ninety
-- insert statements is a rule that gets forgotten in one of them, and the one it
-- is forgotten in shows a Michigan operator a Missouri batch.
--
-- current_setting(..., true) returns NULL rather than raising when the setting is
-- absent, so anything running outside a request — a boot-time seed, the digest
-- scheduler — still inserts exactly as it did before, with no facility.
--
-- Step 2 adds the row-level security policies that make reads obey the same
-- setting. Step 3 makes the column NOT NULL, once this has proven itself.
ALTER TABLE batch_records ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE inventory_items ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE lots ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE incoming_inspections ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE label_templates ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE label_static_blocks ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE batch_manifests ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE shipments ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE destruction_records ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE inventory_checks ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE inventory_check_settings ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE training_records ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE operator_qualifications ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE non_conformances ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE capas ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE complaints ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE field_actions ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;
ALTER TABLE licenses ALTER COLUMN facility_id SET DEFAULT NULLIF(current_setting('app.facility_id', true), '')::integer;

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 2, STEP 2. THE DATABASE REFUSES.
--
-- From here it is Postgres, not the application, that decides which rows a query
-- may see. Every request has already announced the facility it is acting for
-- (step 1); these policies read that setting back and filter on it underneath
-- every SELECT, UPDATE and DELETE the app makes. A query that forgets to filter
-- by facility no longer returns another site's rows — it returns nothing.
--
-- His decision, 2026-08-28, taking the bigger job over a filter helper: a missed
-- filter showing a Michigan operator a Missouri batch is a compliance incident,
-- not a cosmetic bug, and a helper only protects the queries that remember to use it.
--
-- Three cases the policy allows, deliberately:
--   * NO FACILITY DECLARED — work running outside a request: the boot seeds, the
--     digest scheduler, this schema pass. They are not acting for anyone at a site
--     and must keep working exactly as before.
--   * facility_id IS NULL — a corporate document, or a row created outside a
--     request. Visible everywhere rather than invisible everywhere; a record that
--     silently vanishes is worse than one that is over-shared. Step 3 removes this
--     case for the site-owned tables by making the column compulsory.
--   * A MATCH on the declared facility. The ordinary case.
--
-- ⛔ FORCE is not optional. Postgres exempts a table's OWNER from its own policies
-- unless the table is FORCEd, and the application connects as the owner — without
-- this line every policy below would be decoration. A SUPERUSER is exempt even
-- from FORCE, which no line of SQL can fix; that is why the app now reports at
-- /api/scoping-status whether the refusal is genuinely in force.

ALTER TABLE batch_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON batch_records;
CREATE POLICY facility_scope ON batch_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON inventory_items;
CREATE POLICY facility_scope ON inventory_items
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON lots;
CREATE POLICY facility_scope ON lots
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE incoming_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE incoming_inspections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON incoming_inspections;
CREATE POLICY facility_scope ON incoming_inspections
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE label_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON label_templates;
CREATE POLICY facility_scope ON label_templates
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE label_static_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_static_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON label_static_blocks;
CREATE POLICY facility_scope ON label_static_blocks
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE batch_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON batch_manifests;
CREATE POLICY facility_scope ON batch_manifests
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON shipments;
CREATE POLICY facility_scope ON shipments
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE destruction_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE destruction_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON destruction_records;
CREATE POLICY facility_scope ON destruction_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE inventory_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON inventory_checks;
CREATE POLICY facility_scope ON inventory_checks
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE inventory_check_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_check_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON inventory_check_settings;
CREATE POLICY facility_scope ON inventory_check_settings
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE training_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON training_records;
CREATE POLICY facility_scope ON training_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE operator_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_qualifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON operator_qualifications;
CREATE POLICY facility_scope ON operator_qualifications
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE non_conformances ENABLE ROW LEVEL SECURITY;
ALTER TABLE non_conformances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON non_conformances;
CREATE POLICY facility_scope ON non_conformances
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE capas ENABLE ROW LEVEL SECURITY;
ALTER TABLE capas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON capas;
CREATE POLICY facility_scope ON capas
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON complaints;
CREATE POLICY facility_scope ON complaints
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE field_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON field_actions;
CREATE POLICY facility_scope ON field_actions
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON licenses;
CREATE POLICY facility_scope ON licenses
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON documents;
CREATE POLICY facility_scope ON documents
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

-- ===========================================================================
-- 2026-08-28 — THE RESTRICTED IDENTITY. This is what makes the rules above bite.
--
-- Railway connects this app as the database's master account, and Postgres lets
-- that account walk past its own row-level rules. Proven rather than assumed:
-- /api/scoping-status claimed to be a facility that does not exist and the database
-- still handed back all 107 lots. Every policy above was decoration.
--
-- So each request switches into this identity for its duration (see
-- middlewares/facilityContext.ts) and the rules apply to it like anyone else. It
-- has NOLOGIN and no password, so it is not a credential to look after and nothing
-- outside this process can connect as it. Ownership of the tables stays where it is.
--
-- Re-granted on EVERY boot on purpose: a table added by a future feature is covered
-- the next time the app deploys, rather than turning into a "permission denied" on
-- one screen months from now.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cannaqms_scoped') THEN
    CREATE ROLE cannaqms_scoped NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- The connecting account has to be allowed to become it. A superuser already is;
  -- this keeps working if the app is ever pointed at an ordinary account instead.
  EXECUTE format('GRANT cannaqms_scoped TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  -- Not permitted to manage roles on this database. Say so loudly rather than
  -- half-applying: the app still runs, unscoped, and /api/scoping-status reports it.
  RAISE WARNING 'Could not create or grant the cannaqms_scoped role: %', SQLERRM;
END $role$;

GRANT USAGE ON SCHEMA public TO cannaqms_scoped;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cannaqms_scoped;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cannaqms_scoped;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cannaqms_scoped;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cannaqms_scoped;

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 2, STEP 3. A record must belong somewhere.
--
-- Steps 1 and 2 made records stamp themselves and made the database refuse to hand
-- back another site's rows. One gap is left: a record with NO facility is visible
-- to every facility, because a row that belongs nowhere cannot be filtered out
-- without making it disappear entirely. That is the right answer for a CORPORATE
-- DOCUMENT and the wrong answer for a batch. This closes it for everything that is
-- not a document.
--
-- Two things have to be true before a column can be made compulsory: everything
-- already in it has a facility, and everything created from now on gets one —
-- including the work that runs OUTSIDE a request, which until now inserted with no
-- facility at all. The boot seeds do exactly that, so making the column compulsory
-- without fixing them first would stop the app starting.
--
-- So the default is no longer only the request's facility: with no request in play
-- it falls back to the operator's first facility. A seed, a scheduled job or a
-- console script therefore writes into the site rather than into nothing.
--
-- REVISIT WHEN A SECOND FACILITY EXISTS: "the first facility" is exactly right
-- while there is one and a guess once there are two — by then background work has
-- to say which site it is acting for. It is a function rather than a plain
-- expression because a column default cannot contain a query.
CREATE OR REPLACE FUNCTION app_facility_default() RETURNS integer
LANGUAGE sql STABLE AS $fac$
  SELECT COALESCE(
    NULLIF(current_setting('app.facility_id', true), '')::integer,
    (SELECT id FROM facilities ORDER BY id LIMIT 1)
  );
$fac$;

ALTER TABLE batch_records ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE inventory_items ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE lots ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE incoming_inspections ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE label_templates ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE label_static_blocks ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE batch_manifests ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE shipments ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE destruction_records ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE inventory_checks ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE inventory_check_settings ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE training_records ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE operator_qualifications ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE non_conformances ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE capas ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE complaints ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE field_actions ALTER COLUMN facility_id SET DEFAULT app_facility_default();
ALTER TABLE licenses ALTER COLUMN facility_id SET DEFAULT app_facility_default();

-- Make it compulsory, but never at the cost of the app starting. Each column is
-- only locked down once nothing in it is empty; if something is, the app boots
-- anyway with a warning in the logs rather than failing its whole schema pass. A
-- stricter column is not worth a plant that cannot open its quality system.
DO $notnull$
DECLARE
  v_table    TEXT;
  v_facility INTEGER;
  v_empty    BIGINT;
BEGIN
  SELECT id INTO v_facility FROM facilities ORDER BY id LIMIT 1;
  IF v_facility IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY['batch_records', 'inventory_items', 'lots', 'incoming_inspections', 'label_templates', 'label_static_blocks', 'batch_manifests', 'shipments', 'destruction_records', 'inventory_checks', 'inventory_check_settings', 'training_records', 'operator_qualifications', 'non_conformances', 'capas', 'complaints', 'field_actions', 'licenses']
  LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', v_table);
    EXECUTE format('UPDATE %I SET facility_id = $1 WHERE facility_id IS NULL', v_table) USING v_facility;
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', v_table);

    EXECUTE format('SELECT count(*) FROM %I WHERE facility_id IS NULL', v_table) INTO v_empty;
    IF v_empty = 0 THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN facility_id SET NOT NULL', v_table);
    ELSE
      RAISE WARNING 'Leaving %.facility_id nullable: % rows still have no facility', v_table, v_empty;
    END IF;
  END LOOP;
END $notnull$;


-- With the column compulsory, the "belongs nowhere, so visible everywhere" case is
-- gone from these tables and the policy no longer needs to allow it. Documents keep
-- it, because that is exactly how a corporate SOP reaches every site.
DROP POLICY IF EXISTS facility_scope ON batch_records;
CREATE POLICY facility_scope ON batch_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON inventory_items;
CREATE POLICY facility_scope ON inventory_items
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON lots;
CREATE POLICY facility_scope ON lots
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON incoming_inspections;
CREATE POLICY facility_scope ON incoming_inspections
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON label_templates;
CREATE POLICY facility_scope ON label_templates
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON label_static_blocks;
CREATE POLICY facility_scope ON label_static_blocks
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON batch_manifests;
CREATE POLICY facility_scope ON batch_manifests
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON shipments;
CREATE POLICY facility_scope ON shipments
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON destruction_records;
CREATE POLICY facility_scope ON destruction_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON inventory_checks;
CREATE POLICY facility_scope ON inventory_checks
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON inventory_check_settings;
CREATE POLICY facility_scope ON inventory_check_settings
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON training_records;
CREATE POLICY facility_scope ON training_records
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON operator_qualifications;
CREATE POLICY facility_scope ON operator_qualifications
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON non_conformances;
CREATE POLICY facility_scope ON non_conformances
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON capas;
CREATE POLICY facility_scope ON capas
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON complaints;
CREATE POLICY facility_scope ON complaints
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON field_actions;
CREATE POLICY facility_scope ON field_actions
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

DROP POLICY IF EXISTS facility_scope ON licenses;
CREATE POLICY facility_scope ON licenses
  USING (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  )
  WITH CHECK (
    NULLIF(current_setting('app.facility_id', true), '') IS NULL
    OR facility_id = NULLIF(current_setting('app.facility_id', true), '')::integer
  );

-- ===========================================================================
-- 2026-08-28 — MULTI-FACILITY PHASE 3. Document change requests.
--
-- "This document is wrong, and here is why", raised by anyone at any site against a
-- document that is in force. The DOCUMENT IS NOT TOUCHED: no draft appears, its
-- status does not move, nobody is assigned anything. Quality approves or declines
-- with a reason, and only an approval makes the document revisable.
--
-- A DECLINE IS KEPT, deliberately. His words: "We cannot really get rid of records."
--
-- No row-level facility rule on this table, on purpose. It follows the pattern he set
-- for non-conformances and CAPAs: raised at a facility, visible company-wide. A plant
-- reporting that a corporate SOP is wrong is the case this exists for, and hiding
-- that from the other sites would defeat it. The facility is recorded, not enforced.
CREATE TABLE IF NOT EXISTS document_change_requests (
  id                    SERIAL PRIMARY KEY,
  document_id           INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  facility_id           INTEGER,
  revision_at_request   TEXT,
  what_is_wrong         TEXT NOT NULL,
  why_it_matters        TEXT,
  status                TEXT NOT NULL DEFAULT 'Open',
  raised_by_user_id     INTEGER,
  raised_by_name        TEXT,
  raised_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_user_id    INTEGER,
  decided_by_name       TEXT,
  decided_at            TIMESTAMPTZ,
  decision_reason       TEXT,
  resolved_at           TIMESTAMPTZ,
  resolved_by_revision  TEXT
);
CREATE INDEX IF NOT EXISTS idx_document_change_requests_document ON document_change_requests(document_id);
CREATE INDEX IF NOT EXISTS idx_document_change_requests_status ON document_change_requests(status);

-- Stamped with the facility that raised it, the same way every other new record is.
ALTER TABLE document_change_requests ALTER COLUMN facility_id SET DEFAULT app_facility_default();

-- One live request per document. A second person raising the same complaint should
-- see the one already open, not start a parallel queue Quality has to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS document_change_requests_one_open
  ON document_change_requests(document_id)
  WHERE status IN ('Open', 'Approved');

-- ===========================================================================
-- 2026-08-28 — CORRECTION. Quality events are RAISED at a plant and LISTED
-- COMPANY-WIDE. Undoing an over-application of the facility rule from earlier today.
--
-- His ruling 08-27, which I then broke: NCs, CAPAs, complaints and field actions are
-- "raised at a facility, listed corporate-wide". Locking them to one plant hides the
-- thing they exist to reveal — three sites hitting the same cartridge failure is a
-- pattern only visible if the person over all three can see all three. He caught it
-- on 08-28: "If I were director over all sites, I would want to see metrics from
-- everyone. That could help me identify global issues."
--
-- So these four tables keep their facility_id — every record still says where it came
-- from, and the screens show and filter on it — but the database no longer filters
-- them by facility. The distinction that matters:
--   * A BATCH belongs to one plant. Another plant has no business reading it.
--   * An NC is raised at one plant and is the COMPANY'S problem.
-- Their child tables never carried the rule, so nothing else has to change.
DROP POLICY IF EXISTS facility_scope ON non_conformances;
ALTER TABLE non_conformances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE non_conformances DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON capas;
ALTER TABLE capas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capas DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON complaints;
ALTER TABLE complaints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE complaints DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_scope ON field_actions;
ALTER TABLE field_actions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE field_actions DISABLE ROW LEVEL SECURITY;

-- 2026-08-28 — Phase 4: a short code per site ("AA", "BC"). It goes into the numbers
-- of records that belong to one plant, so NC-AA-26-0001 says where it came from
-- without a lookup. Company-wide records keep their plain number — there is only one
-- of each, so there is nothing to tell apart.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS facilities_code_key ON facilities(upper(btrim(code))) WHERE code IS NOT NULL;

-- Which site a person is currently acting for. Stored on the person, not in their
-- browser: it decides what they are allowed to see, and a value the browser could set
-- is a value the browser could lie about. Null = the first site they are listed at.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_facility_id INTEGER REFERENCES facilities(id);

-- ⛔ NOT documents. A document with no facility is CORPORATE, and an SOP created
-- at a plant is still written once for the company — defaulting it to the plant
-- that happened to type it would quietly turn the corporate library into local
-- copies. Work Instructions get their facility from the route that creates them.
`;

// Session 70 — case-insensitive unique email guard (defense-in-depth behind the
// app-layer lowercasing in routes/users.ts + currentUser.ts). Kept OUT of the
// main SCHEMA_SQL block and run in its own try/catch because, unlike the
// additive DDL above, this CREATE UNIQUE INDEX can FAIL if the live table
// already holds case-variant duplicate emails — and a throw inside the single
// pool.query(SCHEMA_SQL) would abort the whole pass. On failure we log a loud
// warning (telling the operator to dedup) and let boot continue; the app-layer
// normalization still prevents NEW duplicates regardless.
const EMAIL_UNIQUE_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));`;

// Session 76.1 — operator initials are the displayed e-signature identity on
// batch records, co-signs, and dispositions; by house rule (Jonathan, 06-22)
// two users may NEVER share initials, so a signed record is unambiguous about
// who acted (21 CFR Part 11 attribution). Defense-in-depth behind the app-layer
// initialsTaken() check in routes/users.ts + the uniqueInitials() auto-provision
// derivation in currentUser.ts. Normalized (upper+trim) so "js" and "JS " can't
// both exist. Same boot-safe pattern as the email index: a CREATE UNIQUE INDEX
// can fail if the live table already holds duplicate initials, so it runs in its
// own try/catch and warns rather than aborting boot.
const INITIALS_UNIQUE_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS users_initials_norm_unique ON users (upper(btrim(initials)));`;


// ─────────────────────────────────────────────────────────────────────────
// Session 111 — comprehensive audit trail via DB triggers (the "gate, not
// memory" fix). Every INSERT/UPDATE/DELETE on any id-bearing business table is
// captured in audit_log with full before/after row JSON — automatically — so no
// endpoint, present or future, can silently skip auditing. The actor is read
// from a transaction-local GUC (app.audit_user_id / app.audit_user_name) when a
// request sets it; NULL otherwise. Fail-open: an audit error never blocks the
// underlying business write. Re-runs every boot, so newly-added tables are
// covered on the next deploy without touching any route code.
const AUDIT_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION cqms_audit_trigger() RETURNS trigger AS $fn$
DECLARE
  v_row_id    integer;
  v_user_id   integer;
  v_user_name text;
  v_before    jsonb;
  v_after     jsonb;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_before := to_jsonb(OLD);
    v_after  := NULL;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    IF v_before IS NOT DISTINCT FROM v_after THEN
      RETURN NEW; -- no columns actually changed; skip the noise
    END IF;
  ELSE
    v_before := NULL;
    v_after  := to_jsonb(NEW);
  END IF;

  v_row_id := COALESCE((v_after->>'id')::integer, (v_before->>'id')::integer, 0);

  BEGIN
    v_user_id := NULLIF(current_setting('app.audit_user_id', true), '')::integer;
  EXCEPTION WHEN others THEN
    v_user_id := NULL;
  END;
  v_user_name := NULLIF(current_setting('app.audit_user_name', true), '');

  INSERT INTO audit_log (table_name, row_id, operation, changed_by, changed_by_name, before_state, after_state)
  VALUES (TG_TABLE_NAME, v_row_id, 'DB_' || TG_OP, v_user_id, v_user_name, v_before, v_after);

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN others THEN
  RETURN COALESCE(NEW, OLD); -- auditing must never break a business write
END;
$fn$ LANGUAGE plpgsql;

DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'id'
      AND c.data_type = 'integer'
      -- facility_metrc_credentials is excluded DELIBERATELY: the trigger stores the
      -- whole row, so auditing it would write METRC keys, in clear, into a table the
      -- app reads. Changes to it are audited by routes/facilities.ts with the keys
      -- masked — the event is the compliance record, the secret is not.
      AND c.table_name NOT IN ('audit_log', '__drizzle_migrations', 'drizzle_migrations', 'facility_metrc_credentials')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zzz_cqms_audit ON %I;', r.table_name);
    EXECUTE format('CREATE TRIGGER zzz_cqms_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cqms_audit_trigger();', r.table_name);
  END LOOP;
END $do$;
`;

export async function ensureSchema(): Promise<void> {
  const base = await pool.query("SELECT to_regclass('public.users') AS users_table");
  if (!base.rows[0]?.users_table) {
    throw new Error("Base database schema is missing. Run pnpm db:migrate before starting the application (Railway pre-deploy command).");
  }
  await pool.query(ONBOARDING_SCHEMA_SQL);
  await pool.query(SCHEMA_SQL);
  logger.info("ensureSchema: idempotent schema applied");

  // Comprehensive audit trail — install/refresh the DB-level triggers so every
  // write is captured automatically (see AUDIT_TRIGGER_SQL). Warn-not-abort so a
  // trigger issue can never block boot.
  try {
    await pool.query(AUDIT_TRIGGER_SQL);
    logger.info("ensureSchema: audit-trail triggers installed on all id-bearing tables");
  } catch (err) {
    logger.warn({ err }, "ensureSchema: could not install audit-trail triggers");
  }

  try {
    await pool.query(EMAIL_UNIQUE_INDEX_SQL);
    logger.info("ensureSchema: case-insensitive unique email index ensured");
  } catch (err) {
    logger.warn(
      { err },
      "ensureSchema: could not create unique index on lower(email) — the table likely holds case-variant duplicate emails. " +
        "New duplicates are already blocked at the app layer; resolve the existing duplicates, then redeploy to enforce the DB constraint.",
    );
  }

  try {
    await pool.query(INITIALS_UNIQUE_INDEX_SQL);
    logger.info("ensureSchema: unique operator-initials index ensured");
  } catch (err) {
    logger.warn(
      { err },
      "ensureSchema: could not create unique index on upper(btrim(initials)) — the table likely holds duplicate operator initials. " +
        "New duplicates are already blocked at the app layer; resolve the existing duplicate initials, then redeploy to enforce the DB constraint.",
    );
  }
}
