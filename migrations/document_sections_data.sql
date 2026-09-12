-- Document sections gain a structured `data` payload (2026-07-29).
--
-- SOP/Policy/Manual documents get narrative sections (Definitions, Materials/
-- Equipment, Safety, Procedure, Associated Documents). Free-text sections use the
-- existing body_markdown; the two structured ones store their payload here:
--   associated_documents → { docs: [{ documentId, note? }] }  (links to other docs)
--   materials_equipment  → { items: [{ name, note? }] }        (tools/equipment list)
--
-- Nullable, no backfill. Existing Spec/WI sections keep data = NULL.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the standing Railway/Postgres
-- migration discipline — safe to re-run.
--
-- Ship order: run BEFORE deploying the new code so SELECTs find the column. In
-- Railway → Postgres → Run SQL, paste the ALTER below, or:
--   psql $DATABASE_URL -f migrations/document_sections_data.sql

ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS data jsonb;
