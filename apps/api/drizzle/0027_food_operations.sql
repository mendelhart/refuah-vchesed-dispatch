-- 0027: food operations. Additive only: new tables; nothing existing is
-- touched (the hospital_food trip type keeps working exactly as before).
-- Used only when FOOD_OPS_ENABLED=true.
--
-- Personal data: who signed up for a preparation slot or a run (user ids),
-- and vendor contact details. Shopping-list sends keep counts and an
-- audience fingerprint, not the message text per person (that lives in the
-- existing notifications tables).
CREATE TABLE IF NOT EXISTS food_vendors (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "phone" text,
  "email" text,
  "notes" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_items (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "unit" text NOT NULL DEFAULT 'each',
  "vendor_id" uuid REFERENCES food_vendors(id) ON DELETE SET NULL,
  "on_hand" numeric(10,2) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  "par_level" numeric(10,2) CHECK (par_level IS NULL OR par_level >= 0),
  "notes" text,
  "active" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "food_items_name_active_uq" ON food_items (lower(name)) WHERE active;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_prep_slots (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "weekday" integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  "start_minute" integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  "end_minute" integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  "staff_needed" integer NOT NULL DEFAULT 1 CHECK (staff_needed BETWEEN 1 AND 50),
  "notes" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (start_minute < end_minute)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_prep_slot_items (
  "slot_id" uuid NOT NULL REFERENCES food_prep_slots(id) ON DELETE CASCADE,
  "item_id" uuid NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
  "quantity" numeric(10,2) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY ("slot_id", "item_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_prep_signups (
  "slot_id" uuid NOT NULL REFERENCES food_prep_slots(id) ON DELETE CASCADE,
  "on_date" date NOT NULL,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("slot_id", "on_date", "user_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_distribution_runs (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_date" date NOT NULL,
  "route" text NOT NULL,
  "recipients_count" integer NOT NULL DEFAULT 0 CHECK (recipients_count >= 0),
  "status" text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'cancelled')),
  "notes" text,
  "created_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_run_volunteers (
  "run_id" uuid NOT NULL REFERENCES food_distribution_runs(id) ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY ("run_id", "user_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_shopping_lists (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "created_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS food_shopping_list_items (
  "list_id" uuid NOT NULL REFERENCES food_shopping_lists(id) ON DELETE CASCADE,
  "position" integer NOT NULL,
  "name" text NOT NULL,
  "quantity" numeric(10,2) NOT NULL CHECK (quantity > 0),
  "unit" text NOT NULL DEFAULT 'each',
  PRIMARY KEY ("list_id", "position")
);--> statement-breakpoint
-- One row per (list, exact audience): the unique key is what makes a send
-- happen once, however many times the button is pressed.
CREATE TABLE IF NOT EXISTS food_shopping_list_sends (
  "list_id" uuid NOT NULL REFERENCES food_shopping_lists(id) ON DELETE CASCADE,
  "audience_hash" text NOT NULL,
  "recipients" integer NOT NULL,
  "sent_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("list_id", "audience_hash")
);
