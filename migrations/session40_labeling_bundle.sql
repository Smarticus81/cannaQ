-- Session 40 (Tier 3 #12 Labeling bundle — 12b / 12d / 12e).
--
-- Three coupled additions land together:
--   1) `batch_label_prints` — new lookup table for the 12d print log. One
--      row per successful production-PDF render so "when was this batch
--      last printed and by whom" is queryable. Draft prints are NOT logged.
--   2) Three columns on `batch_ingredients` for 12e packaging-materials lot
--      capture: supplier_id (FK to suppliers), supplier_lot_number (the
--      supplier's own ref, distinct from the internal lot_number), and
--      received_at (when the material lot was physically received).
--   3) No schema change for 12b — the auto-populate endpoint seeds
--      checklist_items rows from a hardcoded LABEL_CHECKLIST_TEMPLATES
--      constant in the schema module (see lib/db/src/schema/batch_labeling.ts).
--      Promotion to a regulator-approvable templates table is a future
--      cleanup if/when a third consumer wants the same surface.
--
-- Per project convention drizzle-kit push is unreliable for CREATE TABLE +
-- ADD COLUMN combinations on Replit Postgres, so this SQL ships inline
-- alongside the schema change. Wrapped in a transaction so the migration
-- is all-or-nothing.

BEGIN;

-- 12d: production-print log.
CREATE TABLE IF NOT EXISTS batch_label_prints (
  id                       serial PRIMARY KEY,
  batch_id                 integer NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
  label_template_id        integer,
  label_template_name      text,
  label_template_version   integer,
  printed_by_id            integer REFERENCES users(id),
  printed_by_name          text,
  printed_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS batch_label_prints_batch_id_idx
  ON batch_label_prints (batch_id, printed_at DESC);

-- 12e: packaging-materials lot capture columns. All nullable for back-compat
-- with the existing Ingredient rows (which never carried these). The server
-- enforces presence at write time when kind="Material".
ALTER TABLE batch_ingredients
  ADD COLUMN IF NOT EXISTS supplier_id          integer REFERENCES suppliers(id),
  ADD COLUMN IF NOT EXISTS supplier_lot_number  text,
  ADD COLUMN IF NOT EXISTS received_at          timestamptz;

COMMIT;
