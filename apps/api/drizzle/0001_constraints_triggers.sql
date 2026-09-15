-- Constraints, triggers and helper functions that the ORM schema cannot express.
-- These are the guarantees the application must not be able to violate even if
-- a future code path forgets to check.

-- ---------------------------------------------------------------------------
-- Enumerated values. Kept as CHECK constraints rather than PG enums so that
-- adding a value is an ordinary migration, not a type rewrite.
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD CONSTRAINT "users_role_chk"
  CHECK (role IN ('volunteer','dispatcher','admin'));
ALTER TABLE "users" ADD CONSTRAINT "users_status_chk"
  CHECK (status IN ('active','inactive','deactivated'));
ALTER TABLE "users" ADD CONSTRAINT "users_notification_pref_chk"
  CHECK (notification_preference IN ('sms','push','both','none'));
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_chk"
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "users" ADD CONSTRAINT "users_emergency_phone_e164_chk"
  CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "trips" ADD CONSTRAINT "trips_status_chk"
  CHECK (status IN ('new','pending','offered','assigned','accepted','en_route','in_progress','completed','cancelled','expired'));
ALTER TABLE "trips" ADD CONSTRAINT "trips_priority_chk"
  CHECK (priority IN ('routine','urgent','emergency'));
ALTER TABLE "trips" ADD CONSTRAINT "trips_type_chk"
  CHECK (trip_type IN ('ride','equipment_delivery','hospital_food'));
ALTER TABLE "trips" ADD CONSTRAINT "trips_assignment_mode_chk"
  CHECK (assignment_mode IN ('auto','admin_approval'));
ALTER TABLE "trips" ADD CONSTRAINT "trips_caller_phone_e164_chk"
  CHECK (caller_phone IS NULL OR caller_phone ~ '^\+[1-9][0-9]{7,14}$');

-- The defect that made the audit's headline finding: a trip in a state that
-- implies a volunteer, with no volunteer attached. The database now refuses it.
ALTER TABLE "trips" ADD CONSTRAINT "trips_engaged_requires_volunteer_chk"
  CHECK (
    status NOT IN ('assigned','accepted','en_route','in_progress')
    OR assigned_volunteer_id IS NOT NULL
  );

-- A cancelled trip must say why and when.
ALTER TABLE "trips" ADD CONSTRAINT "trips_cancelled_has_reason_chk"
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL));

ALTER TABLE "trips" ADD CONSTRAINT "trips_completed_has_timestamp_chk"
  CHECK (status <> 'completed' OR completed_at IS NOT NULL);

ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_status_chk"
  CHECK (status IN ('pending','accepted','declined','expired','superseded','cancelled'));
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_expiry_after_offer_chk"
  CHECK (expires_at > offered_at);
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_resolved_has_timestamp_chk"
  CHECK (status = 'pending' OR responded_at IS NOT NULL OR status IN ('expired','superseded','cancelled'));

-- At most one accepted offer per trip, ever.
CREATE UNIQUE INDEX "trip_offers_one_accepted_uq"
  ON "trip_offers" (trip_id) WHERE status = 'accepted';

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_chk"
  CHECK (channel IN ('sms','push','inapp'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_chk"
  CHECK (status IN ('queued','sent','delivered','failed','skipped'));

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_chk"
  CHECK (status IN ('pending','running','done','failed','dead'));

ALTER TABLE "calls" ADD CONSTRAINT "calls_counterparty_chk"
  CHECK (counterparty_type IN ('caller','volunteer','contact'));
ALTER TABLE "calls" ADD CONSTRAINT "calls_status_chk"
  CHECK (status IN ('requested','ringing','in_progress','completed','failed','no_answer','blocked'));

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_status_chk"
  CHECK (status IN ('available','loaned','maintenance','retired'));

ALTER TABLE "sms_events" ADD CONSTRAINT "sms_events_direction_chk"
  CHECK (direction IN ('inbound','outbound'));

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','volunteer_groups','trips','contacts','vehicles',
    'equipment','equipment_categories','organization_info','settings'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- Trip edits bump the version so optimistic concurrency works even for writes
-- that forget to do it in application code.
CREATE OR REPLACE FUNCTION bump_trip_version() RETURNS trigger AS $$
BEGIN
  IF NEW.version = OLD.version THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trips_bump_version BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION bump_trip_version();

-- ---------------------------------------------------------------------------
-- audit_events is append-only.
--
-- The application has no update/delete path, and the database enforces it, so
-- a compromised application account still cannot rewrite history.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Human-readable trip references: RVC-YYMMDD-NNNN, allocated atomically.
-- Not secret, not used for authorisation — see docs/SECURITY.md.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_trip_reference() RETURNS text AS $$
DECLARE
  d text := to_char((now() AT TIME ZONE 'America/Toronto')::date, 'YYMMDD');
  n integer;
BEGIN
  INSERT INTO trip_counters (day, last_value) VALUES (d, 1)
  ON CONFLICT (day) DO UPDATE SET last_value = trip_counters.last_value + 1
  RETURNING last_value INTO n;
  RETURN 'RVC-' || d || '-' || lpad(n::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Realtime: every trip change notifies listeners so the dispatcher board
-- updates without polling.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notify_trip_change() RETURNS trigger AS $$
DECLARE payload text;
BEGIN
  payload := json_build_object(
    'type', 'trip',
    'op', lower(TG_OP),
    'id', COALESCE(NEW.id, OLD.id),
    'status', COALESCE(NEW.status, OLD.status),
    'groupId', COALESCE(NEW.group_id, OLD.group_id),
    'assignedVolunteerId', COALESCE(NEW.assigned_volunteer_id, OLD.assigned_volunteer_id),
    'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text;
  -- pg_notify payloads are capped at 8000 bytes; this one is far below.
  PERFORM pg_notify('rvc_events', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trips_notify_change AFTER INSERT OR UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION notify_trip_change();
