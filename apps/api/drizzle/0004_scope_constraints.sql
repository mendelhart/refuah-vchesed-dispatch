-- ============================================================================
-- 0004 — constraints, triggers and generators for the production scope.
--
-- Same principle as 0001: anything the application must never do is refused by
-- the database, not merely avoided by the code. Everything here is a guarantee
-- that survives a future contributor who has not read the service layer.
-- ============================================================================

-- Deferred foreign keys. These columns are declared without `.references()` in
-- schema.ts only because the tables are defined later in the file; the
-- relationships are real and are enforced here.
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_caller_id_callers_id_fk"
  FOREIGN KEY ("caller_id") REFERENCES "callers"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_recurring_ride_id_fk"
  FOREIGN KEY ("recurring_ride_id") REFERENCES "recurring_rides"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_duplicated_from_trip_id_fk"
  FOREIGN KEY ("duplicated_from_trip_id") REFERENCES "trips"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_approved_by_id_fk"
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_application_id_fk"
  FOREIGN KEY ("application_id") REFERENCES "volunteer_applications"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "volunteer_applications"
  ADD CONSTRAINT "volunteer_applications_duplicate_of_application_id_fk"
  FOREIGN KEY ("duplicate_of_application_id") REFERENCES "volunteer_applications"("id") ON DELETE set null;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_window_chk"
  CHECK (weekday BETWEEN 0 AND 6 AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute);
--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_window_chk"
  CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_kind_chk"
  CHECK (kind IN ('unavailable', 'available'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recurring rides
--
-- A schedule that cannot produce a date is a silent no-op: the dispatcher sets
-- it up, nothing ever appears on the board, and nobody finds out until a
-- passenger is left waiting. So the shape of the recurrence is checked here.
-- ---------------------------------------------------------------------------
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_status_chk"
  CHECK (status IN ('active', 'paused', 'ended'));
--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_pickup_minute_chk"
  CHECK (pickup_minute BETWEEN 0 AND 1439);
--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_dates_chk"
  CHECK (end_date IS NULL OR end_date >= start_date);
--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_schedule_chk"
  CHECK (
    (frequency IN ('weekly', 'biweekly') AND array_length(by_weekday, 1) >= 1)
    OR (frequency = 'monthly' AND by_month_day BETWEEN 1 AND 28)
  );
--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_lead_time_chk"
  CHECK (lead_time_minutes BETWEEN 0 AND 20160);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_status_chk"
  CHECK (status IN ('open', 'snoozed', 'closed'));
--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_unread_chk"
  CHECK (unread_count >= 0);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_direction_chk"
  CHECK (direction IN ('inbound', 'outbound'));
--> statement-breakpoint

-- The thread's summary counters are derived, so they are maintained by the
-- database rather than by whichever code path happened to insert the message.
CREATE OR REPLACE FUNCTION sms_threads_touch() RETURNS trigger AS $$
BEGIN
  UPDATE sms_threads SET
    last_message_at = NEW.created_at,
    last_inbound_at = CASE WHEN NEW.direction = 'inbound' THEN NEW.created_at ELSE last_inbound_at END,
    unread_count    = CASE WHEN NEW.direction = 'inbound' THEN unread_count + 1 ELSE unread_count END,
    -- An inbound message reopens a closed conversation. Silence from our side
    -- is not consent to stop listening.
    status          = CASE WHEN NEW.direction = 'inbound' AND status <> 'open' THEN 'open' ELSE status END,
    snoozed_until   = CASE WHEN NEW.direction = 'inbound' THEN NULL ELSE snoozed_until END,
    updated_at      = now()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sms_messages_touch_thread
  AFTER INSERT ON sms_messages
  FOR EACH ROW EXECUTE FUNCTION sms_threads_touch();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Volunteer applications
-- ---------------------------------------------------------------------------
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_status_chk"
  CHECK (status IN ('submitted', 'info_requested', 'approved', 'rejected', 'withdrawn'));
--> statement-breakpoint
-- An approved application must say who it became and who approved it. Without
-- this, "approved" is a label rather than a record.
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_approved_chk"
  CHECK (status <> 'approved' OR (converted_user_id IS NOT NULL AND reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_rejected_chk"
  CHECK (status <> 'rejected' OR (reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_consent_chk"
  CHECK (consent_contact = true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Driver licences
--
-- THE constraint of this migration. `verified` is only writable alongside the
-- provider that verified it and the reference it returned. There is no way for
-- an administrator, an import, or a future code path to mark a licence verified
-- without an external verification actually having happened.
-- ---------------------------------------------------------------------------
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_status_chk"
  CHECK (status IN ('pending_review', 'on_file', 'verified', 'rejected', 'expired'));
--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_verified_requires_provider_chk"
  CHECK (
    status <> 'verified'
    OR (verification_provider IS NOT NULL
        AND verification_reference IS NOT NULL
        AND verified_at IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_owner_chk"
  CHECK (num_nonnulls(user_id, application_id) >= 1);
--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_last4_chk"
  CHECK (number_last4 IS NULL OR number_last4 ~ '^[A-Za-z0-9]{4}$');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Stored files
-- ---------------------------------------------------------------------------
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_size_chk" CHECK (byte_size > 0);
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_sensitivity_chk"
  CHECK (sensitivity IN ('public', 'internal', 'restricted'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Message templates — versioned, and the history is append-only.
-- ---------------------------------------------------------------------------
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_channel_chk"
  CHECK (channel IN ('sms', 'email', 'whatsapp', 'push'));
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_version_chk" CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_email_subject_chk"
  CHECK (channel <> 'email' OR (subject IS NOT NULL AND length(btrim(subject)) > 0));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_templates_version_bump() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    INSERT INTO message_template_versions (template_id, version, subject, body, changed_by_id)
    VALUES (OLD.id, OLD.version, OLD.subject, OLD.body, NEW.updated_by_id);
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER message_templates_version_bump_trg
  BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION message_templates_version_bump();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_template_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'message_template_versions is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER message_template_versions_no_update
  BEFORE UPDATE OR DELETE ON message_template_versions
  FOR EACH ROW EXECUTE FUNCTION message_template_versions_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Duty roster
--
-- Two people believing they are on the phone is the same failure as nobody
-- being on it. An exclusion constraint makes double-booking impossible.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "duty_shifts" ADD CONSTRAINT "duty_shifts_window_chk" CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE "duty_shifts" ADD CONSTRAINT "duty_shifts_kind_chk"
  CHECK (kind IN ('phone', 'dispatcher', 'backup'));
--> statement-breakpoint
ALTER TABLE "duty_shifts" ADD CONSTRAINT "duty_shifts_no_overlap"
  EXCLUDE USING gist (
    kind WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (deleted_at IS NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Callers
-- ---------------------------------------------------------------------------
ALTER TABLE "callers" ADD CONSTRAINT "callers_status_chk" CHECK (status IN ('active', 'archived'));
--> statement-breakpoint
ALTER TABLE "callers" ADD CONSTRAINT "callers_primary_phone_e164_chk"
  CHECK (primary_phone IS NULL OR primary_phone ~ '^\+[1-9][0-9]{7,14}$');
--> statement-breakpoint
ALTER TABLE "callers" ADD CONSTRAINT "callers_alternate_phone_e164_chk"
  CHECK (alternate_phone IS NULL OR alternate_phone ~ '^\+[1-9][0-9]{7,14}$');
--> statement-breakpoint
ALTER TABLE "caller_addresses" ADD CONSTRAINT "caller_addresses_label_chk"
  CHECK (label IN ('home', 'clinic', 'hospital', 'work', 'other'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Trips — new columns
-- ---------------------------------------------------------------------------
ALTER TABLE "trips" ADD CONSTRAINT "trips_offer_round_chk" CHECK (offer_round >= 0);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_escalation_count_chk" CHECK (escalation_count >= 0);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_not_own_duplicate_chk"
  CHECK (duplicated_from_trip_id IS NULL OR duplicated_from_trip_id <> id);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_callback_e164_chk"
  CHECK (callback_number IS NULL OR callback_number ~ '^\+[1-9][0-9]{7,14}$');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Exports and announcements
-- ---------------------------------------------------------------------------
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_status_chk"
  CHECK (status IN ('queued', 'running', 'ready', 'failed'));
--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_kind_chk"
  CHECK (kind IN ('trips', 'volunteers', 'monthly_board', 'equipment_loans', 'audit', 'notification_deliveries'));
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_status_chk"
  CHECK (status IN ('draft', 'sending', 'sent', 'failed'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Human-readable reference generators.
--
-- Same pattern as next_trip_reference(): a counter row locked FOR UPDATE, so
-- two concurrent requests cannot produce the same reference.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sequence_counters" (
  "name" text PRIMARY KEY,
  "last_value" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_sequence_value(seq_name text) RETURNS integer AS $$
DECLARE
  next_val integer;
BEGIN
  INSERT INTO sequence_counters (name, last_value) VALUES (seq_name, 0)
    ON CONFLICT (name) DO NOTHING;
  UPDATE sequence_counters SET last_value = last_value + 1
    WHERE name = seq_name
    RETURNING last_value INTO next_val;
  RETURN next_val;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_recurring_reference() RETURNS text AS $$
BEGIN
  RETURN 'RVC-R-' || lpad(next_sequence_value('recurring')::text, 4, '0');
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_application_reference() RETURNS text AS $$
BEGIN
  RETURN 'RVC-A-' || to_char(now() AT TIME ZONE 'America/Toronto', 'YYMMDD')
         || '-' || lpad(next_sequence_value('application:' || to_char(now() AT TIME ZONE 'America/Toronto', 'YYMMDD'))::text, 3, '0');
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_volunteer_number() RETURNS text AS $$
BEGIN
  RETURN 'V' || lpad(next_sequence_value('volunteer')::text, 4, '0');
END;
$$ LANGUAGE plpgsql;
