-- 0025: journeys (round trips and extra stops) and passengers. Additive only:
-- three new tables; no existing table, column or row is changed.
--
-- A journey ties several ordinary trips ("legs") together. Each leg is a
-- normal row in trips, so offers, reminders, reassignment and cancellation
-- keep working per leg. Used only when MULTI_LEG_TRIPS_ENABLED=true.
--
-- Personal data: trip_passengers.name and notes, and the addresses inside
-- trip_journeys.pending_return. They belong to the trips they hang off and
-- should be scrubbed with them (the retention engine, which is off, does not
-- yet know these tables: see docs/GAP_BUILD_PROGRESS.md).
CREATE TABLE IF NOT EXISTS trip_journeys (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL CHECK (kind IN ('one_way', 'round_trip', 'multi_stop')),
  "return_mode" text NOT NULL DEFAULT 'none' CHECK (return_mode IN ('none', 'scheduled', 'call_when_ready')),
  "pending_return" jsonb,
  "return_expected_at" timestamptz,
  "return_called_at" timestamptz,
  "created_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trip_journey_legs (
  "journey_id" uuid NOT NULL REFERENCES trip_journeys(id) ON DELETE CASCADE,
  "leg_index" integer NOT NULL CHECK (leg_index >= 0),
  "trip_id" uuid NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  "is_return" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("journey_id", "leg_index")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trip_passengers (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trip_id" uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "name" text NOT NULL,
  "mobility_needs" text[] NOT NULL DEFAULT '{}'::text[],
  "seats" integer NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 8),
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_passengers_trip_idx" ON trip_passengers ("trip_id", "position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_journeys_awaiting_idx" ON trip_journeys ("return_expected_at")
  WHERE return_mode = 'call_when_ready' AND return_called_at IS NULL;
