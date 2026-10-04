# Security

The data here is a list of elderly and unwell people in one Montreal
neighbourhood, their home addresses, their phone numbers, when they will not be
home, free-text notes about their medical trips, and photographs of their
drivers' licences. It is a small database and a serious one.

---

## Authentication

**Email and password, cookie session.** No OAuth, no magic links, no SMS OTP.
Volunteers are onboarded by an administrator who already knows who they are;
adding an identity provider would add a dependency and a second account lifecycle
without removing a risk.

### Passwords

`lib/crypto.ts`, scrypt from the Node standard library:

```
scrypt$131072$8$1$<salt base64url>$<key base64url>      N=2^17, r=8, p=1, 64-byte key
```

**Why scrypt and not argon2id or bcrypt:** both need a native build step, which
is the usual reason a Docker image or a new contributor's laptop fails to set up,
and an organisation this size cannot afford "the deploy is broken because
node-gyp". scrypt is memory-hard, in core since Node 10, and the parameters
follow OWASP's scrypt guidance. Verification re-reads N/r/p from the stored
string, so parameters can be raised later without invalidating old hashes.

`verifyPassword` burns a comparable amount of time when there is no stored hash,
so "no such account" and "wrong password" take the same wall-clock time.

### Login

- Identical failure for *no such account*, *wrong password* and *deactivated
  account*. Account enumeration against a volunteer roster is a real risk: it
  tells a stranger who in the neighbourhood volunteers for medical transport.
- Eight consecutive failures → 15-minute lockout (`locked_until`), and the
  lockout response is deliberately different from the credential failure, because
  at that point the account owner needs to know.
- Rate limit: 10 attempts per 5 minutes, on top of the global 300/minute.
- `failed_login_count` resets on success; `last_login_at` is recorded.
- Every login and logout writes an `audit_events` row.

### Sessions

`sessions` table, not a JWT.

| Property | Value |
| --- | --- |
| Token | 32 bytes of CSPRNG, base64url |
| Stored | SHA-256 only — a database leak yields no usable session |
| Cookie | `httpOnly`, `sameSite=lax`, `path=/`, `secure` from `COOKIE_SECURE` (the config loader refuses `false` in production) |
| TTL | `auth.session_ttl_hours`, default 336 hours (14 days) |
| Revocation | `revoked_at`, immediate and server-side |
| Tracking | `ip`, `user_agent`, `last_seen_at` |

**Why not JWT:** a stateless token cannot be revoked. This system must be able to
cut off a departing volunteer, a compromised account or a stolen phone
*immediately*, and must revoke every session on a password change, a role change
or a deactivation — all of which `revokeAllSessionsForUser` does in the same
transaction as the change itself. A 14-day JWT would mean a dismissed dispatcher
keeps reading caller addresses for a fortnight.

`sameSite=lax` rather than `strict` because offer links arrive by SMS and push: a
volunteer tapping `https://app/o/ABCDEFGHJK` is a cross-site navigation, and
`strict` would show them a login page while a ride goes unclaimed. `lax` still
blocks cross-site POSTs, which is where CSRF lives.

### Invites and resets

`auth_tokens`: 32 random bytes, stored hashed, single-use (`used_at` set inside
the redeeming transaction, which holds `FOR UPDATE`), expiring — 7 days for an
invite, 60 minutes for a reset. A password reset revokes every session.

`POST /api/auth/request-password-reset` **always** returns `{ok:true}`, whether
or not the address exists. Rate limited to 5 per 15 minutes.

`issueAuthToken()` builds the link and logs it; it does not send it. Applicant
messages — including the approval message that carries the invite link — go
through the email and SMS providers directly (`applications.service.ts`), so with
`EMAIL_PROVIDER=smtp` configured an approved volunteer receives their own invite.
For a user created by hand through `POST /api/users`, the invite URL is returned
to the administrator in the response and an administrator passes it on. **The
link is the credential**: send it over a channel you trust, and confirm who you
are talking to first.

---

## The authorisation model

Two server-side layers, both required, neither sufficient.

### 1. Route guards — `preHandler`

`auth/guards.ts` provides `requireAuth`, `requireRole(...)`, `requireDispatcher`
(dispatcher or admin) and `requireAdmin`. This answers "may a person of this role
call this endpoint at all", and it is the coarsest check.

```ts
app.post('/api/trips', { preHandler: requireDispatcher }, …)
app.post('/api/users/:id/role', { preHandler: requireAdmin }, …)
```

Guards are `async` for a reason that is documented in the file and worth
repeating: Fastify v5 decides a hook's calling convention from its arity, so a
synchronous two-argument guard is awaited as a non-promise and the request hangs
forever instead of erroring — silently, on every authenticated route.

### 2. Object-level checks in the service layer

The layer the legacy application did not have. "May this person act on *this*
record" is answered by the domain function, not the route.

- **Transitions.** `assertTransitionAllowed()` checks the transition against
  `TRIP_STATE_MACHINE` — legal from the trip's current status, permitted for the
  actor's role — and then, when the rule says `volunteerMustOwn`, that the
  volunteer is actually the assignee. It fails with `409 stale_state` and a
  sentence a human can act on.
- **Claiming.** The offer code identifies the offer; it does not prove who is
  holding it. The claimant must *also* be the volunteer it was issued to — by
  authenticated session, or by a Twilio-verified sending number that exactly
  equals `users.phone`.
- **Reads.** `trips.query.ts` constrains a volunteer's query by their user id and
  group membership in SQL, before it reaches the database, and projects to the
  narrower DTO.
- **Calling.** `calls.service.ts` resolves a destination from a *relationship*,
  never from client input.
- **Exports.** A dispatcher may download only their own export; an admin may
  download any. Checked in the route against `requested_by_id`.
- **Notifications.** `GET /api/notifications` is filtered by `userId`
  server-side.
- **Conversations, callers, the audit log, SMS events, delivery failures,
  templates, announcements** are dispatcher-or-admin at the route, with the
  narrower ones (templates, announcement *sending*, licence review, user role
  changes and deactivation, application approval) admin-only.

**The web app's route guards are not a security layer.** `RouteGuards.tsx` exists
so people do not see a page that will refuse them. Every endpoint it appears to
protect is independently protected on the server, and the API test suite
(`authz.test.ts`, `privacy.test.ts`) asserts the server refuses rather than the
interface hiding.

---

## The privacy boundary: before and after claiming

A broadcast goes to dozens of people and most of them will not take the trip.
They do not need to know that the person at 1234 Avenue Bernard has a dialysis
appointment on Thursday afternoon and will not be home.

| | Volunteer, before claiming | Volunteer, assigned | Dispatcher / admin |
| --- | --- | --- | --- |
| Reference, type, priority, pickup and appointment time | yes | yes | yes |
| Pickup / dropoff | **street and city only** — the leading house number is stripped | full address, unit, entrance, parking, address notes | full |
| Mobility needs | yes | yes | yes |
| Caller name | no | yes | yes |
| Caller phone / callback number | no | yes, and can call, masked | yes |
| Passenger notes | no | yes | yes |
| Who else was offered | no | no | yes |
| Caller directory, ride history | no | no | yes |
| Conversations (SMS threads) | no | no | yes |
| Other volunteers' phone/email | no | no | yes |
| Audit trail, SMS log, delivery failures | no | no | yes |

The mechanism is `getTrip()`, not a client-side filter: a dispatcher or admin
gets `TripDto`; a volunteer who is the assignee gets `TripDto`; a volunteer
holding a live pending offer gets `OfferedTripDto`; anyone else gets **404, not
403**, because the existence of the trip is itself information.

`listUsers(viewerRole, …)` nulls `email` and `phone` for non-dispatch roles:
volunteers see who else is on the roster, not how to contact them. Trip search is
narrower too — a dispatcher can search caller name, phone and addresses, a
volunteer can search only the reference.

Full detail arrives in the claim confirmation, to one person.

---

## The caller directory

Every route under `/api/callers` is dispatcher-and-above. A volunteer has no
reason to query a searchable list of the people this organisation drives, and
giving them one would make every volunteer account a privacy incident waiting to
happen. What a volunteer learns about a caller comes from a trip they have been
given, after they have claimed it.

**Every lookup is audited.** `searchCallers()` writes a `caller.searched` audit
row with the query and the number of matches whenever it returns anything, and
`getCallerProfile()` writes one per profile opened. A searchable directory of
vulnerable people's addresses is exactly the kind of thing that should leave a
trail.

Phone matching is exact E.164 after normalisation — `514 555 0142`,
`5145550142` and `+15145550142` all find the same row, but a number that merely
ends in the same digits does not.

---

## Field encryption and stored files

`FIELD_ENCRYPTION_KEY` is 32 bytes, base64. `env.ts` refuses to boot in
production without it, and refuses any value that does not decode to exactly 32
bytes whatever the environment.

**Licence numbers.** AES-256-GCM, a fresh 12-byte nonce per value, the
authentication tag appended. The key is never written to the database or the
logs. Only `number_last4` is stored in clear — the four characters an
administrator needs to match a record to an image. If the key is absent,
`encryptField` throws rather than storing plaintext, and `recordLicence` turns
that into "Licence numbers cannot be stored because field encryption is not
configured". A feature that quietly degrades its own confidentiality is worse
than one that refuses to run.

**Stored files.** `services/files.service.ts` is the only way bytes enter or
leave storage, and it has four rules:

1. **The type is checked against the file's own magic bytes**, not the client's
   `Content-Type` header, which is attacker-controlled. JPEG, PNG, WebP and PDF
   are accepted; anything else is refused. The cap is 8MB.
2. **Keys are generated UUIDs** under a `<sensitivity>/<YYYY-MM>/` prefix. A
   filename never reaches the filesystem, and the local driver refuses any key
   that resolves outside its root — `../../etc/passwd` is the oldest file-upload
   bug there is.
3. **Restricted files are encrypted before they are stored**, so the bytes on
   disk, in a bucket, or in a backup are useless without the key. Storing a
   restricted file with no key configured is refused.
4. **Reading one is an audited event.** Every read writes a `file.read` row with
   the reason the caller gave.

`GET /api/files/:id` is **admin only**, serves one file per request with
`cache-control: no-store, private`, and takes a `reason` query parameter that
goes into the audit row. Before serving, the bytes are re-hashed and compared
against `stored_files.sha256`; a mismatch is a corrupted restore or tampering and
the file is refused rather than served as if it were the original.

Exports get the same treatment: they are stored encrypted with `purge_after` set
seven days out, the request and the download are audited separately, and the
retention sweep deletes the object when it expires.

---

## Offer codes

The single highest-leverage design decision in the system.

**The legacy design:** a 4-digit `call_id` generated per trip, displayed in the
UI, and used as the value a volunteer texted back to accept. Two independent
failures: collision (10,000 values, and `lib/offer-code.ts` records the birthday
bound as roughly a 50% chance of a repeat after about 112 trips — weeks, not
years), and authorisation (the code *was* the
authorisation, and the SMS webhook validated no signature, so guessing four
digits did not even require a phone).

**This design:** `lib/offer-code.ts`, 10 characters of Crockford base32 ≈ 50
bits.

| Property | Why |
| --- | --- |
| **10 characters, not 4 digits** | 32^10 ≈ 1.1 × 10^15. Against the API's global 300 requests/minute, brute-forcing one live code is not a strategy. A 4-digit code falls in under an hour |
| **Crockford base32** | The alphabet omits `I`, `L`, `O` and `U`. `normalizeOfferCode` folds `O→0`, `I/L→1`, `U→V`, strips spaces and hyphens, and is case-insensitive — it accepts what a human squinting at a phone in a car park actually types |
| **CSPRNG, never derived** | `randomBytes`, not a hash of the trip id or a counter. Knowing one code tells you nothing about another |
| **Stored as SHA-256 only** | A database leak yields no usable codes. The lookup is a single hit on `trip_offers_token_uq` |
| **Bound to one volunteer and one offer** | A code is not a trip token. Presenting it still requires being the person it was issued to |
| **Single-use, expiring, killed by round** | Resolved offers stop working; a re-broadcast marks the previous round `superseded`, so yesterday's code is dead |
| **Displayed grouped: `ABCDE-FGHJK`** | Legible aloud and on a screen. The hyphen is presentation only |

Trip references (`RVC-260914-0007`) are the human-facing identifier and are
**never** an authorisation value. They appear in SMS, on screens and in support
calls, and knowing one grants nothing.

> One consequence to keep in mind: `generateOfferCode` maps a random byte into a
> 32-character alphabet with `% 32`, and 256 is an exact multiple of 32, so the
> distribution is uniform. If the alphabet length ever changes, that modulo
> introduces bias and must become rejection sampling.

---

## Twilio webhook signature validation

`providers/twilio.ts` → `validate()`, called by **every** webhook route as the
first thing that happens, before any field of the body is read.

```
X-Twilio-Signature = base64( HMAC-SHA1( auth_token,
                       full_url + concat(sorted(param_key + param_value)) ) )
```

Three details that are easy to get wrong and are handled here:

1. **The raw body must survive parsing.** Fastify's default urlencoded parser
   discards it, so `server.ts` installs a content-type parser that stashes
   `rawBody` and then parses. Twilio signs the exact bytes it posted.
2. **The URL must match exactly.** It is rebuilt from `API_PUBLIC_URL` plus the
   raw path and query. If `API_PUBLIC_URL` is wrong — the commonest deployment
   mistake — every webhook fails closed with a 403, which is the right failure.
3. **A forged request gets nothing back.** The unsigned request is recorded in
   `sms_events` with `outcome='rejected_signature'` and the source IP, then
   answered with `403` and *no TwiML* — in particular, nothing that would cause
   an outbound SMS to an attacker-chosen number.

`TWILIO_SKIP_SIGNATURE_VALIDATION` exists for local development. `env.ts` throws
at boot if it is true while `NODE_ENV=production`. There is no runtime path that
can turn it on.

Webhook routes are exempt from the global rate limit — Twilio must never be
throttled away — and are authenticated by signature instead.

### The SMS identity model

An inbound "YES ABCDE-FGHJK" is accepted only if **all** of these hold:

1. the Twilio signature is valid;
2. `MessageSid` has not been seen before (`sms_events_provider_sid_uq` makes
   Twilio's retry-on-timeout idempotent — a redelivery cannot claim a second
   trip);
3. the sending number, normalised to E.164, **exactly** equals a live
   `users.phone`;
4. that user is `active`;
5. the code resolves to a `pending`, unexpired offer;
6. the offer belongs to *that* user;
7. the compare-and-set on `trips` returns a row.

Point 3 is worth naming: the legacy app compared "the last ten digits", so any
number ending in the same ten digits matched. Exact E.164 equality, with a live
unique index behind it, replaces it.

Caller ID is spoofable, so the phone number alone is treated as *evidence of
identity, not proof of authorisation* — which is why the single-use per-volunteer
code is also required. Neither is sufficient alone. A bare "YES" with no code is
refused rather than guessed at: guessing is how a volunteer ends up committed to
a trip they did not mean.

Inbound messages that are not commands are not authorisation events at all —
they become conversation threads (see
[ARCHITECTURE.md](ARCHITECTURE.md#conversations)) — and an unrecognised number
gets a thread too, because it may be a caller replying about their own ride.

`STOP` variants are honoured: `STOP 2H` or `STOP 1D` set `muted_until` (a
temporary snooze, which is what volunteers were inventing "#Mute" to get), while
a bare `STOP` is a carrier-level opt-out that cannot be undone from this side, so
the sender's preference is switched to `push` and the event recorded.

---

## Masked calling

The legacy app had two competing implementations. One accepted a `recipientType`
and a number in the request body, which let any authenticated user dial anywhere
in the world on the organisation's account.

Here the caller **never supplies a phone number**. They name a relationship:

| `counterparty` | Who may | Server-side check |
| --- | --- | --- |
| `caller` | dispatcher/admin always; the assigned volunteer only while the trip is `assigned`/`accepted`/`en_route`/`in_progress` | trip loaded, assignment and status checked |
| `volunteer` | dispatcher/admin only | trip must have an assigned volunteer with a phone |
| `contact` | dispatcher/admin only | contact must exist and not be soft-deleted |

The number is resolved server-side; `authorization_basis` records the reason in
words. The voice webhook resolves the destination again from the call row —
`counterparty_user_id`, then the trip's caller phone, then the contact — so the
number never travels in a URL where it could be tampered with. The bridge rings
the *initiator* first; the TwiML then dials the destination with the
organisation's number as caller ID, so neither party learns the other's number.
Only `destination_last4` is stored, and the call log renders `••• 0142` rather
than digits.

Limits: 20 calls per user per 5 minutes (route rate limit) and
`calling.daily_limit_per_user` (default 100) per rolling 24 hours — a stolen
session cannot run up a phone bill. A user with no `phone` on file cannot place a
call at all, because the bridge has nothing to ring.

---

## The public signup endpoint

`POST /api/public/volunteer-applications` is the only unauthenticated write
endpoint in the API, which makes it the one that has to be hardest. Four
protections, in order:

1. **Its own rate limit, per IP** — `SIGNUP_MAX_PER_IP_PER_HOUR` (default 5),
   read per request rather than captured at boot so it can be tuned without a
   restart, and far tighter than the global 300/minute.
2. **A honeypot field** (`website`) that is hidden in the form. A human never
   sees or fills it; a naive bot always does. A submission carrying it gets
   `202` and a fabricated reference — telling a bot it was detected only teaches
   it.
3. **A minimum completion time.** The form reports how long it was open; under
   three seconds is refused. A form submitted two seconds after it loaded was not
   typed by a person.
4. **Nothing it writes can reach the dispatch system.** An applicant is not a
   user. No `users` row, no login, no group membership, no offer, no directory
   entry — until an administrator approves the application and the record is
   converted in one transaction. The alternative most systems choose is a
   `users` row with `status='pending'` and every query remembering to exclude it;
   that works until one query forgets, and then a stranger who filled in a web
   form is in the volunteer directory with somebody's phone number in front of
   them.

The endpoint is also **deliberately uninformative**. A duplicate application, or
one from somebody who is already a volunteer, returns the same acknowledgement as
a new one, because the alternative turns it into a way to test whether a phone
number belongs to a volunteer of this organisation. A still-open application from
the same number is updated rather than duplicated, so submitting the form twice
does not create two review tasks.

`PUBLIC_SIGNUP_ENABLED=false` closes both the form and its options endpoint.

Consent is not optional: `consent_contact` must be true, the consent text is
versioned (`CONSENT_VERSION`) and its acceptance timestamped, and the database
refuses a row without it. `submitted_ip` and `submitted_user_agent` exist for the
abuse window only and are nulled when the application is approved — they have
done their job and are personal data with no further purpose.

---

## The ID card verification token

A volunteer's badge carries their `volunteer_number` (`V0007`) in large type for
a human to read, and a QR code that points at
`/verify/<card_token>` → `GET /api/id-card/verify/:token`.

**The QR does not carry the volunteer number.** It carries `users.card_token` —
15 bytes of CSPRNG output rendered base64url, so twenty opaque characters
(migration 0006 backfilled existing volunteers with 32 hex characters derived
from `gen_random_uuid()`, because `pgcrypto` is not assumed to be installed). It
is unique, and assigned once alongside the volunteer number. The
reason is enumeration: a badge gets photographed at hospital reception desks, and
if the printed number were also the verification key, anyone who saw one card
could walk the numbers upward and confirm every volunteer in the organisation —
who in this neighbourhood does medical transport, and how many of them there are.
An opaque token cannot be walked.

The verification endpoint is unauthenticated on purpose: the person scanning is a
receptionist, not a user of this system. It answers the one question being
asked — is this person currently a volunteer here — with a name, the volunteer
number and the organisation, and nothing else: no phone number, no email, no
groups, no ride history. An unknown token and a deactivated volunteer both return
`{ valid: false }`, with no hint as to which.

---

## Driver licences: what the system does *not* do

**This system does not verify driver's licences.** It stores an image and a
number so that a human being can look at them, and it records that a human being
did.

There is no such thing as verifying a Quebec licence from software the SAAQ has
not authorised. No public API exposes licence validity, and anything claiming to
is either a paid identity-verification vendor with a contract behind it, or a
lie. So the status vocabulary is deliberately blunt:

| Status | Means |
| --- | --- |
| `pending_review` | submitted; nobody has looked |
| `on_file` | **an administrator has seen the image. This is not a claim of validity.** |
| `verified` | an external verification service affirmatively confirmed it, and its name and reference are recorded alongside |
| `rejected` | an administrator declined it |
| `expired` | the recorded expiry date has passed — date arithmetic, which the system is allowed to assert |

`on_file` is the status that matters, because it is the one that will be
misread. It means a person looked at a photograph. It does not mean the licence
is valid, current, unsuspended, or the licence of the person holding it. An
organisation that believes its software checked a licence will stop checking the
licence, which is why this is stated in the API response of every upload
("Nothing has been verified automatically"), in the service file, in the schema
comment, and here.

**Two independent locks stop `verified` being written without a provider:**

1. **In the application.** `reviewLicence()` accepts only `on_file` or
   `rejected`, and refuses anything else with "Only a verification service can
   mark a licence verified." The single code path that writes `verified` is
   `verifyLicence()`, which does so only when the configured provider returns
   `verified: true` **and** a reference; a positive answer without a reference is
   downgraded to `unknown` and logged, because without a reference there is
   nothing to point at later. With no provider configured, `verifyLicence()`
   changes nothing, records `licence.verification_unavailable` in the audit log,
   and says so.
2. **In the database.** `driver_licences_verified_requires_provider_chk` refuses
   `status = 'verified'` unless `verification_provider`,
   `verification_reference` and `verified_at` are all present. Even a direct SQL
   `UPDATE` cannot produce a verified licence out of nothing.

The default provider (`LICENCE_VERIFICATION_PROVIDER=none`) is not a degraded
mode. It returns `status: 'unsupported'`, always, and deliberately does not
inspect the number or infer anything from its format — there must be no way for
an administrator to mistake its output for a check having happened.

---

## Rate limits

| Scope | Limit | Reason |
| --- | --- | --- |
| Global | 300 / minute, keyed by user id when signed in, otherwise IP | a shared office NAT does not throttle a whole clinic |
| `POST /api/auth/login` | 10 / 5 min | credential stuffing |
| `POST /api/auth/accept-invite` | 10 / 10 min | invite-token guessing |
| `POST /api/auth/request-password-reset` | 5 / 15 min | reset-mail flooding |
| `POST /api/auth/reset-password` | 10 / 15 min | token guessing |
| `POST /api/calls` | 20 / 5 min, plus `calling.daily_limit_per_user` | telephony spend |
| `GET /api/addresses/search` | 120 / min | Nominatim's usage policy |
| `POST /api/public/volunteer-applications` | `SIGNUP_MAX_PER_IP_PER_HOUR` (default 5) / hour | the only unauthenticated write |
| `POST /api/public/volunteer-applications/:reference/licence` | 10 / hour | image upload by an unauthenticated applicant |
| `/webhooks/*` | **exempt** | Twilio must never be throttled away; authenticated by signature instead |

Other limits that are not rate limits but belong here: the global `bodyLimit` is
1MB, raised to 14MB on the two licence-upload routes only (a phone photograph
does not fit in 1MB, and without a per-route limit the request would 413 before
any friendly validation ran); uploaded files are capped at 8MB after decoding;
every list endpoint has a bounded, validated `limit` (200–500) and paging is by
keyset cursor — there is no unbounded read in the codebase; an SMS reply is
capped at 1200 characters (eight segments); a broadcast is capped at
`announcements.max_recipients`.

---

## PII handling

**Logs.** `lib/logger.ts` redacts, at every depth: `req.headers.cookie`,
`req.headers.authorization`, `res.headers["set-cookie"]`, `*.password`,
`*.passwordHash`, `*.token`, `*.tokenHash`, `*.offerToken`, `*.authToken`,
`*.callerPhone`, `*.phone`, `*.borrowerPhone`, `*.passengerNotes`. Phone numbers
and passenger notes are redacted because a log aggregator is a copy of your
database with weaker access control.

**Audit.** `lib/audit.ts` scrubs `passwordHash`, `password`, `tokenHash`,
`token`, `offerToken`, `p256dh` and `auth` before writing, truncates at depth 6
and 50 array elements. `tripSnapshot()` keeps ids, status, priority, timestamps
and the cancellation reason — not caller identity or notes. The actor is taken
from the session, never from the request body.

**Errors.** One error shape. `AppError` messages are written for humans; anything
else becomes "Something went wrong on our side" plus a `requestId` that ties the
response to the log line. Stack traces and driver errors never reach a client.

**Geocoding.** Address lookup is proxied through `GET /api/addresses/search`
(dispatcher-only). The browser never talks to Nominatim, so a caller's address is
not handed to a third party by every dispatcher's laptop with their IP attached.

**Third parties.** Twilio (message and call metadata, plus SMS bodies, which
carry the trip reference and the pre-claim area — never the full address or the
caller's name); the push service the volunteer's browser chose (payloads are
encrypted with VAPID); whatever SMTP host is configured; the organisation's own
WAHA server for WhatsApp; Nominatim (address strings, server-side); and an S3
endpoint if one is configured. No analytics, no ad tech, no session replay.

---

## Retention

| Data | Policy | Where |
| --- | --- | --- |
| Sessions | purged after expiry | `cleanup.sessions` job |
| Auth tokens | deleted 7 days after expiry | `cleanup.tokens` job |
| Notifications | deleted after `retention.notification_days` (180) | `cleanup.retention` job |
| SMS events | deleted after `retention.sms_event_days` (365) | `cleanup.retention` |
| Conversation messages | deleted after `retention.sms_message_days` (365); an empty closed thread older than that is deleted too | `cleanup.retention` |
| Call records | after `retention.call_log_days` (365) the row is kept but `counterparty_name` and `destination_last4` are nulled — the count survives, the personal detail does not | `cleanup.retention` |
| Stored files | deleted when `purge_after` passes | `purgeExpiredFiles()`, from the retention sweep |
| Exports | 7 days, set at request time | `data_exports.expires_at` + the file's `purge_after` |
| Application IP / user-agent | nulled on approval | `approveApplication` |
| Trips | soft-deleted on archive, never hard-deleted | `deleted_at` |
| Users | soft-deleted; email rewritten to `<email>.deleted.<ts>`, phone nulled | `deactivateUser` |
| Audit events | **kept indefinitely, immutable** | append-only triggers |
| Backups | 30 days (`BACKUP_RETENTION_DAYS`) | `scripts/backup.sh` |

The retention sweep runs from the worker's housekeeping pass with a fixed dedupe
key, so at most one is outstanding at a time. Trips and audit events are
operational history and are kept; the message, delivery and call traffic *around*
them carries personal data and ages out.

**Law 25 (Quebec).** Hosting is in Ohio, United States (owner decision,
2026-10-04), so personal information is stored outside Canada and the privacy
notice says so. Whether Law 25 needs more for transfers outside Quebec should be
confirmed with counsel. (`primary_region = "yyz"` and Canadian-region backups were
the original plan and are not in use.) A subject
access or erasure request is answerable from `users`, `trips`, `notifications`,
`sms_events`, `sms_messages`, `calls` and `volunteer_applications` by user id or
phone number — but note that erasure and the append-only audit trail are in
genuine tension, and the resolution (audit rows retain an id and a role, not a
name) should be confirmed with counsel before the first request arrives.

---

## Threat model

### Defended

| Threat | Defence |
| --- | --- |
| Volunteer accepts someone else's trip | per-volunteer single-use code + object-level ownership check |
| Two volunteers accept the same trip | atomic compare-and-set + `trip_offers_one_accepted_uq` |
| Forged Twilio webhook accepts a trip | HMAC signature validation before any body read; unsigned requests recorded and 403'd |
| Replayed Twilio webhook | `sms_events_provider_sid_uq` idempotency |
| Spoofed caller ID | exact E.164 match **and** the code; number alone is never enough |
| Brute-forcing an offer code | 50 bits + rate limits + expiry + single use |
| Credential stuffing | scrypt, lockout, tight per-route limits |
| Account enumeration | identical failures on login, on password-reset request, and on public signup |
| Roster enumeration from a photographed ID card | the QR carries an opaque token, not the printed number |
| Session theft after the fact | server-side revocation; every password/role/status change revokes all sessions |
| Privilege escalation via the client | every guard is server-side; the SPA's guards are cosmetic |
| Mass data extraction by a volunteer | queries scoped in SQL; bounded limits; minimised projections; the caller directory and conversations are dispatcher-only |
| Unlogged access to a licence photograph | admin-only route, one file per request, every read audited with a reason |
| A licence being trusted that nobody checked | `on_file` is not a validity claim; two independent locks on `verified` |
| Tampering with a stored file | SHA-256 recomputed on every read; a mismatch refuses to serve |
| Tampering with history | `audit_events` and `message_template_versions` reject UPDATE and DELETE at the database |
| A broadcast reaching more people than intended | audience is a stored query, the count must be confirmed, and there is a hard ceiling |
| Two people (or nobody) on phone duty | GiST exclusion constraint on `duty_shifts` |
| Running up the phone bill | relationship-based authorisation, per-user daily cap, route limit |
| Automated signup abuse | per-IP limit, honeypot, minimum completion time, and approval before anything is real |
| Bad config reaching production | `env.ts` refuses to boot with `COOKIE_SECURE=false`, signature validation disabled, or no `FIELD_ENCRYPTION_KEY` |
| Losing the database | verified off-host backups, weekly restore drill ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)) |

### Explicitly out of scope

Named so nobody assumes otherwise:

1. **A compromised administrator account.** An admin can read every caller's
   details, view licence images, change roles and deactivate users. Mitigation is
   organisational — few admins, and the audit trail — not technical. There is no
   MFA.
2. **Multi-factor authentication.** Not implemented. For a volunteer roster on
   shared family phones the usability cost was judged higher than the risk
   reduction. This is the first thing to revisit if the roster grows or if an
   admin account is ever phished.
3. **A compromised Twilio account, SMTP host or WAHA server.** Each can read the
   message bodies it carries. Signature validation proves a request came from
   Twilio; it cannot protect against Twilio itself.
4. **A compromised database credential.** Licence numbers and restricted file
   contents are encrypted with a key that is not in the database, and passwords,
   session tokens and offer codes are hashed. Everything else — names, phone
   numbers, addresses, passenger notes, conversations — is readable in plaintext.
   There is no general column-level encryption. Rely on network isolation and
   secret hygiene.
5. **A malicious volunteer.** Someone legitimately in a group can accept a trip
   they do not intend to drive, and will then see the caller's address and phone
   number. This is a vetting problem. The audit trail makes it attributable
   afterwards; nothing prevents it.
6. **Denial of service.** Rate limits stop casual abuse. A real DDoS is the
   edge's problem, not the application's.
7. **Physical device compromise.** A 14-day session on an unlocked phone is a
   readable dispatcher board. An admin can revoke the session; nothing detects
   the theft.
8. **Supply-chain compromise of an npm dependency.** `npm ci` from a committed
   lockfile is the whole defence. There is no automated dependency or container
   scanning in CI.
9. **Insider abuse of masked calling or the caller directory.** A dispatcher may
   call any caller or contact, and search the directory, for any reason. Every
   call carries an `authorization_basis` and every search is audited; none is
   prevented.
10. **Availability of the phone network.** If Twilio is down, SMS acceptance
    stops. In-app and push acceptance keep working; see
    [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md#the-phone-system-is-down).
