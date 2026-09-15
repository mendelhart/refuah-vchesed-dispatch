CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'unavailable' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caller_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"label" text DEFAULT 'home' NOT NULL,
	"entrance" text,
	"parking" text,
	"is_default_pickup" boolean DEFAULT false NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "callers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"primary_phone" text,
	"alternate_phone" text,
	"email" text,
	"language" text DEFAULT 'en' NOT NULL,
	"notes" text,
	"access_notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"row_count" integer,
	"file_id" uuid,
	"error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "driver_licences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"application_id" uuid,
	"province" text DEFAULT 'QC' NOT NULL,
	"country" text DEFAULT 'CA' NOT NULL,
	"number_ciphertext" text,
	"number_last4" text,
	"expires_on" text,
	"front_file_id" uuid,
	"back_file_id" uuid,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"verification_provider" text,
	"verification_reference" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "duty_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'phone' NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"notes" text,
	"reminder_sent_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"changed_by_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"channel" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"description" text,
	"variables" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_ride_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_ride_id" uuid NOT NULL,
	"occurrence_date" text NOT NULL,
	"trip_id" uuid,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"group_id" uuid NOT NULL,
	"caller_id" uuid,
	"caller_name" text,
	"caller_phone" text,
	"callback_number" text,
	"pickup_address_id" uuid NOT NULL,
	"dropoff_address_id" uuid NOT NULL,
	"pickup_entrance" text,
	"pickup_parking" text,
	"dropoff_entrance" text,
	"dropoff_parking" text,
	"trip_type" text DEFAULT 'ride' NOT NULL,
	"priority" text DEFAULT 'routine' NOT NULL,
	"mobility_needs" text[] DEFAULT '{}'::text[] NOT NULL,
	"passenger_notes" text,
	"appointment_offset_minutes" integer,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"by_weekday" integer[] DEFAULT '{}'::int[] NOT NULL,
	"by_month_day" integer,
	"pickup_minute" integer NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"preferred_volunteer_id" uuid,
	"lead_time_minutes" integer DEFAULT 1440 NOT NULL,
	"last_materialised_date" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "service_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"dispatchable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"provider_sid" text,
	"sent_by_id" uuid,
	"delivery_id" uuid,
	"status" text DEFAULT 'received' NOT NULL,
	"failure_reason" text,
	"read_at" timestamp with time zone,
	"read_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"party_type" text DEFAULT 'unknown' NOT NULL,
	"user_id" uuid,
	"caller_id" uuid,
	"display_name" text,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" uuid,
	"trip_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"bucket" text DEFAULT 'private' NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"sensitivity" text DEFAULT 'restricted' NOT NULL,
	"encrypted" boolean DEFAULT true NOT NULL,
	"original_name" text,
	"uploaded_by_id" uuid,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "volunteer_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"address_line" text,
	"city" text,
	"postal_code" text,
	"service_area" text,
	"requested_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"requested_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"has_vehicle" boolean DEFAULT false NOT NULL,
	"vehicle_type" text,
	"vehicle_seats" integer,
	"availability_note" text,
	"availability" jsonb,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"referred_by" text,
	"notes" text,
	"notification_preference" text DEFAULT 'sms' NOT NULL,
	"consent_contact" boolean DEFAULT false NOT NULL,
	"consent_background_check" boolean DEFAULT false NOT NULL,
	"consent_text_at" timestamp with time zone,
	"consent_text_version" text,
	"submitted_ip" text,
	"submitted_user_agent" text,
	"duplicate_of_user_id" uuid,
	"duplicate_of_application_id" uuid,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"info_requested_at" timestamp with time zone,
	"info_request_message" text,
	"converted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "volunteer_services" (
	"user_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"opted_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opted_in_by_id" uuid,
	CONSTRAINT "volunteer_services_user_id_service_type_id_pk" PRIMARY KEY("user_id","service_type_id")
);
--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "caller_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "callback_number" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "appointment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "pickup_entrance" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "pickup_parking" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "dropoff_entrance" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "dropoff_parking" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "recurring_ride_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "duplicated_from_trip_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "offer_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "escalation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "capabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "languages" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "has_vehicle" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vehicle_seats" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "service_area" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "volunteer_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caller_addresses" ADD CONSTRAINT "caller_addresses_caller_id_callers_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."callers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caller_addresses" ADD CONSTRAINT "caller_addresses_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callers" ADD CONSTRAINT "callers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_application_id_volunteer_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."volunteer_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_front_file_id_stored_files_id_fk" FOREIGN KEY ("front_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_back_file_id_stored_files_id_fk" FOREIGN KEY ("back_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_shifts" ADD CONSTRAINT "duty_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_shifts" ADD CONSTRAINT "duty_shifts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_ride_occurrences" ADD CONSTRAINT "recurring_ride_occurrences_recurring_ride_id_recurring_rides_id_fk" FOREIGN KEY ("recurring_ride_id") REFERENCES "public"."recurring_rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_ride_occurrences" ADD CONSTRAINT "recurring_ride_occurrences_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_group_id_volunteer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."volunteer_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_caller_id_callers_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."callers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_pickup_address_id_addresses_id_fk" FOREIGN KEY ("pickup_address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_dropoff_address_id_addresses_id_fk" FOREIGN KEY ("dropoff_address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_preferred_volunteer_id_users_id_fk" FOREIGN KEY ("preferred_volunteer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rides" ADD CONSTRAINT "recurring_rides_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_thread_id_sms_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."sms_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_read_by_id_users_id_fk" FOREIGN KEY ("read_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_caller_id_callers_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."callers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_threads" ADD CONSTRAINT "sms_threads_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_duplicate_of_user_id_users_id_fk" FOREIGN KEY ("duplicate_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_converted_user_id_users_id_fk" FOREIGN KEY ("converted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_services" ADD CONSTRAINT "volunteer_services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_services" ADD CONSTRAINT "volunteer_services_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_services" ADD CONSTRAINT "volunteer_services_opted_in_by_id_users_id_fk" FOREIGN KEY ("opted_in_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_status_idx" ON "announcements" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "availability_exceptions_user_idx" ON "availability_exceptions" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "availability_rules_user_idx" ON "availability_rules" USING btree ("user_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_rules_uq" ON "availability_rules" USING btree ("user_id","weekday","start_minute","end_minute");--> statement-breakpoint
CREATE INDEX "caller_addresses_caller_idx" ON "caller_addresses" USING btree ("caller_id","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "caller_addresses_uq" ON "caller_addresses" USING btree ("caller_id","address_id") WHERE "caller_addresses"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "caller_addresses_one_default_uq" ON "caller_addresses" USING btree ("caller_id") WHERE "caller_addresses"."is_default_pickup" and "caller_addresses"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "callers_primary_phone_live_uq" ON "callers" USING btree ("primary_phone") WHERE "callers"."deleted_at" is null and "callers"."primary_phone" is not null;--> statement-breakpoint
CREATE INDEX "callers_name_idx" ON "callers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "callers_alt_phone_idx" ON "callers" USING btree ("alternate_phone");--> statement-breakpoint
CREATE INDEX "data_exports_requester_idx" ON "data_exports" USING btree ("requested_by_id","created_at");--> statement-breakpoint
CREATE INDEX "data_exports_status_idx" ON "data_exports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "driver_licences_user_idx" ON "driver_licences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "driver_licences_application_idx" ON "driver_licences" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "driver_licences_expiry_idx" ON "driver_licences" USING btree ("expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_licences_one_live_per_user_uq" ON "driver_licences" USING btree ("user_id") WHERE "driver_licences"."user_id" is not null and "driver_licences"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "duty_shifts_window_idx" ON "duty_shifts" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "duty_shifts_user_idx" ON "duty_shifts" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "duty_shifts_kind_idx" ON "duty_shifts" USING btree ("kind","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_versions_uq" ON "message_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_key_channel_locale_uq" ON "message_templates" USING btree ("key","channel","locale");--> statement-breakpoint
CREATE INDEX "message_templates_key_idx" ON "message_templates" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_ride_occurrences_uq" ON "recurring_ride_occurrences" USING btree ("recurring_ride_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "recurring_ride_occurrences_trip_idx" ON "recurring_ride_occurrences" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_rides_reference_uq" ON "recurring_rides" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "recurring_rides_active_idx" ON "recurring_rides" USING btree ("status") WHERE "recurring_rides"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "recurring_rides_caller_idx" ON "recurring_rides" USING btree ("caller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_types_slug_uq" ON "service_types" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sms_messages_thread_idx" ON "sms_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_messages_provider_sid_uq" ON "sms_messages" USING btree ("provider_sid") WHERE "sms_messages"."provider_sid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_threads_phone_open_uq" ON "sms_threads" USING btree ("phone") WHERE "sms_threads"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "sms_threads_queue_idx" ON "sms_threads" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "sms_threads_owner_idx" ON "sms_threads" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "sms_threads_phone_idx" ON "sms_threads" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_key_uq" ON "stored_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "stored_files_purge_idx" ON "stored_files" USING btree ("purge_after");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_applications_reference_uq" ON "volunteer_applications" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "volunteer_applications_status_idx" ON "volunteer_applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "volunteer_applications_email_idx" ON "volunteer_applications" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "volunteer_applications_phone_idx" ON "volunteer_applications" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_applications_open_phone_uq" ON "volunteer_applications" USING btree ("phone") WHERE "volunteer_applications"."status" in ('submitted','info_requested') and "volunteer_applications"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "volunteer_services_service_idx" ON "volunteer_services" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "trips_caller_idx" ON "trips" USING btree ("caller_id","pickup_at");--> statement-breakpoint
CREATE INDEX "trips_recurring_idx" ON "trips" USING btree ("recurring_ride_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_volunteer_number_uq" ON "users" USING btree ("volunteer_number") WHERE "users"."volunteer_number" is not null;