# API reference

Every route in `apps/api/src/routes/`, grouped by file. The **Who** column is
the `preHandler` guard on the route, from `auth/guards.ts`:

| Guard | Means |
| --- | --- |
| *public* | no guard — anyone, signed in or not |
| `requireAuth` | any signed-in user |
| `requireDispatcher` | `dispatcher` or `admin` |
| `requireAdmin` | `admin` only |

A route-level guard is the coarsest check, never the only one. Object-level
authorisation — does *this* person own *this* record, and may the trip make
*this* transition — is enforced inside the domain function, and reads are
projected differently by role. See [SECURITY.md](SECURITY.md).

## Conventions

- **Requests and responses are JSON.** Request bodies and query strings are
  parsed with zod schemas from `@rvc/shared`; a failure is `422` with
  `{ error: { code: 'validation_failed', message, details[], requestId } }`.
- **One error shape** everywhere: `{ error: { code, message, details?,
  requestId } }`. `401` unauthorized, `403` forbidden, `404` not found, `409`
  conflict or `stale_state`, `422` validation, `429` rate limited, `500`
  internal. Messages on `AppError` are written for humans and safe to show.
- **Existence is information.** A trip a volunteer may not see returns `404`,
  not `403`.
- **Authentication is the `rvc_session` cookie**, `httpOnly`. There is no bearer
  token and no API key.
- **Global rate limit** 300/minute keyed by user id, or IP when anonymous;
  `/webhooks/*` is exempt and authenticated by Twilio signature instead. Tighter
  per-route limits are noted below.
- **Global body limit** 1MB, raised to 14MB on the two licence-upload routes.
- **List endpoints are bounded** — every one has a validated `limit` (maximum
  200–500). Trip listing pages with an opaque `cursor`, not an offset.
- There is **no `PATCH /api/trips/:id { status }`**. Each state transition is its
  own endpoint; see [ARCHITECTURE.md](ARCHITECTURE.md#the-dispatch-engine-is-a-declarative-state-machine).

---

## Health

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/health` | *public* | Liveness. Runs `select 1`; returns `200 {status:'ok'}` or `503 {status:'degraded'}` when the database is unreachable |

---

## Authentication — `auth.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | *public* | Signs in and sets the session cookie. 10 per 5 minutes. Identical failure for unknown address, wrong password and deactivated account |
| POST | `/api/auth/logout` | *public* | Revokes the current session server-side and clears the cookie |
| GET | `/api/auth/me` | *public* (401 without a session) | The signed-in user, their role and their groups |
| POST | `/api/auth/change-password` | `requireAuth` | Changes the password after checking the current one, revokes every other session, and issues a fresh cookie for this one |
| POST | `/api/auth/accept-invite` | *public* | Redeems a single-use invite token: sets the name, phone and password, activates the account and signs in. 10 per 10 minutes |
| POST | `/api/auth/request-password-reset` | *public* | Issues a 60-minute reset token. **Always** returns `{ok:true}`, whether or not the address exists. 5 per 15 minutes |
| POST | `/api/auth/reset-password` | *public* | Redeems a reset token, sets the password and revokes every session. 10 per 15 minutes |

---

## Trips — `trips.routes.ts`

### Reading

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/trips` | `requireAuth` | Lists trips in one of four scopes — `board` (dispatchers only), `mine`, `available` (trips this volunteer holds a live offer for), `history` — with optional status, group, search and date filters. Volunteers get the pre-claim projection for `available`; the scope itself is constrained in SQL. Keyset paging via `cursor`/`nextCursor` |
| GET | `/api/trips/summary` | `requireDispatcher` | Board counters: needing attention, offered, assigned, in progress, overdue, unanswered |
| GET | `/api/trips/:id` | `requireAuth` | One trip. Dispatchers and the assigned volunteer get the full record; a volunteer holding a live offer gets the pre-claim projection; anyone else gets 404 |
| GET | `/api/trips/:id/history` | `requireDispatcher` | The trip's audit trail |
| GET | `/api/trips/:id/eligible-volunteers` | `requireDispatcher` | Active non-dispatcher members of the trip's group, for the direct-assign picker |

### Writing

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/trips` | `requireDispatcher` | Creates a trip. Allocates the reference, inserts both addresses, resolves or creates the caller, and remembers the addresses against them |
| PATCH | `/api/trips/:id` | `requireDispatcher` | Edits a trip. Optimistic concurrency on `version`; a stale write is refused with `409 stale_state` |
| DELETE | `/api/trips/:id` | `requireDispatcher` | Archives (soft-deletes) a trip from a terminal state, with a reason |

### Transitions

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/trips/:id/offer` | `requireDispatcher` | Broadcasts. Runs targeting, creates a `trip_offers` row and a unique code per recipient, notifies them, schedules the reminder, escalation and per-offer expiry. Returns how many were offered, the expiry, the round, and everyone skipped with the reason |
| POST | `/api/trips/:id/assign` | `requireDispatcher` | Assigns a named volunteer directly |
| POST | `/api/trips/:id/reassign` | `requireDispatcher` | Moves the trip to a different volunteer, closing the previous assignment row with a reason |
| POST | `/api/trips/:id/claim` | `requireAuth` | Accepts an offer on this trip. Atomic; exactly one caller wins. A loser gets `409` with `already_taken`, `expired`, `not_your_offer` or `unknown_code` |
| POST | `/api/offers/accept` | `requireAuth` | Accepts by code alone, for the SMS and push deep link where the trip id is not known |
| POST | `/api/trips/:id/en-route` | `requireAuth` | Volunteer is on the way. Volunteers may only do this for their own trip |
| POST | `/api/trips/:id/start` | `requireAuth` | Passenger aboard / delivery under way |
| POST | `/api/trips/:id/complete` | `requireAuth` | Finished. Closes the live assignment row |
| POST | `/api/trips/:id/cancel` | `requireAuth` | Cancels, with a required reason. A volunteer may cancel only their own trip |
| POST | `/api/trips/:id/return-to-pending` | `requireDispatcher` | Pulls the trip back to the queue without cancelling it |

---

## Bulk, duplication and the board — `ops.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/trips/bulk/assign` | `requireDispatcher` | Assigns many trips to one volunteer. Each trip is processed independently and the response reports per-trip success or the error |
| POST | `/api/trips/bulk/offer` | `requireDispatcher` | Broadcasts many trips, same per-trip reporting |
| POST | `/api/trips/:id/duplicate` | `requireDispatcher` | Copies what describes the journey into a new `pending` trip with its own reference and no history. Optionally overrides pickup time, priority and notes |
| GET | `/api/board/context` | `requireDispatcher` | Everything the board shows beside the trips: who is on duty now, unread conversations, application counts, overdue equipment, the coming week's rest periods, today's Hebrew date and zmanim |

---

## Callers — `callers.routes.ts`

Dispatcher-and-above throughout; every search and profile read is audited.

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/callers/search` | `requireDispatcher` | Finds a caller by exact-E.164 phone or by name, with trip count and last trip. Writes a `caller.searched` audit row |
| GET | `/api/callers` | `requireDispatcher` | Lists callers, paged by `limit`/`offset` |
| GET | `/api/callers/:id` | `requireDispatcher` | One caller with their saved addresses and ride history. Audited |
| POST | `/api/callers` | `requireDispatcher` | Creates a caller |
| PATCH | `/api/callers/:id` | `requireDispatcher` | Edits a caller |
| POST | `/api/callers/:id/addresses` | `requireDispatcher` | Saves an address against a caller, with entrance, parking and label |
| DELETE | `/api/callers/:id/addresses/:addressId` | `requireDispatcher` | Removes a saved address (soft delete) |

---

## Standing rides — `recurring.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/recurring-rides` | `requireDispatcher` | Lists standing rides, optionally by status |
| GET | `/api/recurring-rides/:id` | `requireDispatcher` | One standing ride with its upcoming dates and materialised occurrences |
| POST | `/api/recurring-rides` | `requireDispatcher` | Creates one. Rejects a schedule that could never produce a date |
| PATCH | `/api/recurring-rides/:id` | `requireDispatcher` | Edits it |
| POST | `/api/recurring-rides/:id/end` | `requireDispatcher` | Ends it, optionally cancelling occurrences already on the board |
| POST | `/api/recurring-rides/materialise` | `requireDispatcher` | Runs the materialiser now instead of waiting for the daily job. Idempotent |

---

## Conversations — `conversations.routes.ts`

Dispatcher-and-above throughout.

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/conversations` | `requireDispatcher` | The queue, filterable by status and by `mine`, with the unread total |
| GET | `/api/conversations/:id` | `requireDispatcher` | One thread and its messages. Opening it marks it read |
| POST | `/api/conversations/:id/reply` | `requireDispatcher` | Sends an SMS reply (max 1200 characters). A volunteer thread goes through the delivery pipeline; a caller or unknown number is sent directly |
| POST | `/api/conversations/:id/claim` | `requireDispatcher` | Takes ownership, so two dispatchers do not answer the same person |
| POST | `/api/conversations/:id/release` | `requireDispatcher` | Gives it back to the queue |
| POST | `/api/conversations/:id/status` | `requireDispatcher` | Sets `open`, `snoozed` or `closed` |
| POST | `/api/conversations/:id/attach` | `requireDispatcher` | Pins the thread to a trip, or unpins it |

---

## Volunteer self-service and administration — `volunteers.routes.ts`

### Catalogue and the volunteer's own record

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/services` | `requireAuth` | The active service types a volunteer can opt in to |
| GET | `/api/me/availability` | `requireAuth` | This volunteer's weekly windows and dated exceptions |
| PUT | `/api/me/availability` | `requireAuth` | Replaces the weekly grid wholesale. An empty list means "no stated restriction", i.e. always available, and the response says so |
| POST | `/api/me/availability/exceptions` | `requireAuth` | Adds a dated `unavailable` or `available` override |
| DELETE | `/api/me/availability/exceptions/:id` | `requireAuth` | Removes one of their own exceptions |
| GET | `/api/me/services` | `requireAuth` | Which services they have opted in to |
| PUT | `/api/me/services` | `requireAuth` | Sets the complete opt-in list |
| GET | `/api/me/capabilities` | `requireAuth` | Wheelchair, stretcher, walker, oxygen, attendant |
| PUT | `/api/me/capabilities` | `requireAuth` | Sets them |
| GET | `/api/me/id-card` | `requireAuth` | The ID card: name, volunteer number, groups, services, member-since, and the opaque verification code for the QR. Assigns the number and token on first use |
| GET | `/api/me/licence` | `requireAuth` | Their licence record — status, expiry, last four characters. Never the number |
| PUT | `/api/me/licence` | `requireAuth` | Uploads front and/or back images and the number. Body limit 14MB. Stores the images encrypted, the number encrypted, and replies with a note that nothing has been verified automatically |

### Public

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/id-card/verify/:token` | *public* | Card check for a hospital reception desk. Answers valid/not valid plus the name, volunteer number and organisation — nothing else. An unknown token and a deactivated volunteer are indistinguishable |

### Administration

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/licences/pending` | `requireAdmin` | Licences awaiting review |
| POST | `/api/licences/:id/review` | `requireAdmin` | Records `on_file` ("I have looked at this") or `rejected`. **Cannot** record `verified` |
| POST | `/api/licences/:id/verify` | `requireAdmin` | Asks the configured verification provider. With none configured it changes nothing and returns `unsupported` |
| GET | `/api/files/:id` | `requireAdmin` | Serves one stored file. Takes a `reason` query parameter that goes into the audit row; verifies the SHA-256 before serving; `cache-control: no-store, private` |

### A dispatcher acting for a volunteer

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/volunteers/:id/availability` | `requireDispatcher` | Reads somebody else's availability |
| PUT | `/api/volunteers/:id/availability` | `requireDispatcher` | Sets it during a phone call. Audited with the dispatcher as actor |
| PUT | `/api/volunteers/:id/services` | `requireDispatcher` | Same, for service opt-ins |
| PUT | `/api/volunteers/:id/capabilities` | `requireDispatcher` | Same, for capabilities |
| GET | `/api/volunteers/overview` | `requireDispatcher` | The consolidated roster screen in one query: identity, groups, services, capabilities, snooze, availability-rule count, completed and open trips, last trip, licence status. Filterable by search, group, service and status |
| GET | `/api/volunteers/:id/card` | `requireDispatcher` | Builds a volunteer's ID card, for reprinting |

---

## Applications — `applications.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/public/signup-options` | *public* | The services and groups an applicant may choose, plus the current consent text and its version. 403 when `PUBLIC_SIGNUP_ENABLED=false` |
| POST | `/api/public/volunteer-applications` | *public* | Submits an application. The only unauthenticated write in the API: per-IP limit (`SIGNUP_MAX_PER_IP_PER_HOUR`, default 5/hour), a honeypot field, a minimum form-completion time, and nothing it writes reaches the dispatch system without approval. Returns the same acknowledgement for a duplicate as for a new application |
| POST | `/api/public/volunteer-applications/:reference/licence` | *public* | Attaches licence images to an application that is still open, addressed by its reference because the applicant has no session. Body limit 14MB, 10 per hour. Returns nothing about the application |
| GET | `/api/applications` | `requireDispatcher` | The review queue, by status, with counts per status |
| GET | `/api/applications/:id` | `requireDispatcher` | One application in full. Audited |
| POST | `/api/applications/:id/request-info` | `requireDispatcher` | Asks the applicant for more detail and messages them |
| POST | `/api/applications/:id/reject` | `requireAdmin` | Rejects, with notes and an optional message to the applicant |
| POST | `/api/applications/:id/approve` | `requireAdmin` | **The trust boundary.** In one transaction creates the user, their groups, services and availability, assigns the volunteer number, moves any licence across, stamps the application converted, and issues a 7-day invite |

---

## Calls — `calls.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/calls` | `requireAuth` | Places a masked call by naming a *relationship* (`caller`, `volunteer` or `contact`), never a number. 20 per 5 minutes plus `calling.daily_limit_per_user`. Rings the initiator first |
| GET | `/api/calls` | `requireAuth` | The call log. A volunteer sees only calls they placed; dispatchers see all. Numbers appear as `••• 0142` |

---

## Message templates, duty, calendar, exports, announcements, equipment — `ops.routes.ts`

### Templates

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/templates` | `requireAdmin` | Every message template, by key, channel and locale |
| GET | `/api/templates/:id` | `requireAdmin` | One template with its version history |
| PATCH | `/api/templates/:id` | `requireAdmin` | Edits the subject or body. The previous version is kept by a database trigger. Refuses a template referencing a variable nothing supplies, and an SMS body long enough to be expensive |
| POST | `/api/templates/:id/revert` | `requireAdmin` | Restores a previous version — itself recorded as a new version |

### Duty roster

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/duty` | `requireAuth` | Shifts in a date range (default the next 28 days), plus who is on phone duty right now |
| POST | `/api/duty` | `requireDispatcher` | Books a shift. Overlap for the same kind is refused by a database exclusion constraint, and the error names who already has it |
| DELETE | `/api/duty/:id` | `requireDispatcher` | Removes a shift (soft delete), freeing the slot |

### Calendar

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/calendar/zmanim` | `requireAuth` | Montreal zmanim for a date |
| GET | `/api/calendar/hebrew` | `requireAuth` | Hebrew dates and holidays over a range of days |
| GET | `/api/calendar/rest-periods` | `requireAuth` | Shabbos and yom tov boundaries for the next N days (default 14, max 60). Information for the board, not enforcement — the software does not refuse a trip in that window |

### Exports

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/exports` | `requireDispatcher` | Export requests. A dispatcher sees their own; an admin sees all |
| POST | `/api/exports` | `requireDispatcher` | Requests an export (`trips`, `volunteers`, `monthly_board`, `equipment_loans`, `audit`, `notification_deliveries`). Returns `202`; the file is produced by a background job and expires after 7 days |
| GET | `/api/exports/:id/download` | `requireDispatcher` | Downloads the CSV. Refuses an export that is not `ready`, and refuses somebody else's unless you are an admin. The download is audited separately from the request |

### Announcements

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/announcements/preview` | `requireDispatcher` | Resolves an audience and returns the recipient count, the ceiling, whether it is over, and ten sample names. Deliberately dispatcher-readable even though only an admin may send |
| GET | `/api/announcements` | `requireDispatcher` | Recent announcements and their outcomes |
| POST | `/api/announcements` | `requireAdmin` | Creates a draft. Refuses an audience above `announcements.max_recipients` |
| POST | `/api/announcements/:id/send` | `requireAdmin` | Sends, but only if `confirmRecipientCount` still matches the resolved audience. Queues the fan-out to the worker |

### Equipment operations

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/equipment/scan/:code` | `requireDispatcher` | Resolves a scanned barcode or a typed item code to one item, with its open loan if any |
| POST | `/api/equipment/labels` | `requireDispatcher` | Label data for up to 100 items |
| GET | `/api/equipment/overdue` | `requireDispatcher` | Loans past their return date, with days overdue |
| POST | `/api/equipment/loans/:id/confirm-sms` | `requireDispatcher` | Texts the borrower a confirmation of what they have and when it is due |
| GET | `/api/equipment/barcode-for/:itemCode` | `requireDispatcher` | The barcode value for an item code |

---

## Roster, self-service and push — `users.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/users` | `requireAuth` | The roster, filterable by role, group, status and name. **Email and phone are nulled for non-dispatch roles** |
| POST | `/api/users` | `requireAdmin` | Creates an account and returns the invite URL for the administrator to pass on |
| PATCH | `/api/users/:id` | `requireDispatcher` | Edits a roster record. Only an admin may change `status` |
| POST | `/api/users/:id/role` | `requireAdmin` | Changes a role. Revokes every session of theirs; refuses to demote the last active admin |
| POST | `/api/users/:id/deactivate` | `requireAdmin` | Deactivates with a required reason: soft-deletes, rewrites the email, nulls the phone, revokes every session and deletes outstanding tokens. Refuses while they still have live trips |
| POST | `/api/users/:id/resend-invite` | `requireAdmin` | Issues a fresh 7-day invite and returns the URL |
| PATCH | `/api/me` | `requireAuth` | Edits own profile |
| GET | `/api/me/impact` | `requireAuth` | Own record: completed trips, this month, upcoming, volunteering-since, and recent trips |
| POST | `/api/me/mute` | `requireAuth` | Snooze for N hours, or 0 to clear it. Suppresses offers, never critical notifications |
| GET | `/api/me/status` | `requireAuth` | Own snooze state |
| GET | `/api/push/public-key` | *public* | The VAPID public key the browser subscribes with, so client and server can never diverge |
| POST | `/api/push/subscribe` | `requireAuth` | Registers a browser push subscription; re-subscribing updates in place and re-enables a disabled endpoint |
| POST | `/api/push/unsubscribe` | `requireAuth` | Removes one of their own subscriptions |
| GET | `/api/groups` | `requireAuth` | Active volunteer groups |
| GET | `/api/directory` | `requireAuth` | The volunteer directory, with contact details only for dispatch roles |

---

## Supporting records — `misc.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/addresses/search` | `requireDispatcher` | Geocoder lookup, proxied server-side so no browser ever talks to Nominatim. 120 per minute |
| GET | `/api/contacts` | `requireDispatcher` | The organisation's phone book |
| POST | `/api/contacts` | `requireDispatcher` | Adds a contact |
| PATCH | `/api/contacts/:id` | `requireDispatcher` | Edits one |
| DELETE | `/api/contacts/:id` | `requireDispatcher` | Soft-deletes one, so call logs referencing it stay readable |
| GET | `/api/vehicles` | `requireAuth` | The organisation's vehicles |
| POST | `/api/vehicles` | `requireDispatcher` | Adds one |
| PATCH | `/api/vehicles/:id` | `requireDispatcher` | Edits one |
| DELETE | `/api/vehicles/:id` | `requireDispatcher` | Soft-deletes one |
| GET | `/api/equipment/categories` | `requireAuth` | Equipment categories |
| POST | `/api/equipment/categories` | `requireDispatcher` | Adds a category |
| GET | `/api/equipment` | `requireAuth` | Equipment, filterable by status and category |
| POST | `/api/equipment` | `requireDispatcher` | Adds an item |
| POST | `/api/equipment/:id/loan` | `requireDispatcher` | Lends an item. Refuses an item that is not `available`; a partial unique index makes a double loan impossible |
| POST | `/api/equipment/:id/return` | `requireDispatcher` | Closes the open loan and returns the item to `available`, optionally recording its condition |
| GET | `/api/equipment/loans` | `requireDispatcher` | Loans, open by default |
| GET | `/api/organization` | `requireAuth` | Organisation name, phone, email and address, as used in outbound messages |
| PUT | `/api/organization` | `requireAdmin` | Updates them |

---

## Audit, notifications, settings and ops health — `admin.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/audit` | `requireDispatcher` | Searches the audit log by entity, actor, action and date. Read-only by construction: the table rejects writes |
| GET | `/api/notifications/deliveries` | `requireDispatcher` | Delivery attempts by status, with 24-hour totals for delivered, queued, failed and skipped |
| GET | `/api/notifications` | `requireAuth` | The caller's own in-app notification feed |
| POST | `/api/notifications/read` | `requireAuth` | Marks their own notifications read — a list of ids, or all of them |
| GET | `/api/sms-events` | `requireDispatcher` | The inbound and outbound SMS log, including rejected webhooks |
| GET | `/api/settings` | `requireDispatcher` | Current settings and the compiled-in defaults |
| PUT | `/api/settings/:key` | `requireAdmin` | Changes one setting. Refuses a key that is not in `DEFAULT_SETTINGS` |
| GET | `/api/ops/health` | `requireDispatcher` | Job counts (`pending`, `running`, `overdue`, `dead`) and 24-hour delivery health. The first thing to open in an incident |

---

## Realtime — `events.routes.ts`

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/events/stream` | `requireAuth` | Server-Sent Events. Emits a small `trip` event — ids and status, never trip content — whenever a trip changes, so the client refetches through the normal access-controlled endpoints. Filtered per subscriber: a volunteer receives events only for their groups or their own trips. Heartbeat every 25 seconds, `retry: 5000` |

---

## Twilio webhooks — `webhooks.routes.ts`

Not under `/api`. Exempt from the global rate limit and authenticated by HMAC
signature instead: **the signature is validated before any field of the body is
read**, and an unsigned request is recorded in `sms_events` and answered `403`
with no TwiML.

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/webhooks/twilio/sms` | *Twilio signature* | Inbound SMS. Handles `YES <code>` acceptance, `NO <code>` decline, `HELP`, `START`, `STOP`/`STOP 2H`/`STOP 1D`, and treats anything else as a message on a conversation thread. Deduplicated on `MessageSid`; the sender must match a live `users.phone` exactly |
| POST | `/webhooks/twilio/sms-status` | *Twilio signature* | Delivery status callback: moves a delivery row from `sent` to `delivered` or `failed`. Returns `204` |
| POST | `/webhooks/twilio/voice/:callId` | *Twilio signature* | Answers a masked call with TwiML that dials the destination, resolved from the call row rather than from the URL. An unknown call gets the "could not connect" TwiML |
| POST | `/webhooks/twilio/call-status` | *Twilio signature* | Call status callback: maps Twilio's status onto the call row, with duration and end time. Returns `204` |

Configure the first, second and fourth in the Twilio console; the voice *answer*
URL is set per call by the API. See
[DEPLOYMENT.md](DEPLOYMENT.md#6-twilio).
