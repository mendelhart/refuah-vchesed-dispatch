-- 0028: package deliveries and lift assist. Additive only: new tables;
-- nothing existing is touched. A package delivery is an ordinary trip of the
-- existing type 'equipment_delivery' with a row here describing the package,
-- so no existing constraint changes. Used only when PACKAGE_DELIVERY_ENABLED
-- / LIFT_ASSIST_ENABLED are true.
--
-- Personal data: recipient name and phone and who received the package
-- (trip_packages); which volunteers offered to help lift (lift_assist_helpers)
-- and who was invited or accepted (lift_assist_invites). They belong to the
-- trip or request they hang off and should be scrubbed with it.
CREATE TABLE IF NOT EXISTS trip_packages (
  "trip_id" uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  "description" text NOT NULL,
  "size" text NOT NULL CHECK (size IN ('small', 'medium', 'large')),
  "weight_kg" numeric(6,1) CHECK (weight_kg IS NULL OR weight_kg > 0),
  "recipient_name" text NOT NULL,
  "recipient_phone" text,
  "handling_notes" text,
  "delivered_at" timestamptz,
  "received_by" text,
  "delivery_note" text,
  "delivered_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lift_assist_helpers (
  "user_id" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lift_assist_requests (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "location" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "duration_minutes" integer NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  "needed" integer NOT NULL CHECK (needed BETWEEN 2 AND 10),
  "area" text,
  "notes" text,
  "status" text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  "lead_user_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lift_assist_invites (
  "request_id" uuid NOT NULL REFERENCES lift_assist_requests(id) ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'declined')),
  "invited_at" timestamptz NOT NULL DEFAULT now(),
  "responded_at" timestamptz,
  PRIMARY KEY ("request_id", "user_id")
);--> statement-breakpoint
-- One row per (request, exact audience): invitations go out once.
CREATE TABLE IF NOT EXISTS lift_assist_sends (
  "request_id" uuid NOT NULL REFERENCES lift_assist_requests(id) ON DELETE CASCADE,
  "audience_hash" text NOT NULL,
  "recipients" integer NOT NULL,
  "sent_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("request_id", "audience_hash")
);
