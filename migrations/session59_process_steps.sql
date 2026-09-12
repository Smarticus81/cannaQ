-- Session 59 / 59.1 (2026-06-05) -- FDA food GMP: approved process steps as
-- fill-in-the-blank procedure narratives + baker attribution (06-04 feedback).
--
-- Two tables:
--   recipe_process_steps  -- approved master steps on a Recipe. `template` is a
--                            procedure narrative with {blank} tokens, e.g.
--                            "...{baker} baked at {temp} {unit} for {time} min."
--   batch_process_steps   -- per-batch instances, copied from the recipe at
--                            batch creation. The baker fills the blanks
--                            (field_values) and e-signs (Part 11): who baked +
--                            initials + signing meaning + when + the rendered
--                            sentence (rendered_text) that prints on the record.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS) per the standing Railway/Postgres
-- migration discipline -- safe to re-run.
--
-- Ship instructions (from the Railway shell, AFTER pushing the code):
--   psql $DATABASE_URL -f migrations/session59_process_steps.sql
-- Or via the Railway Database tab -> Run SQL.

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

-- If these tables were already created by an earlier draft of this migration
-- (with target_temp/target_duration columns and no template), bring them up to
-- date. All idempotent.
ALTER TABLE recipe_process_steps ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS field_values JSONB;
ALTER TABLE batch_process_steps  ADD COLUMN IF NOT EXISTS rendered_text TEXT;
