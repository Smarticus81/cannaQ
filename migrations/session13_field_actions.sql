-- Session 13 (Field Actions rework — items 18-21)
-- Idempotent. Safe to re-run.
-- Apply via Replit Database tab or hand to the Replit Agent.

ALTER TABLE field_actions
  ADD COLUMN IF NOT EXISTS product_type text,
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS source_nc_id integer,
  ADD COLUMN IF NOT EXISTS source_complaint_id integer,
  ADD COLUMN IF NOT EXISTS linked_capa_id integer;

CREATE TABLE IF NOT EXISTS fa_response_actions (
  id serial PRIMARY KEY,
  field_action_id integer NOT NULL REFERENCES field_actions(id) ON DELETE CASCADE,
  store_name text NOT NULL,
  store_license_number text,
  contact_name text,
  contact_phone text,
  contact_email text,
  notification_date date,
  method text,
  confirmation_reference text,
  units_affected integer,
  units_returned integer,
  product_returned boolean NOT NULL DEFAULT false,
  product_destroyed boolean NOT NULL DEFAULT false,
  notes text,
  created_by_user_id integer REFERENCES users(id),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
