-- Session 49 — METRC destruction record tracking.
--
-- New destruction_records table + a destruction_record_id FK on
-- non_conformances. Many-to-one: one METRC destruction tag (one
-- destruction_records row) can cover many destroyed batches / NCs.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS destruction_records (
  id                  serial PRIMARY KEY,
  metrc_tag           text NOT NULL,
  destroyed_at        timestamptz NOT NULL,
  destroyed_by_name   text NOT NULL,
  witness_name        text,
  weight              real,
  weight_uom          text,
  method              text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE non_conformances
  ADD COLUMN IF NOT EXISTS destruction_record_id integer REFERENCES destruction_records(id);
