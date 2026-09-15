# Architecture

One deployable process (`apps/api`), one PostgreSQL database, one React SPA
served as static files. Everything below explains why it is shaped that way and
where the seams are.

```
                    ┌──────────────────────────────┐
  volunteer phone   │        apps/web (SPA)        │  static files on a CDN /
  dispatcher laptop │  React + TanStack Query + SSE│  nginx. No server logic.
                    └───────────────┬──────────────┘
                                    │ HTTPS, cookie session
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                          apps/api  (Fastify 5)                       │
  │                                                                      │
  │  routes/      one endpoint per state-machine transition              │
  │     │         auth guard (preHandler) → zod parse → domain function  │
  │     ▼                                                                │
  │  domain/      dispatch.service.ts — every write to a trip            │
  │     │         object-level authorisation, audit, notify: one txn     │
  │     ▼                                                                │
  │  db/          drizzle over postgres-js                               │
  │                                                                      │
  │  services/providers/  twilio · web-push · smtp · waha · nominatim ·  │
  │                       local/S3 object store · licence verification   │
  │  jobs/worker          polls `jobs`, runs handlers  (same process)    │
  └───────────────┬────────────────────────────────────┬─────────────────┘
                  │                                    │
                  ▼                                    ▼
        ┌───────────────────┐                 ┌──────────────────┐
        │   PostgreSQL 16   │                 │  external vendors│
        │  data + queue +   │◀── NOTIFY ──┐   │  (one adapter    │
        │  pub-sub          │             │   │   each)          │
        └───────────────────┘             │   └──────────────────┘
                  └── LISTEN rvc_events ──┘ → SSE fan-out to browsers
```

## The monorepo

npm workspaces, Node 22, TypeScript 5.8 with `noUncheckedIndexedAccess`.

| Workspace | What lives there |
| --- | --- |
| `packages/shared` | The vocabulary: roles, trip statuses, `TRIP_STATE_MACHINE`, notification events and channels, `SETTING_KEYS`/`DEFAULT_SETTINGS`, `TEMPLATE_KEYS`, zod request schemas, and the DTO types both sides use |
| `apps/api` | Fastify API and the background worker, in one process by default |
| `apps/web` | React 18 SPA (Vite 6, Tailwind, shadcn/ui, TanStack Query), a PWA with a service worker |
| `tools/migrate` | The one-shot Base44 importer. See [MIGRATION.md](MIGRATION.md) |

The shared package is the reason a status the server refuses is a status the
client cannot offer: both import the same table. `packages/shared/src/domain.ts`
is the only file in the repository where a string literal for any of these
concepts is written. A new trip status, a new notification event or a new
template key is one edit in one file, and everything that consumes it — the
CHECK constraint in a migration, the client's button list, the template
renderer — is derived from or checked against it.

## Modular monolith, not services

The obvious alternative was an API service, a notification service and a worker
service. Rejected for three reasons specific to this system:

1. **The correctness of the whole product is one `UPDATE` statement.** Accepting
   a trip is a compare-and-set against `trips`. Split dispatch and notification
   into separate services and that statement has to coordinate over a network,
   which is how two volunteers end up driving to the same address.
2. **Every state change must be audited and notified in the same transaction.**
   `recordAudit()` and `notify()` both take an `Executor`, so they run inside
   the caller's transaction. A trip cannot be assigned without an audit row, and
   a notification cannot be queued for a change that rolled back. Across a
   service boundary this becomes an outbox, a retry policy and a reconciliation
   job — for an organisation running a few hundred trips a day.
3. **Somebody has to operate it.** This is a charity, not a platform team. One
   process, one database, one `fly deploy`.

The modularity that matters is enforced inside the process:

- `routes/` may not touch the database except through a `domain/` function.
- `domain/` may not know what a Twilio is; it calls `notify()`.
- `services/providers/` is the only place a vendor SDK is imported.

`RUN_WORKER_IN_PROCESS=false` plus `node dist/jobs/worker.js` splits the worker
onto its own machine with no code change, the day that becomes necessary. See
[DEPLOYMENT.md](DEPLOYMENT.md#when-to-split-the-worker-out).

## The dispatch engine is a declarative state machine

`TRIP_STATE_MACHINE` in `packages/shared/src/domain.ts` maps each of the ten
transitions to `{ from[], to, roles[], volunteerMustOwn, description }`. There
is deliberately no `PATCH /api/trips/:id { status }`. Each transition is its own
endpoint:

```
POST /api/trips/:id/offer             → offerTrip()
POST /api/trips/:id/assign            → assignTrip()
POST /api/trips/:id/claim             → claimTrip()
POST /api/trips/:id/reassign          → reassignTrip()
POST /api/trips/:id/en-route          → advanceTrip(…, 'start_en_route')
POST /api/trips/:id/start             → advanceTrip(…, 'start_trip')
POST /api/trips/:id/complete          → advanceTrip(…, 'complete')
POST /api/trips/:id/cancel            → cancelTrip()
POST /api/trips/:id/return-to-pending → returnToPending()
                                        expireOffer() — scheduler only
```

One endpoint per transition means "who may do this, from which state" is
answered by a table rather than inferred from a request body. A generic status
PATCH would put that logic in a switch statement every new state has to remember
to update, and would make the client's button list a guess.

Every function in `dispatch.service.ts` does the same six things inside a single
`db.transaction`:

```
1. loadTripForUpdate()            SELECT … FOR UPDATE
2. assertTransitionAllowed()      state legal? role allowed? does this
                                  volunteer actually own this trip?
3. validate inputs
4. atomic UPDATE
5. recordAudit(…, tx)
6. notify(…, tx) / enqueue(…, tx)
```

If step 5 throws, step 4 rolls back. There is no code path that produces a state
change which was neither audited nor notified.

### Why the claim is race-safe

Two volunteers tap Accept in the same 50ms. Both requests reach:

```sql
UPDATE trips
   SET status = 'accepted', assigned_volunteer_id = :volunteer,
       assigned_at = now(), accepted_at = now(), offer_expires_at = NULL
 WHERE id = :trip
   AND status = 'offered'
   AND assigned_volunteer_id IS NULL
   AND deleted_at IS NULL
RETURNING *;
```

One gets a row. The other gets zero rows, writes nothing, has its own offer
marked `superseded`, and is told `already_taken` — a real answer, not a silent
no-op. There is no read-then-write window to race inside, and nothing depends on
client behaviour. Three database constraints sit under it so a future code path
cannot reintroduce the bug: `trip_offers_one_accepted_uq`,
`trip_assignments_one_live_uq` and `trips_engaged_requires_volunteer_chk`
([DATABASE.md](DATABASE.md#invariants-the-database-enforces)).

Advisory locks or a Redis lock would work and would also be one more thing to be
wrong. A compare-and-set in the same transaction as the audit row is simpler and
strictly stronger.

### The offer window

`offerWindowMinutes()` reads one of three settings by priority, so "urgent" and
"emergency" are different words with different consequences rather than the same
escalation applied twice:

| Priority | Setting | Default |
| --- | --- | --- |
| `routine` | `dispatch.offer_window_minutes` | 30 minutes |
| `urgent` | `dispatch.urgent_offer_window_minutes` | 10 minutes |
| `emergency` | `dispatch.emergency_offer_window_minutes` | 5 minutes |

A broadcast also schedules one reminder at `dispatch.offer_reminder_minutes`
(default 10) to the same people with the same codes, and an escalation to
dispatchers at `min(dispatch.escalation_minutes, window)` — default 20 minutes,
capped by the window. Escalation is separate from expiry on purpose: dispatchers
hear about silence *before* the window closes, while there is still time to ring
somebody.

## Targeting: who is asked

`domain/targeting.ts` answers "who should be asked", and nothing else. It is not
an authorisation boundary — what a volunteer may see and do is enforced in the
service layer regardless of whether they were targeted.

The reason it exists is attention, not database load. The legacy system offered
every trip to every member of a group. That is affordable at 150 volunteers and
ruinous at 500: a volunteer asked forty times a week for rides she cannot do
stops reading the messages, and then misses the one she could have taken.

`evaluateCandidates()` runs one query over active, non-deleted users with
`role = 'volunteer'`, computing each filter as its own boolean column. Six hard
filters, in the order a dispatcher would apply them:

| # | Filter | Rule |
| --- | --- | --- |
| 1 | membership | a row in `user_groups` for this trip's group |
| 2 | service | opted in to the `service_types` row whose slug equals the trip's `trip_type`. If no active service row matches the trip type, this filter is skipped and a warning is logged, rather than excluding the whole roster |
| 3 | capability | the trip's `mobility_needs` (minus `none`) are contained in `users.capabilities`. No needs means everyone passes |
| 4 | availability | see below |
| 5 | conflict | not already assigned to another live trip (`assigned`/`accepted`/`en_route`/`in_progress`) whose pickup is within `CONFLICT_WINDOW_MINUTES` (90) of this one. The trip being offered is excluded from its own check |
| 6 | snooze | `users.muted_until` is null or in the past |

The availability rule is the one that deserves spelling out. A volunteer passes
if **any** of these hold — they have no `availability_rules` rows at all, or a
weekly rule covers the pickup's local weekday and minute-of-day, or a dated
`available` exception covers the instant — **and** no dated `unavailable`
exception covers it. Weekly rules are wall-clock windows in `ORG_TIMEZONE`
(`America/Toronto`), stored as minutes from local midnight.

*A volunteer with no availability rules is treated as available.* No rules on
file means "no stated restriction", which is availability, not unavailability.
The opposite reading would silently mute the entire roster on the day this
shipped, and the failure would look exactly like a quiet evening.

Everyone who fails a filter is returned in `excluded` with the reasons, not
discarded. The most common dispatcher question in the old system was "why didn't
he get it?" and the only way to answer it was to guess; each filter is a column
so the answer is a fact. When the eligible pool is empty, `offerTrip` tallies the
reasons and refuses with a sentence like *"Nobody can be offered this trip right
now — 4 not available at this time; 2 already on another trip at this time."*

**Ordering**, because who is asked first matters as much as who is asked:

1. the preferred volunteer (a standing ride's usual driver), then
2. familiarity — how many completed trips this volunteer has driven for this
   caller, descending, then
3. least recently offered (`users.last_offered_at`, ascending), then
4. name, so the order is stable.

`last_offered_at` is stamped when the offer is created, whether or not the
volunteer answers. That is what stops the same six names carrying the roster.
`dispatch.offer_batch_size` (default 40) caps how many are asked per round.

**Priority relaxes the filters rather than bypassing the mechanism.** A routine
trip applies all six. An urgent trip tries the strict pool first and, only if it
is empty, drops availability and snooze and records that on the offer round — a
wider pool is a real cost in interruption, paid only when the alternative is
nobody being asked. An emergency drops availability and snooze from the start. A
dispatcher who names volunteers explicitly (`volunteerIds`), or passes
`ignoreTargeting`, has already made the judgement that availability and snooze
exist to make, so the pool is restricted to those people and evaluated as though
the trip were an emergency. The remaining filters — group membership, service
opt-in, capability and the conflict check — still apply, because those are facts
about whether the person can do the job rather than about whether to disturb
them.

## Standing rides materialise into ordinary trips

A recurring ride is a *template plus a schedule*. It never dispatches.

`recurring.materialise` runs daily. `materialiseDueRides()` walks each active
ride's dates from today to `recurring.horizon_days` (default 14) ahead, and for
every date the recurrence covers that has no `recurring_ride_occurrences` row
yet, it calls the ordinary `createTrip()`. The resulting trip then goes through
the same state machine, targeting, offers, escalation and audit as every other
trip; `trips.recurring_ride_id` is provenance, not lifecycle state.

This is the decision that matters. Systems that give recurring work its own
pipeline end up with two dispatch paths that drift, and the second one is always
the one nobody tests. Here there is no second path — only a factory that
produces input for the first.

Idempotence is the database's job, not the caller's: a unique index on
(`recurring_ride_id`, `occurrence_date`) means a horizon that moves, a job that
runs twice, or a worker that dies mid-batch cannot produce the same ride twice.
A date that has already passed when the horizon expands is recorded as a skipped
occurrence with the reason, rather than creating a trip in the past.

Offering is separate from creating. `offerDueRecurringTrips()` offers a
materialised trip once `pickup_at - lead_time_minutes` has arrived (default lead
time 1440 minutes). A trip whose pickup falls inside Shabbos or yom tov — as
computed by `lib/hebcal.ts` for Montreal — is created but *not* offered, and the
occurrence records why. The software does not decide whether such a ride may
happen; a dispatcher does. It simply will not quietly text forty people about it.

## The notification path

Everything a person is told goes through one function: `notify()` in
`services/notification.service.ts`. It is called inside the transaction that made
the change it describes.

```
notify()  ──►  1 notifications row          the event
          ──►  N notification_deliveries    one per channel, the attempts
          ──►  N jobs ('notification.deliver', dedupe delivery:<id>)
                    │
worker    ──────────┴──► deliverNotification() ──► provider
```

Three properties the previous implementation lacked:

- **It is recorded.** "Did she get the offer?" is a query against
  `notification_deliveries`, not a guess.
- **It never silently succeeds.** Sending happens in a background job. A failure
  writes the provider's error onto the row and, once attempts reach
  `notifications.max_attempts` (default 5), sets `status='failed'` where the
  admin screen and `GET /api/ops/health` surface it.
- **It never silently drops.** A channel with nowhere to send is written as
  `skipped` with a reason — "no phone number on file", "no push subscription
  registered", "no email address on file" — because that is an operational fact
  somebody needs to see.

Retries use exponential backoff from `notifications.retry_backoff_seconds`
(default 30), doubling per attempt. The send itself is bounded by a 10-second
timeout, so a hung provider cannot hold a worker slot open.

**Channel selection** follows `users.notification_preference`, with `inapp`
always added: it is free, it never fails, and it makes the in-app feed complete
rather than a partial mirror of the SMS. `none` therefore means "no push or
text", not "no notification".

| Preference | Channels |
| --- | --- |
| `sms` | sms, inapp |
| `push` | push, inapp |
| `whatsapp` | whatsapp, **push**, inapp |
| `email` | email, inapp |
| `both` | sms, push, inapp |
| `all` | sms, push, whatsapp, email, inapp |
| `none` | inapp |

**WhatsApp is never the sole carrier.** A paired WAHA session can drop without
warning — the phone goes flat, WhatsApp logs the device out — and the send
either fails or appears to succeed while nothing arrives. An offer that silently
fails to send is a volunteer who was never asked, so the `whatsapp` preference
pairs it with push, and offers force SMS and push regardless of preference
(`forceChannels: ['sms','push']`).

**Critical events bypass snooze and preference.** Any event in
`CRITICAL_NOTIFICATION_EVENTS` — `trip.assigned`, `trip.reassigned`,
`trip.cancelled`, `volunteer.application_approved`,
`volunteer.application_rejected`, `volunteer.invitation` — gets SMS added if it
is not already there. Muting is how somebody says "stop offering me trips this
evening"; it is not how they say "do not tell me the trip I accepted has been
cancelled". Treating those as the same thing is how a volunteer drives to a
hospital for a passenger who is no longer there. Snooze is honoured where it
belongs: in targeting (offers) and in announcement audiences.

Message text is not inlined at the call sites. `services/templates.service.ts`
renders a `message_templates` row by key and channel, falling back to the
compiled-in default in `services/template-defaults.ts` when no row exists —
which is correct behaviour, not an error, because a message must still go out if
somebody deactivated its row. Rendering is `{{variable}}` substitution and
nothing else: no conditionals, no loops, no expressions. An administrator editing
an SMS should not be able to write something that throws inside a background job
at 2am, and a template language is a code-execution surface pointed at the
notification path. A line whose placeholders all resolved to nothing, and whose
remaining text is only a label, is dropped — otherwise `Needs: {{needs}}` sends
a bare "Needs:" on every routine offer forever.

Two notification paths deliberately sit outside `notify()`: messages to
volunteer *applicants*, and reminders to equipment *borrowers*. Neither has a
`users` row, and `notification_deliveries` is keyed on one. Adding a nullable
user column to the delivery table would make "who was this sent to?"
unanswerable for every row; instead those sends go straight to the provider and
the attempt is recorded in `audit_events`.

## The provider boundary

`services/providers/types.ts` defines the interfaces; `providers/index.ts` is the
only file that decides which implementation is live.

| Interface | Live implementation | Fallback |
| --- | --- | --- |
| `SmsProvider` | `twilio.ts`, when all three `TWILIO_*` are set | `inmemory.ts` in development and test |
| `PushProvider` | `webpush.ts` (VAPID) | `inmemory.ts` |
| `CallingProvider` | `twilio.ts` | `inmemory.ts` |
| `EmailProvider` | `email.ts` — SMTP via nodemailer, when `EMAIL_PROVIDER=smtp` and `SMTP_HOST` is set | `inmemory.ts` |
| `WhatsAppProvider` | `waha.ts` — the organisation's existing WAHA server, when `WAHA_BASE_URL` is set | `inmemory.ts` |
| `GeocodingProvider` | `nominatim.ts`, always, proxied server-side | — |
| `ObjectStore` | `objectstore.ts` — local filesystem, or S3-compatible when `FILE_STORAGE_DRIVER=s3` | in-memory store in test |
| `LicenceVerificationProvider` | `licence-verification.ts` HTTP client, when `LICENCE_VERIFICATION_PROVIDER=http` and a URL is set | the **null provider**, which is the default |

What the indirection buys:

- **Tests and local development are real.** In `test` and `development` the
  in-memory providers are selected, so the whole offer → SMS → reply → claim path
  runs with no account, no credit and no network. `providers/inmemory.ts` exports
  `captured` and `faults` so a test can assert what was sent and inject failures.
- **Leaving a vendor is one file.** The Twilio SDK appears in `providers/twilio.ts`
  and nowhere else. Email is SMTP rather than a vendor SDK precisely because it is
  the channel most likely to be switched: Google Workspace, Postmark, SES and a
  shared host are all four environment variables apart.
- **Signature validation is part of the interface.** `validateWebhookSignature`
  is a method on the provider, not a helper somebody might forget to call.
- **The honest default is a first-class implementation.** The null licence
  verifier is not a degraded mode. No public API exposes Quebec licence validity;
  anything that claims to is a paid identity vendor with a contract behind it, or
  a lie. So the default returns `status: 'unsupported'`, always, and does not
  inspect the number or guess from its format. See
  [SECURITY.md](SECURITY.md#driver-licences-what-the-system-does-not-do).

The interfaces are narrow on purpose — `send(to, body)`, not "here is a Twilio
message object". A provider that cannot be described in three methods is a
provider you have coupled to.

S3 is implemented directly against the REST API with SigV4 rather than through
the AWS SDK: it needs four operations, the SDK is a large dependency, and a
signing routine you can read is easier to reason about than a vendor client you
cannot.

## The job queue and the scheduler

Background work runs on a `jobs` table, claimed with:

```sql
WITH claimed AS (
  SELECT id FROM jobs
   WHERE status = 'pending' AND run_at <= now()
   ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT :n
)
UPDATE jobs j SET status='running', locked_at=now(), locked_by=:worker,
                  attempts = j.attempts + 1
  FROM claimed c WHERE j.id = c.id RETURNING …
```

**Why not Redis/BullMQ/SQS:** the database is already the system of record,
already has to be available, and already has to be backed up. A queue adds a
second thing that can be down, a second thing to back up, a second set of
credentials, and a new class of bug — a job that references a row the
transaction rolled back. Here `enqueue()` takes the caller's transaction, so a
job for a change that did not commit does not exist. `SKIP LOCKED` gives safe
multi-worker claiming, and the partial unique index on `dedupe_key` makes
at-most-once scheduling declarative.

Failures back off exponentially (`2^attempts × 5` seconds, capped at one hour)
and land in `status='dead'` after `max_attempts` (default 10), where
`GET /api/ops/health` counts them. Nothing retries forever and nothing
disappears. Jobs left `running` by a worker that died are reclaimed after ten
minutes by housekeeping.

**The scheduler is the dedupe key.** There is no cron, no leader election and no
extra container. Every five minutes the worker's housekeeping pass enqueues the
recurring work with a key that encodes the period:

| Job | Dedupe key | Effect |
| --- | --- | --- |
| `cleanup.sessions`, `cleanup.tokens`, `cleanup.retention` | fixed (`cleanup:sessions`, …) | at most one outstanding at a time |
| `recurring.materialise` | `recurring:<local date>` | once per day |
| `equipment.due_scan` | `equipment-due:<local date>` | once per day |
| `licence.expiry_scan` | `licence-expiry:<local date>` | once per day |
| `duty.reminder_scan` | `duty-reminder:<15-minute slot>` | every 15 minutes |

Because the unique index covers `dedupe_key` where the status is
`pending`/`running`, a second API machine enqueueing the same key inserts
nothing. Two machines cannot both materialise the same standing ride, and
neither has to believe it is the leader. `completeJob` clears the dedupe key so
the next period's key is free.

Per-item keys work the same way: `offer-expire:<offerId>`,
`trip-reminder:<tripId>:<round>`, `trip-escalate:<tripId>:<round>`,
`delivery:<deliveryId>`, `announcement:<id>`. A re-broadcast cannot
double-schedule an expiry and so cannot expire a later round's offer early.

The full set of job kinds is `JOB_KINDS` in `domain.ts`; the handler map is
`jobs/handlers/index.ts`.

The cost is honest: polling (`WORKER_POLL_MS`, default 2000) means up to two
seconds of latency before an SMS goes out, and the queue does not scale to
millions of jobs a day. At a few thousand, it is free.

## Conversations

An inbound SMS that is not a command is a person talking. The legacy webhook
understood four words — YES, Y, ACCEPT and a four-digit code — and threw
everything else into a table nobody read: "I can do it but I'll be ten minutes
late", "she isn't ready, can you push it an hour", "wrong number, please stop
texting me". Those are conversations, and the organisation was having them
without knowing.

`domain/conversations.service.ts` models a **queue, not an inbox**. A thread has
a status (`open`/`snoozed`/`closed`), an owner, and an unread count. One live
thread per phone number — a second conversation with the same person is the same
conversation — enforced by a partial unique index on `sms_threads (phone) WHERE
status <> 'closed'`. Identity is resolved once, when the thread is created:
volunteer first, then caller, then unknown, so the console shows a name rather
than digits.

A message arriving within seven days of a thread being closed reopens that
thread rather than starting a new one; "thanks, that worked" belongs with the
exchange it answers. After a week it is a new subject and gets its own thread, so
the queue does not accumulate one endless conversation per number.

The thread's counters are maintained by a database trigger
(`sms_messages_touch_thread`), not by whichever code path inserted the message —
which is also what makes an inbound message reopen a closed thread. Silence from
our side is not consent to stop listening.

Replies take two paths for one reason. A thread belonging to a known volunteer
goes through `notify()` with `forceChannels: ['sms']`, so it gets a delivery
record, retries and failure visibility like everything else, and the outbound
message row is written only once the send succeeded — the console never shows a
reply that did not leave. A thread belonging to a caller or an unknown number has
no user row to notify, so it is sent directly and the outcome is written onto the
message.

Conversations are dispatcher-and-above throughout. They contain callers' words
about their own medical appointments.

## Realtime: LISTEN/NOTIFY → SSE

A trigger on `trips` (migration 0001) calls `pg_notify('rvc_events', …)` with a
small JSON payload: type, op, trip id, status, group id, assigned volunteer id.
The API holds **one** dedicated listener connection (`routes/events.routes.ts`)
and fans out to browsers over Server-Sent Events at `GET /api/events/stream`,
with a comment heartbeat every 25 seconds.

**Why not websockets:** the traffic is one-directional — the server tells the
browser something changed. SSE is a `GET` with a `text/event-stream` body; it
reconnects itself, survives proxies, needs no subprotocol and no second server.
**Why not polling:** a dozen dispatcher tabs polling every three seconds is
hundreds of thousands of queries a day to discover that nothing happened, and
still shows an acceptance three seconds late.

Two rules make this safe:

- **The payload carries no trip content.** Ids and a status only. It is a signal
  to refetch through the normal access-controlled endpoint, not a second,
  unscoped way to read data.
- **The stream is filtered per subscriber.** A volunteer receives events only for
  trips in their groups or assigned to them, so the signal itself does not leak
  the existence of other groups' work.

The limitation to know: each API process holds its own LISTEN connection, and
`pg_notify` reaches every listener, so this scales with the number of API
machines, not the number of browsers.

## The read model: TripDto and OfferedTripDto

`domain/trips.query.ts` is the only read path for trips, and it scopes in SQL —
never in the browser. A volunteer's query is constrained by their user id and
group membership before it reaches the database. The legacy client downloaded the
200 most recent trips, with every caller's name, phone number, home address and
medical notes, and hid the ones you were not supposed to see with a JavaScript
filter.

There are two projections:

**`TripDto`** — the full record: caller name and phone, callback number, exact
pickup and dropoff including unit and address notes, passenger notes, the
assigned volunteer, offer counts, timestamps, `version`, and
`availableTransitions` computed from the state machine so the client renders
exactly the buttons the server will accept.

**`OfferedTripDto`** — the pre-claim projection. Reference, status, priority,
trip type, `pickupArea` and `dropoffArea` (the street line with the leading house
number stripped, plus the city), pickup time, appointment time, mobility needs,
and the volunteer's own offer with its expiry. No caller name, no phone number,
no exact address, no passenger notes, no indication of who else was asked.

Which one you get is decided server-side by `getTrip()`:

- a dispatcher or admin always gets `TripDto`;
- a volunteer assigned to the trip gets `TripDto`;
- a volunteer holding a live pending offer gets `OfferedTripDto`;
- anyone else gets a 404, not a 403 — the existence of the trip is itself
  information.

This is the projection to defend. A broadcast goes to dozens of people and most
of them will not take the trip; they do not need to know that the person at 1234
Avenue Bernard has a dialysis appointment on Thursday afternoon and will not be
home. The area is enough to judge the journey. Full detail arrives in the
confirmation, to one person.

List scopes work the same way. `board` is refused outright to volunteers;
`mine` is constrained to `assigned_volunteer_id = me`; `history` is constrained
the same way for non-dispatchers; `available` requires an actual pending,
unexpired `trip_offers` row — group membership alone is not enough. Search is
narrower for volunteers too: a dispatcher can search caller name, phone and
addresses, a volunteer can search only the trip reference. Paging is by an
opaque keyset cursor over `(pickup_at, id)`, so there is no offset scan and no
unbounded read anywhere in the codebase.

## What is deliberately not here

- **No caching layer.** The board is a single indexed query. Add Redis when a
  profile says to, not before.
- **No event sourcing.** `audit_events` is an append-only log of what happened
  and `trip_assignments` preserves assignment history, which answers every
  question anyone has actually asked, without making the current state a fold.
- **No GraphQL.** Fourteen route files, one consumer.
- **No feature flags.** Operational policy that needs tuning lives in the
  `settings` table and is changed by an admin at runtime, not by a deploy.
- **No template language.** See above — `{{var}}` and nothing else.
- **No second dispatch pipeline** for recurring rides, bulk operations or
  standing work. Everything becomes a trip and goes through the same engine.
- **No client-side authorisation.** `RouteGuards.tsx` exists so people do not
  see a page that will refuse them; it is not a control. See
  [SECURITY.md](SECURITY.md).
