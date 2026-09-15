# Database

PostgreSQL 16. Schema in `apps/api/src/db/schema.ts` (Drizzle), migrations in
`apps/api/drizzle/*.sql`. Forty-two tables are declared in `schema.ts` and grouped below by what they are
for; `sequence_counters`, created directly by migration 0004, makes forty-three.

Six rules the schema exists to enforce, each of which was a defect in the Base44
implementation:

1. **One authoritative identity.** `users` is the only representation of a
   person — no parallel Volunteer table, no public directory copy. Group
   membership is a join table, not a text array.
2. **No field lives in two places.** There is no `data` JSON blob shadowing
   top-level columns.
3. **Offers are rows**, not side effects of sending an SMS.
4. **History is preserved.** `trip_assignments` keeps every assignment;
   `trips.assigned_volunteer_id` is a denormalised convenience with an FK.
5. **Nothing operational is hard-deleted.** `deleted_at` plus partial unique
   indexes, so a deleted user's email can be reused but their trips still read.
6. **`audit_events` is append-only**, enforced by the database.

---

## Tables by concern

### Identity and access

| Table | Exists for |
| --- | --- |
| `users` | Every person: volunteer, dispatcher, admin. One row, one identity. Carries the roster facts targeting needs (`capabilities`, `languages`, `has_vehicle`, `vehicle_seats`, `service_area`), the snooze (`muted_until`), fairness rotation (`last_offered_at`), the ID-card pair (`volunteer_number`, `card_token`), provenance from an application (`application_id`, `approved_at`, `approved_by_id`) and the login-security columns (`failed_login_count`, `locked_until`, `must_change_password`) |
| `volunteer_groups` / `user_groups` | The operational groups (`chaim_vchesed`, `chesed_on_the_go`, `misamchem`) as rows with a stable slug, and a many-to-many join. In Base44 these were free-text keys duplicated on both the User and the Trip, so a typo silently created a fourth group nobody could see |
| `sessions` | Server-side sessions. `token_hash` is SHA-256 of the cookie value; the raw token is never stored. `expires_at`, `revoked_at`, `last_seen_at`, plus `ip` and `user_agent` for "where am I signed in" |
| `auth_tokens` | Invite and password-reset tokens: hashed, single-use (`used_at`), expiring. Deleted outright when a user is deactivated |
| `push_subscriptions` | One row per browser. `endpoint` is globally unique, so re-subscribing updates in place. `failure_count` and `disabled_at` retire endpoints that return 404/410 |

### Availability and capability

| Table | Exists for |
| --- | --- |
| `service_types` | What kinds of work exist. The three dispatchable slugs (`ride`, `equipment_delivery`, `hospital_food`) deliberately match `TRIP_TYPES`, so a trip maps to a service without a join table; `phone_duty` and `visits` are opt-ins that never produce an offer |
| `volunteer_services` | A volunteer's own opt-in to a service. Self-serve: the volunteer owns these rows, and a dispatcher may set them during a phone call. Without this table targeting has nothing to filter on, and the legacy behaviour — offer everything to everyone — returns |
| `availability_rules` | Weekly wall-clock windows in `America/Toronto`, stored as weekday (0 = Sunday, matching `extract(dow)`) plus start and end minutes from local midnight. **No rows means always available** |
| `availability_exceptions` | Dated overrides, `unavailable` (a holiday) or `available` (a one-off). An `unavailable` exception wins over everything |

### Callers

| Table | Exists for |
| --- | --- |
| `callers` | The people the organisation drives. Roughly a third of rides are for somebody who has called before; the legacy app re-interviewed them every time. `access_notes` carries the standing operational facts ("needs help to the door", "ring 2B"). `primary_phone` is unique among live callers so an inbound number resolves to one person |
| `caller_addresses` | Saved addresses per caller, with `entrance` and `parking` — the detail that saves a volunteer a phone call — plus `use_count` and `last_used_at` so the common one is offered first. At most one default pickup per caller |
| `addresses` | Immutable address rows. Editing a trip's pickup inserts a **new** row and repoints the FK rather than mutating the old one, so a completed trip still shows the address the volunteer actually drove to. Defaults are Montreal/QC/CA; `latitude`/`longitude` come from the geocoder when available |

### Trips

| Table | Exists for |
| --- | --- |
| `trips` | The operational core. `reference` (`RVC-YYMMDD-NNNN`) is human-facing and never an authorisation value. Ten statuses, three priorities, three types. Beyond the journey itself it carries the appointment time (distinct from pickup), the callback number (often a ward desk, not the caller), entrance and parking for both ends, provenance (`recurring_ride_id`, `duplicated_from_trip_id`), broadcast state (`offer_round`, `offer_expires_at`, `escalated_at`, `escalation_count`), one timestamp per transition, and `version` for optimistic concurrency |
| `trip_assignments` | Full assignment history. A row opens on assign or claim and closes (`unassigned_at`, `unassigned_reason`) on reassign, cancel, return-to-pending or completion. `source` is `dispatcher` \| `claim` \| `sms` \| `import`. "Who had this trip, when, and why did it move?" is always answerable |
| `trip_offers` | One row per volunteer per broadcast — the table the legacy system did not have. `token_hash` is SHA-256 of the 10-character offer code; the code itself is never stored. `round` increments on re-broadcast, which supersedes the previous round and kills its codes. `response_channel` records whether the answer came from the app, an SMS, a push tap or a dispatcher |
| `trip_counters` | `day` (`YYMMDD` in Toronto) → `last_value`, backing `next_trip_reference()` |
| `recurring_rides` | A standing ride: the journey template plus a recurrence (`weekly`/`biweekly`/`monthly`, `by_weekday`, `by_month_day`, `pickup_minute`, `start_date`, `end_date`), a preferred volunteer, and `lead_time_minutes` saying how long before pickup the occurrence should be offered |
| `recurring_ride_occurrences` | One row per materialised date, unique on (ride, date). This is what makes the materialiser idempotent — and what records a date that was skipped, and why |

### Notifications and messaging

| Table | Exists for |
| --- | --- |
| `notifications` | The *event*: one row per thing a person should be told, with `event`, title, body, optional trip and offer, and `read_at` for the in-app feed |
| `notification_deliveries` | The *attempt*: one row per channel per notification. `channel` (sms/push/email/whatsapp/inapp), `status`, `attempts`/`max_attempts`, `provider`, `provider_message_id` (how a Twilio status callback finds the row), `destination`, `last_error`, `next_attempt_at`. `skipped` is the important status: "this volunteer has no phone number on file" is recorded as a fact with a reason, not silently dropped |
| `message_templates` | Every word the system says to a human, by key, channel and locale, with the variable list the template may reference. Administrators edit these; the code only ever refers to a key from `TEMPLATE_KEYS` |
| `message_template_versions` | Append-only history of template edits, written by a trigger, so an edit that broke a message can be traced and reverted |
| `sms_events` | Every inbound and outbound message, **including rejected ones**. `signature_valid` records whether the Twilio signature checked out; `outcome` is `accepted`/`declined`/`unmatched`/`rejected_signature`/`opt_out`/`snoozed`/`conversation`/… . `provider_sid` is uniquely indexed where non-null, which is what makes Twilio's retry-on-timeout idempotent |
| `sms_threads` | A conversation with one phone number. Status, owner, unread count, an optional link to a trip, and the resolved identity (volunteer, caller or unknown). One live thread per number |
| `sms_messages` | The messages on a thread, inbound and outbound, with the delivery row an outbound message came from |
| `announcements` | A bulk broadcast. The `audience` is stored as the *query*, not a list of ids, so the audit shows who was targeted and why; `channels`, `recipient_count` and `sent_at` record what actually happened |

### Calls

| Table | Exists for |
| --- | --- |
| `calls` | Masked calling. The initiator never supplies a phone number — they name a *relationship* and the server resolves it from `counterparty_user_id`, `trip_id` or `contact_id`. `authorization_basis` records the reason in words ("assigned volunteer calling trip caller"). Only `destination_last4` is retained for display |
| `contacts` | The organisation's phone book, soft-deleted so call logs stay readable |

### Onboarding and documents

| Table | Exists for |
| --- | --- |
| `volunteer_applications` | A public signup. **An applicant is not a user**: nothing here can reach the dispatch board, receive an offer or log in until an administrator approves it and the record is converted. Keeps the consent text version and timestamp, the requested services/groups/capabilities, a proposed availability grid applied on approval, duplicate pointers, and the review trail. `submitted_ip`/`submitted_user_agent` exist for the abuse window and are nulled on approval |
| `stored_files` | The authorisation record for an uploaded object. Bytes live behind the `ObjectStore` provider; this table is the only way to resolve a storage key. Carries `sha256` for integrity, `sensitivity`, `encrypted`, and `purge_after` |
| `driver_licences` | An image and/or number on file for a person to look at. `status = 'verified'` is writable only alongside the provider that verified it and the reference it returned. The number is AES-256-GCM ciphertext; only `number_last4` is in clear |

### Roster operations

| Table | Exists for |
| --- | --- |
| `duty_shifts` | Who is answering the organisation's line. `kind` is `phone`/`dispatcher`/`backup`; `reminder_sent_at` stops a shift being reminded twice |
| `data_exports` | An export request: who asked, for what, when, how many rows, which stored file, and when it self-destructs |
| `equipment_categories` / `equipment` | Wheelchairs, walkers, beds, crutches, with item codes and barcodes |
| `equipment_loans` | Loans are rows with a lifecycle, not fields smeared across the item, so an item cannot be lent twice and history survives a return |
| `vehicles` | The organisation's own vehicles |
| `organization_info` | Name, phone, email, address — the values that appear in outbound messages |

### Machinery

| Table | Exists for |
| --- | --- |
| `jobs` | The queue. `kind`, `payload`, `status`, `run_at`, `attempts`/`max_attempts`, `locked_at`/`locked_by`, `last_error`, and `dedupe_key` — which is both at-most-once scheduling and the whole cron replacement |
| `settings` | Key-value jsonb. Operational timings live here so dispatch policy is tuned by an admin, not by a deploy. Defaults are `DEFAULT_SETTINGS` in `packages/shared/src/domain.ts`; cached in-process for 15 seconds |
| `sequence_counters` | Backs `next_sequence_value()` and the reference generators for recurring rides, applications and volunteer numbers |
| `audit_events` | Append-only record of who did what. `actor_user_id`/`actor_name`/`actor_role` come from the session, never from the request body |

### Settings and their defaults

Read out of `DEFAULT_SETTINGS`; every one is overridable in the `settings` table
via `PUT /api/settings/:key`.

| Key | Default | Governs |
| --- | --- | --- |
| `dispatch.offer_window_minutes` | 30 | How long a routine offer stays answerable |
| `dispatch.urgent_offer_window_minutes` | 10 | The same, for `urgent` |
| `dispatch.emergency_offer_window_minutes` | 5 | The same, for `emergency` |
| `dispatch.offer_reminder_minutes` | 10 | When the single reminder goes to the same people |
| `dispatch.escalation_minutes` | 20 | When dispatchers are warned about silence (capped by the window) |
| `dispatch.overdue_grace_minutes` | 15 | How late a pickup is before the board calls it overdue |
| `dispatch.offer_batch_size` | 40 | How many volunteers one round asks |
| `notifications.max_attempts` | 5 | Delivery attempts before a channel is marked failed |
| `notifications.retry_backoff_seconds` | 30 | Base of the delivery backoff, doubling per attempt |
| `auth.session_ttl_hours` | 336 (14 days) | Session lifetime |
| `calling.daily_limit_per_user` | 100 | Masked calls per user per rolling 24 hours |
| `retention.notification_days` | 180 | Age at which `notifications` rows are deleted |
| `retention.sms_event_days` | 365 | Age at which `sms_events` rows are deleted |
| `retention.call_log_days` | 365 | Age at which call rows shed name and last-4 |
| `retention.sms_message_days` | 365 | Age at which conversation messages are deleted |
| `recurring.horizon_days` | 14 | How far ahead standing rides materialise |
| `equipment.due_reminder_days` | 2 | Days before a loan is due that the borrower is reminded |
| `duty.shift_reminder_minutes` | 60 | How long before a shift its holder is reminded |
| `volunteers.licence_expiry_warning_days` | 45 | Warning window before a licence lapses |
| `volunteers.application_duplicate_window_days` | 365 | How far back duplicate-application detection looks |
| `announcements.max_recipients` | 1000 | Hard ceiling on one broadcast |

---

## Invariants the database enforces

Everything in this section is enforced by Postgres, not by the application. The
distinction is the difference between "we are careful" and "it cannot happen":
each of these survives a future contributor who has not read the service layer,
a bulk import, a psql session, and a bug.

### Enumerated values as CHECK, not PG enums

`users.role/status/notification_preference`, `trips.status/priority/trip_type/
assignment_mode`, `trip_offers.status`, `notification_deliveries.channel/status`,
`jobs.status`, `calls.counterparty_type/status`, `equipment.status`,
`sms_events.direction`, and in 0004 every new vocabulary: recurring-ride status
and schedule shape, thread status, message direction and channel, application
status, licence status, file sensitivity, template channel, duty kind, caller
status, address label, export kind and status, announcement status.

Adding a value is an ordinary `ALTER TABLE … DROP/ADD CONSTRAINT`, not a type
rewrite that locks the table — which is exactly what migration 0005 does when
email and WhatsApp become real channels.

**Prevents:** a typo'd status that no query matches and no screen displays.

### Phone shape

`users.phone`, `users.emergency_contact_phone`, `trips.caller_phone`,
`trips.callback_number`, `callers.primary_phone`, `callers.alternate_phone` must
match `^\+[1-9][0-9]{7,14}$`.

**Prevents:** a `(514) 555-0100` in the database that never equals the
`+15145550100` an inbound SMS arrives as — which is how a volunteer's reply
silently stops matching them.

### `trips_engaged_requires_volunteer_chk`

```sql
CHECK (status NOT IN ('assigned','accepted','en_route','in_progress')
       OR assigned_volunteer_id IS NOT NULL)
```

**Prevents the headline defect of the audit:** a trip that says a volunteer is on
the way, with no volunteer attached. Dispatchers saw it as covered; nobody was
driving.

### `trips_cancelled_has_reason_chk` / `trips_completed_has_timestamp_chk`

A cancelled trip must have both `cancelled_at` and `cancellation_reason`; a
completed trip must have `completed_at`.

**Prevents:** "why did this not happen?" having no answer a week later, and
completion statistics built on rows with no completion time.

### `trip_offers_one_accepted_uq`

```sql
CREATE UNIQUE INDEX trip_offers_one_accepted_uq
  ON trip_offers (trip_id) WHERE status = 'accepted';
```

**Prevents:** two volunteers both holding an accepted offer for one trip. This is
the second line of defence behind the compare-and-set in `claimTrip`, and it
holds even if a future code path forgets the `WHERE status='offered'` clause.

### `trip_assignments_one_live_uq`

At most one row per trip with `unassigned_at IS NULL`.

**Prevents:** assignment history that says two people currently have the trip.

### `trip_offers_expiry_after_offer_chk`

`expires_at > offered_at`.

**Prevents:** an offer that is born expired — sent, unanswerable, and counted as
a broadcast.

### `jobs_dedupe_uq`

Unique on `dedupe_key` where it is non-null and the status is `pending` or
`running`.

**Prevents:** a re-broadcast scheduling a second expiry job for the same offer,
which would expire a *later* round's offer early — and, since the scheduler is
built on this index, two API machines both materialising the same standing ride
or running the same daily scan twice.

### `duty_shifts_no_overlap` — a GiST exclusion constraint

```sql
EXCLUDE USING gist (kind WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (deleted_at IS NULL)
```

Requires the `btree_gist` extension, which 0004 creates.

**Prevents:** two people believing they are on the phone — which is the same
failure as nobody being on it. Two dispatchers pressing save at the same moment
is a constraint violation (SQLSTATE 23P01), not a race; `duty.service.ts` catches
that code and turns it into "X is already on phone duty then."

Different *kinds* of duty may overlap: the phone and the dispatcher board are
different jobs.

### `driver_licences_verified_requires_provider_chk`

```sql
CHECK (status <> 'verified'
       OR (verification_provider IS NOT NULL
           AND verification_reference IS NOT NULL
           AND verified_at IS NOT NULL))
```

**Prevents:** a licence being marked verified when nothing verified it. This is
the second of two independent locks; the first is that `reviewLicence()` accepts
only `on_file` or `rejected`, and only `verifyLicence()` — reading a provider's
affirmative result *with* a reference — ever writes `verified`. Two locks,
because "the system says his licence is valid" is a sentence somebody will one
day say in a room where it matters. See
[SECURITY.md](SECURITY.md#driver-licences-what-the-system-does-not-do).

Alongside it, `driver_licences_owner_chk` requires a licence to belong to a user
or an application (`num_nonnulls(user_id, application_id) >= 1`), and
`driver_licences_one_live_per_user_uq` allows one live record per volunteer.

### `sms_messages_touch_thread` — the counter trigger

```sql
AFTER INSERT ON sms_messages → UPDATE sms_threads SET
  last_message_at, last_inbound_at, unread_count = unread_count + 1 (inbound),
  status = 'open' when an inbound message arrives on a non-open thread,
  snoozed_until = NULL on inbound, updated_at = now()
```

**Prevents:** a queue whose counters depend on which code path happened to insert
the message. It is also how an inbound message reopens a closed or snoozed
thread — silence from our side is not consent to stop listening — without every
caller of `recordInbound` remembering to do it.

### `message_templates_version_bump_trg` — versioning

On update, if the body or subject actually changed, the trigger copies the *old*
row into `message_template_versions`, increments `version` and stamps
`updated_at`. A companion trigger makes `message_template_versions` reject
UPDATE and DELETE.

**Prevents:** an edit that breaks an SMS to 500 people being untraceable and
unrevertable. `POST /api/templates/:id/revert` works by writing an old body back
through the same path, so the revert is itself a new version.

### `audit_events_immutable()`

`BEFORE UPDATE` and `BEFORE DELETE` on `audit_events` raise
`restrict_violation`.

**Prevents:** history being rewritten — by a bug, by a well-meaning cleanup
script, or by whoever holds the application's database credentials. The
application has no update or delete path for this table; the database enforces
that it never grows one. `scripts/verify-backup.sh` actively tests this after
every restore drill.

### `volunteer_applications_approved_chk` / `_rejected_chk` / `_consent_chk`

An approved application must name the user it became and the administrator who
approved it, with a timestamp; a rejected one must name its reviewer. Every row
must have `consent_contact = true`.

**Prevents:** "approved" being a label rather than a record, and an application
existing for somebody who never agreed to be contacted.

### `recurring_rides_schedule_chk`

A weekly or biweekly ride must have at least one weekday; a monthly ride must
have a day of month between 1 and 28.

**Prevents:** a schedule that can never produce a date. That is a silent no-op —
the dispatcher sets it up, nothing appears on the board, and nobody finds out
until a passenger is left waiting. Days 29–31 are refused because they do not
exist in every month, which would skip some silently.

### `set_updated_at()` and `bump_trip_version()`

`set_updated_at` is applied to `users`, `volunteer_groups`, `trips`, `contacts`,
`vehicles`, `equipment`, `equipment_categories`, `organization_info` and
`settings`. **Prevents:** an `updated_at` that lies because one code path forgot.

`bump_trip_version` increments `trips.version` on any update that did not already
change it. `updateTrip` compares the client's `version` and throws `stale_state`
("Someone else changed this trip while you were editing"). **Prevents:** two
dispatchers editing the same trip and the second silently overwriting the first —
including for writes that forget to bump it.

### `next_trip_reference()` and the other generators

```sql
INSERT INTO trip_counters (day, last_value) VALUES (d, 1)
ON CONFLICT (day) DO UPDATE SET last_value = trip_counters.last_value + 1
RETURNING last_value INTO n;
RETURN 'RVC-' || d || '-' || lpad(n::text, 4, '0');
```

Atomic, gapless per day, in Toronto time. **Prevents:** the legacy 4-digit random
`call_id`, whose 10,000 values gave roughly a 50% chance of a collision after
about 112 trips — and which was also used as the SMS authorisation value. See
[SECURITY.md](SECURITY.md#offer-codes).

Migration 0004 generalises the pattern into `sequence_counters` plus
`next_sequence_value()`, and adds `next_recurring_reference()` (`RVC-R-0001`),
`next_application_reference()` (`RVC-A-260914-001`) and `next_volunteer_number()`
(`V0001`).

### `notify_trip_change()`

`AFTER INSERT OR UPDATE ON trips` → `pg_notify('rvc_events', …)` with type, op,
id, status, group id and assigned volunteer id — no trip content, far below the
8000-byte payload cap.

**Prevents:** the dispatcher board needing to poll, and prevents the realtime
channel from becoming a second, unscoped way to read trip data.

---

## Indexes and the query each one serves

### `trips`
| Index | Serves |
| --- | --- |
| `trips_reference_uq` | reference lookup from an SMS body or a support call |
| `trips_status_pickup_idx (status, pickup_at)` | the board: "everything pending, soonest first" |
| `trips_group_status_idx (group_id, status)` | a volunteer's group-scoped list |
| `trips_assignee_idx (assigned_volunteer_id, status)` | "My trips", and the conflict filter in targeting |
| `trips_pickup_at_idx` | date-range reports and exports |
| `trips_caller_idx (caller_id, pickup_at)` | a caller's ride history, and the familiarity score |
| `trips_recurring_idx` | a standing ride's occurrences |
| `trips_open_idx (pickup_at) WHERE deleted_at IS NULL AND status NOT IN ('completed','cancelled')` | the board's hot path. Partial, so it stays small forever |
| `trips_offer_expiry_idx (offer_expires_at) WHERE status='offered'` | the expiry sweep; typically a handful of rows |

### `trip_offers`
| Index | Serves |
| --- | --- |
| `trip_offers_token_uq (token_hash)` | **the claim path** — an SMS or deep-link code resolves to one offer in one index hit |
| `trip_offers_trip_vol_round_uq` | at most one offer per volunteer per round |
| `trip_offers_volunteer_pending_idx … WHERE status='pending'` | "what am I being asked to do right now?" |
| `trip_offers_trip_idx (trip_id, status)` | the dispatcher's "who has been asked" panel |
| `trip_offers_expiry_idx (expires_at) WHERE status='pending'` | expiry jobs |
| `trip_offers_one_accepted_uq` | correctness, not speed |

### `jobs`
| Index | Serves |
| --- | --- |
| `jobs_claim_idx (run_at) WHERE status='pending'` | the worker's claim query, every two seconds, forever. Partial so completed jobs never slow it down |
| `jobs_kind_idx (kind, status)` | "are notification deliveries backing up?" |
| `jobs_dedupe_uq` | at-most-once scheduling |

### `notification_deliveries`
| Index | Serves |
| --- | --- |
| `notification_deliveries_pending_idx (next_attempt_at) WHERE status IN ('queued','sent')` | the retry sweep |
| `notification_deliveries_status_idx (status, queued_at)` | the failures screen — the first thing to open in an incident |
| `notification_deliveries_provider_msg_idx` | Twilio status callback → the row it updates |
| `notification_deliveries_notification_idx` | all channels for one notification |

### `users`
| Index | Serves |
| --- | --- |
| `users_email_live_uq (lower(email)) WHERE deleted_at IS NULL` | case-insensitive login, while letting a deactivated person's address be reused |
| `users_phone_live_uq (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL` | **inbound SMS → exactly one person.** The whole SMS identity model rests on this |
| `users_volunteer_number_uq`, `users_card_token_uq` | the ID card: one number, one opaque token, each globally unique where set |
| `users_role_idx (role, status)` | "all active dispatchers" — used on every escalation and expiry |
| `users_name_idx (full_name)` | roster sort |

### The production-scope tables
| Index | Serves |
| --- | --- |
| `callers_primary_phone_live_uq` | an inbound number resolves to one caller |
| `caller_addresses_one_default_uq … WHERE is_default_pickup` | one default pickup per caller |
| `recurring_ride_occurrences_uq (recurring_ride_id, occurrence_date)` | the materialiser's idempotence |
| `sms_threads_phone_open_uq (phone) WHERE status <> 'closed'` | one live conversation per number |
| `sms_threads_queue_idx (status, last_message_at)`, `sms_threads_owner_idx` | the console queue and "mine" |
| `sms_messages_provider_sid_uq … WHERE provider_sid IS NOT NULL` | webhook idempotency on the conversation side |
| `volunteer_applications_open_phone_uq … WHERE status IN ('submitted','info_requested')` | one live application per phone; a re-submission updates it rather than creating a second review task |
| `driver_licences_one_live_per_user_uq`, `driver_licences_expiry_idx` | one live licence per volunteer; the daily expiry scan |
| `stored_files_key_uq`, `stored_files_purge_idx` | key resolution; the purge sweep |
| `message_templates_key_channel_locale_uq` | one active template per key/channel/locale |
| `duty_shifts_window_idx`, `duty_shifts_kind_idx` | the roster view and "who is on now" |
| `equipment_loans_one_open_uq … WHERE returned_at IS NULL` | an item cannot be lent twice |
| `equipment_loans_due_idx … WHERE returned_at IS NULL` | the daily due/overdue scan |
| `sms_events_provider_sid_uq`, `sms_events_outcome_idx` | Twilio replay idempotency; the abuse view |
| `audit_events_*` | a trip's history panel, "what did this person do", "every deactivation this quarter", retention sweeps |

---

## The migrations, in order

Drizzle records applied migrations in `drizzle.__drizzle_migrations` and takes an
advisory lock, so concurrent starts are safe and re-running is a no-op.

| File | What it does |
| --- | --- |
| `0000_lame_black_tarantula.sql` | The original 24 tables, foreign keys and indexes. Generated by drizzle-kit |
| `0001_constraints_triggers.sql` | **Hand-written.** The CHECK constraints, the `set_updated_at` and `bump_trip_version` triggers, the append-only `audit_events` triggers, `next_trip_reference()`, and the `notify_trip_change()` trigger that feeds the realtime stream. This is where the original guarantees live |
| `0002_mute_and_call_direction.sql` | `users.muted_until`, and `calls.direction/counterparty_name/contact_id/failure_reason` |
| `0003_production_scope.sql` | Generated. The eighteen new tables — services, availability, callers, recurring rides, conversations, applications, stored files, licences, templates, duty, exports, announcements — plus the new columns on `trips` (caller, callback number, appointment, entrance/parking, provenance, offer round, escalation count) and on `users` (capabilities, languages, vehicle, service area, locale, volunteer number, approval provenance, `last_offered_at`) |
| `0004_scope_constraints.sql` | **Hand-written, and the counterpart to 0001 for everything 0003 added.** The deferred foreign keys the ORM could not declare because the tables are defined later in the file; every new CHECK; the `sms_threads` counter trigger; the template versioning and immutability triggers; the `btree_gist` extension and the duty-shift exclusion constraint; the licence "verified requires a provider" check; and the `sequence_counters` generators |
| `0005_widen_channels.sql` | Drops and re-adds `users_notification_pref_chk` and `notification_deliveries_channel_chk` to admit `email` and `whatsapp`, adds the channel check on `sms_messages`, and constrains `announcements.channels` to a subset of the real channel list. They stay CHECK constraints rather than becoming free text: a typo in a channel name should fail the write, not create a delivery row nothing will ever pick up |
| `0006_card_token.sql` | Adds `users.card_token` with a unique index and backfills existing volunteers. The card's QR previously carried the volunteer number, which is printed on the badge in large type — so anyone who photographed one card could walk the numbers and confirm the whole roster. The backfill uses two `gen_random_uuid()` values rather than `gen_random_bytes()` because `pgcrypto` is not assumed to be installed |

---

## Conventions

- **Timestamps are `timestamptz`**, stored UTC, rendered in `America/Toronto`.
  Trip references use Toronto dates, so `RVC-260914-0001` is the first trip of
  September 14th *locally*. Availability windows and recurrence times are stored
  as local wall-clock minutes precisely because "9am on Tuesday" does not move
  when the clocks do.
- **Soft delete everywhere operational.** Partial unique indexes carry the
  `WHERE deleted_at IS NULL` predicate so uniqueness applies to live rows only.
- **`ON DELETE` is chosen per relationship:** `cascade` for rows owned by a user
  (sessions, tokens, push subscriptions, group membership, service opt-ins,
  availability), `restrict` where a delete would destroy history (a group with
  trips, a volunteer with assignments, the requester of an export), `set null`
  for provenance (`created_by_id`, `cancelled_by_id`, `owner_id`).
- **jsonb is for genuinely open shapes only** — `audit_events.previous/next`,
  `settings.value`, `jobs.payload`, `announcements.audience`,
  `data_exports.params`, an application's proposed availability grid. Nothing a
  query filters on lives in jsonb.

## Changing the schema

```bash
# 1. edit apps/api/src/db/schema.ts
npm run db:generate --workspace=@rvc/api     # writes apps/api/drizzle/000N_*.sql
# 2. read the generated SQL. Always.
# 3. hand-write constraints/triggers into the same file if the ORM cannot say it
npm run db:migrate
```

Migrations must be backward-compatible with the version currently running: Fly's
`release_command` applies them *before* the new machines take traffic, so the old
code briefly runs against the new schema. Add a column, deploy, backfill, then
remove the old one in a later release. Never rename in one step. See
[DEPLOYMENT.md](DEPLOYMENT.md#migrations).
