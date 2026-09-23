# Operations runbook

Day-2 operations. Written for whoever is holding the phone at 2am, which may not
be an engineer.

**Fast facts**

| | |
| --- | --- |
| API | `https://api.dispatch.refuahvchesed.org` (Fly app `rvc-dispatch-api`, region `yyz`) |
| App | `https://dispatch.refuahvchesed.org` |
| Health | `GET /health` — 200 means the process is up *and* can reach Postgres |
| Ops health | `GET /api/ops/health` — dispatcher/admin session required |
| Board context | `GET /api/board/context` — duty, unread messages, applications, overdue equipment |
| Logs | `fly logs --app rvc-dispatch-api` |
| Shell | `fly ssh console --app rvc-dispatch-api` |
| Database | `fly postgres connect --app rvc-dispatch-db` |

Most questions below are answerable from the dispatcher UI. The SQL is there for
when the UI is the thing that is broken.

---

## Seeing what is happening

### Failed notifications

**UI:** Admin → Notifications, or `GET /api/notifications/deliveries?status=failed`.
That endpoint also returns 24-hour totals (`delivered`, `queued`, `failed`,
`skipped`).

```sql
-- what failed in the last day, and why
SELECT d.channel, d.status, d.attempts, d.last_error,
       n.event, n.title, u.full_name, t.reference
  FROM notification_deliveries d
  JOIN notifications n ON n.id = d.notification_id
  JOIN users u         ON u.id = n.user_id
  LEFT JOIN trips t    ON t.id = n.trip_id
 WHERE d.status = 'failed' AND d.queued_at > now() - interval '24 hours'
 ORDER BY d.queued_at DESC;
```

Reading `last_error`:

| Says | Means | Do |
| --- | --- | --- |
| `no phone number on file` (status `skipped`) | the volunteer has no `phone` | add one in their profile; they cannot receive SMS at all |
| `no push subscription registered` (`skipped`) | never enabled notifications in a browser | expected for SMS-only volunteers; ignore |
| `no email address on file` (`skipped`) | no address on the user row | only reachable if their preference includes email |
| `Twilio … 21610` | the recipient replied STOP | they opted out at the carrier. **You cannot undo this from here** — the volunteer must text START to their carrier. Their preference was switched to `push` automatically |
| `Twilio … 21211` | invalid `To` number | the stored number is wrong; fix the profile |
| `Twilio … 20003` | authentication failed | `TWILIO_AUTH_TOKEN` is wrong or the account is suspended |
| `SMS send timed out after 10000ms` | the provider was slow | it retries; if every one says this, see *the phone system is down* |
| `WAHA sendText failed: …` | the WhatsApp session is not connected | see *WhatsApp has stopped working* |
| `push subscription gone (410)` | the browser discarded the subscription | automatic — the row is disabled. Nothing to do |
| an SMTP error | the mail host refused or timed out | check `SMTP_*`; `GET /api/ops/health` does not verify SMTP, but `verifySmtp()` exists for a console check |

A `failed` delivery has exhausted `notifications.max_attempts` (default 5) and
will not retry. Reach the person another way, then fix the cause.

Remember what a delivery row does **not** cover: messages to volunteer
*applicants* and to equipment *borrowers* are sent directly, because neither has
a user row. Those attempts appear in `audit_events` (`application.messaged`,
`equipment.due_scan`) and in the logs, not here.

### Stuck jobs

**UI:** `GET /api/ops/health` → `jobs: { pending, running, overdue, dead }`.

```sql
SELECT status, kind, count(*), min(run_at) AS oldest
  FROM jobs GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- jobs that should have run and did not
SELECT id, kind, payload, attempts, last_error, run_at
  FROM jobs
 WHERE status = 'pending' AND run_at < now() - interval '5 minutes'
 ORDER BY run_at LIMIT 50;

-- dead: gave up after max_attempts
SELECT id, kind, payload, attempts, last_error
  FROM jobs WHERE status = 'dead' ORDER BY completed_at DESC LIMIT 50;
```

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `overdue` climbing, `running` = 0 | no worker is running | check `RUN_WORKER_IN_PROCESS`; `fly status`; restart |
| `running` stuck for >10 min | a worker died mid-job | housekeeping reclaims it after 10 minutes automatically. If not, see below |
| `dead` > 0 | something failed `max_attempts` times (default 10) | read `last_error`; fix, then requeue |
| `pending` large but falling | a big broadcast | fine. Raise `WORKER_CONCURRENCY` if it is habitually slow |

Manual reclaim (the worker does this every 5 minutes on its own):

```sql
UPDATE jobs SET status='pending', locked_at=NULL, locked_by=NULL
 WHERE status='running' AND locked_at < now() - interval '10 minutes';
```

Requeue a dead job after fixing the cause:

```sql
UPDATE jobs SET status='pending', attempts=0, run_at=now(), last_error=NULL
 WHERE id = '<uuid>';
```

Never delete a dead job without reading it. It is the only record of what did not
happen.

**The dedupe key is the scheduler.** The daily and quarter-hourly work is
enqueued by the worker's housekeeping pass with a key that encodes the period
(`recurring:<date>`, `equipment-due:<date>`, `licence-expiry:<date>`,
`duty-reminder:<slot>`). If one of those jobs is stuck in `running`, the key is
still held and the next period's copy will not be enqueued. Reclaiming or
completing it frees the key.

```sql
-- which recurring work has run today?
SELECT kind, status, run_at, completed_at, last_error
  FROM jobs
 WHERE kind IN ('recurring.materialise','equipment.due_scan','licence.expiry_scan',
                'duty.reminder_scan','cleanup.retention')
 ORDER BY created_at DESC LIMIT 20;
```

### An unanswered trip

"We offered it an hour ago and nobody replied."

**UI:** open the trip — the dispatcher view shows who was offered, who was
skipped and why, and what came back.

```sql
-- who was asked, on what channel, and what came back
SELECT u.full_name, u.phone, o.status, o.round, o.offered_at, o.expires_at,
       o.responded_at, o.response_channel
  FROM trip_offers o JOIN users u ON u.id = o.volunteer_id
 WHERE o.trip_id = '<trip uuid>'
 ORDER BY o.round DESC, o.offered_at;

-- did the messages actually go out?
SELECT u.full_name, d.channel, d.status, d.attempts, d.last_error, d.sent_at
  FROM notification_deliveries d
  JOIN notifications n ON n.id = d.notification_id
  JOIN users u         ON u.id = n.user_id
 WHERE n.trip_id = '<trip uuid>' AND n.event = 'trip.offered'
 ORDER BY d.queued_at;
```

Work down this list:

1. **Were offers created?** No rows → the broadcast never happened. Check the
   trip's status and `GET /api/trips/:id/history`.
2. **Was anybody eligible?** If `offerTrip` refused, it said why, in numbers, and
   the reason is in the audit metadata. See *nobody can be offered this trip*.
3. **Were they delivered?** `status='failed'` or `'skipped'` for everyone → this
   is a delivery problem, not an apathy problem. See above.
4. **Did anyone reply and get rejected?**
   ```sql
   SELECT created_at, from_number, body, outcome, detail, signature_valid
     FROM sms_events WHERE created_at > now() - interval '2 hours'
    ORDER BY created_at DESC LIMIT 50;
   ```
   `outcome='unmatched'` means the sending number does not match any live
   `users.phone` **exactly** — the commonest cause is a number stored without the
   `+1`. `outcome='rejected_signature'` means the webhook URL or
   `TWILIO_AUTH_TOKEN` is wrong. `outcome='conversation'` means they wrote a
   sentence rather than a command, and it is waiting in Messages.
5. **Nobody is available.** Re-broadcast to a wider group, or assign directly. A
   re-broadcast is a new round: it supersedes the old offers, so the old codes
   stop working — tell anyone you have spoken to directly to use the new message.

Escalation should already have warned dispatchers at
`dispatch.escalation_minutes` (default 20, capped by the offer window). If it did
not, check `jobs` for `trip.escalate`.

### "Nobody can be offered this trip"

Targeting refused, and the message says which filter emptied the pool — for
example *"4 not available at this time; 2 already on another trip at this time"*.
The six filters are group membership, service opt-in, capability, availability,
conflicting trip within 90 minutes, and snooze.

`GET /api/trips/:id/eligible-volunteers` lists the group's active volunteers. To
see the full reasoning, re-read the audit row for the last `trip.offered` on that
trip, or check the roster screen:

```sql
-- who in this group, and what might be stopping them
SELECT u.full_name, u.status, u.muted_until,
       (SELECT count(*) FROM availability_rules a WHERE a.user_id = u.id) AS availability_rules,
       (SELECT count(*) FROM volunteer_services vs
          JOIN service_types st ON st.id = vs.service_type_id
         WHERE vs.user_id = u.id AND st.slug = '<trip_type>')            AS opted_in,
       u.capabilities
  FROM users u JOIN user_groups ug ON ug.user_id = u.id
 WHERE ug.group_id = '<group uuid>' AND u.deleted_at IS NULL AND u.role = 'volunteer'
 ORDER BY u.full_name;
```

Common causes, in order of how often they are it:

1. **Nobody in the group has opted in to that service.** A newly created service
   type, or a roster imported before service opt-ins existed. `opted_in = 0` for
   everybody is the signature. Fix it on the roster screen, or from a volunteer's
   own Services page.
2. **The trip needs a capability nobody has recorded** — stretcher, oxygen.
3. **The hour genuinely suits nobody**, which availability is correctly
   reporting.
4. **Everyone is on another trip** within 90 minutes of the pickup.

Legitimate ways out, in order of preference: assign somebody directly
(`POST /api/trips/:id/assign`), widen the group, or raise the priority — `urgent`
retries without availability and snooze when the strict pool is empty, and
`emergency` never applies them. Do not raise priority to work around a data
problem; fix the opt-ins.

### The message queue

**UI:** Messages. `GET /api/conversations` gives the same list, and
`GET /api/board/context` gives just the unread count.

A conversation is an inbound SMS that was not a command — somebody typing a
sentence to the organisation. They do not expire, and nothing chases them.

```sql
-- the queue, oldest unanswered first
SELECT t.id, t.phone, t.display_name, t.party_type, t.status, t.unread_count,
       t.last_inbound_at, u.full_name AS owner
  FROM sms_threads t
  LEFT JOIN users u ON u.id = t.owner_id
 WHERE t.status <> 'closed'
 ORDER BY t.last_inbound_at NULLS LAST;
```

| Symptom | Means | Do |
| --- | --- | --- |
| The unread count never falls | nobody is working the queue | this is a staffing question, not a technical one. Claim and answer, or close what does not need an answer |
| A thread is owned by somebody who has gone home | it is claimed, not stuck | release it (`POST /api/conversations/:id/release`) and claim it yourself |
| A reply failed | for a volunteer thread the failure is in `notification_deliveries`; for a caller or unknown number it is on the message row | `SELECT status, failure_reason FROM sms_messages WHERE thread_id = '<id>' ORDER BY created_at DESC LIMIT 5;` |
| An inbound message appeared on a thread that was closed | working as designed — an inbound message reopens a thread within seven days of closing | nothing |
| Two threads for one person | the earlier one was closed more than seven days ago | expected. Close the one you are not using |

A volunteer's reply that *is* a command (`YES`, `NO`, `HELP`, `START`, `STOP`)
never becomes a conversation; it is in `sms_events`.

### Applications waiting for review

**UI:** Admin → Applications. `GET /api/applications` returns the queue and the
count per status; `GET /api/board/context` surfaces the count on the board.

```sql
SELECT status, count(*) FROM volunteer_applications
 WHERE deleted_at IS NULL GROUP BY 1;

-- how long has the oldest been waiting?
SELECT reference, full_name, created_at, now() - created_at AS waiting
  FROM volunteer_applications
 WHERE status IN ('submitted','info_requested') AND deleted_at IS NULL
 ORDER BY created_at LIMIT 20;
```

| Symptom | Means | Do |
| --- | --- | --- |
| Applications piling up | nobody is reviewing | it is an admin-only action (approve/reject). Check there is more than one active admin |
| The applicant says they never heard back | the acknowledgement is sent directly, not through the delivery pipeline | look for `application.messaged` in `audit_events`, then `fly logs \| grep -i applicant` |
| Approval refused: "already a volunteer with that phone number or email" | a real duplicate | merge by hand: decide which user row survives, and reject the application with a note |
| Approval refused: "already approved" | somebody approved it already | the response names the user it became |
| A sudden burst of applications from one address | the per-IP limit (default 5/hour) is doing its job; the rest were refused | if it is abuse, set `PUBLIC_SIGNUP_ENABLED=false` for a while. That closes the form and the options endpoint |

An application is never a user. Nothing in this queue can receive an offer or log
in, so there is no urgency beyond courtesy to the applicant.

### Standing rides and the materialiser

**UI:** the Standing rides screen. `recurring.materialise` runs daily with the
dedupe key `recurring:<local date>`; the trips it creates are offered when
`pickup_at - lead_time_minutes` arrives.

```sql
-- active standing rides and how far they have been expanded
SELECT reference, status, frequency, by_weekday, by_month_day,
       start_date, end_date, lead_time_minutes, last_materialised_date
  FROM recurring_rides WHERE deleted_at IS NULL ORDER BY reference;

-- what was produced, and what was skipped and why
SELECT o.occurrence_date, o.skipped, o.skip_reason, t.reference, t.status
  FROM recurring_ride_occurrences o
  LEFT JOIN trips t ON t.id = o.trip_id
 WHERE o.recurring_ride_id = '<uuid>'
 ORDER BY o.occurrence_date DESC LIMIT 30;
```

| Symptom | Likely cause | Action |
| --- | --- | --- |
| "I set up a standing ride and nothing appeared" | the first date is beyond `recurring.horizon_days` (default 14) | expected. `POST /api/recurring-rides/materialise` runs it now, which is also the honest answer to the question |
| An occurrence exists but was not offered | its pickup falls in Shabbos or yom tov — `skip_reason` says so — or the lead time has not arrived | deliberate. A dispatcher decides whether that ride happens, and can offer or assign it by hand |
| Occurrences stopped appearing | the daily job is stuck, or the ride is `paused`/`ended`/past its `end_date` | check `jobs` for `recurring.materialise`, then the ride's status |
| Dates skipped with "occurrence date already passed" | the horizon moved over a date in the past, usually after the job had not run for a while | no trip is created in the past, which is correct. Create the missed ones by hand if they still matter |
| A trip appears twice for one date | should be impossible — the unique index on (ride, date) prevents it | if you ever see it, one of them was created by hand. Cancel the duplicate |

Ending a standing ride (`POST /api/recurring-rides/:id/end`) stops future
occurrences and optionally cancels the trips already on the board. Without that
option the existing trips stay, which is usually what you want mid-week.

### Equipment reminders

`equipment.due_scan` runs daily (`equipment-due:<local date>`). It texts
borrowers `equipment.due_reminder_days` (default 2) before the due date, and
chases an overdue item **once a week**, not daily — daily texts about a
wheelchair get a family to block the number, and then the wheelchair is gone for
good.

```sql
SELECT e.item_code, e.equipment_type, l.borrower_name, l.borrower_phone,
       l.expected_return_at, (current_date - l.expected_return_at::date) AS days_overdue
  FROM equipment_loans l JOIN equipment e ON e.id = l.equipment_id
 WHERE l.returned_at IS NULL AND l.expected_return_at < now()
 ORDER BY l.expected_return_at;
```

| Symptom | Means | Do |
| --- | --- | --- |
| A borrower says they got no reminder | the loan has no `expected_return_at`, or the scan did not run | reminders only exist for loans with a due date. Check `jobs` for `equipment.due_scan` |
| An overdue item is not being chased | the weekly rule: it is chased only when the days overdue is a multiple of 7 | `POST /api/equipment/loans/:id/confirm-sms` sends a message now |
| "That item is not currently on loan" on return | the loan was already closed | `SELECT * FROM equipment_loans WHERE equipment_id = '<id>' ORDER BY loaned_at DESC LIMIT 3;` |
| "That item is `loaned`" on lending | it never came back | close the old loan first, or the item is genuinely out |
| A scanned barcode finds nothing | the label is for an item that was deleted, or the code is mistyped | `GET /api/equipment/scan/:code` accepts the printed item code as well as the barcode |

Borrower reminders are sent directly, not through `notify()`, so a failure is in
the logs and the audit trail rather than in `notification_deliveries`.

### Exports

```sql
SELECT id, kind, status, row_count, created_at, completed_at, expires_at, error
  FROM data_exports ORDER BY created_at DESC LIMIT 20;
```

| Symptom | Means | Do |
| --- | --- | --- |
| Stuck in `queued` | the worker is not running | see *stuck jobs*. The job kind is `export.run` |
| `failed` | `error` says why — usually a bad parameter or a query that found nothing to shape | fix and request it again; the old row stays as a record |
| Download returns 409 | the export is not `ready` | wait, or look at `error` |
| Download returns 403 | it belongs to another dispatcher | only an admin may download somebody else's |
| "That file is no longer available" | it passed `expires_at` (7 days) and the retention sweep deleted the object | request a fresh one |
| A file fails its integrity check | the stored bytes no longer match their SHA-256 — a bad restore, or tampering | do not work around it. Request a fresh export and investigate the storage |

Exports contain personal data. They are stored encrypted, they self-destruct
after a week, and both the request and each download are in the audit log. Do not
copy one somewhere the audit trail cannot follow it.

### The duty roster

```sql
-- who is on the phone now
SELECT d.kind, u.full_name, u.phone, d.starts_at, d.ends_at
  FROM duty_shifts d JOIN users u ON u.id = d.user_id
 WHERE d.deleted_at IS NULL AND d.kind = 'phone'
   AND d.starts_at <= now() AND d.ends_at > now();

-- gaps: list the next fortnight and read it
SELECT kind, starts_at, ends_at, user_id FROM duty_shifts
 WHERE deleted_at IS NULL AND ends_at > now() AND starts_at < now() + interval '14 days'
 ORDER BY kind, starts_at;
```

| Symptom | Means | Do |
| --- | --- | --- |
| "Somebody is already on phone duty during that period" | the exclusion constraint refused an overlap, and the message names who has it | change theirs first, or pick a different time. This is the constraint doing its job |
| Nobody is on duty | there is no shift covering now | book one. The system does not invent cover, and `GET /api/board/context` shows `onDutyNow: null` |
| A shift reminder never arrived | `reminder_sent_at` is already set, or `duty.reminder_scan` is stuck | reminders go out once, `duty.shift_reminder_minutes` (default 60) before the start, and only within that window |
| A removed shift still blocks the slot | it should not — the constraint is `WHERE deleted_at IS NULL` | confirm the row's `deleted_at` is set |

Different *kinds* of duty may overlap: phone, dispatcher and backup are different
jobs. Only the same kind is exclusive.

### Everything at a glance

```sql
SELECT
  (SELECT count(*) FROM trips WHERE status='pending'  AND deleted_at IS NULL) AS pending,
  (SELECT count(*) FROM trips WHERE status='offered'  AND deleted_at IS NULL) AS offered,
  (SELECT count(*) FROM trips WHERE status='expired'  AND deleted_at IS NULL) AS expired,
  (SELECT count(*) FROM trips WHERE status IN ('assigned','accepted','en_route','in_progress')
                                AND deleted_at IS NULL)                       AS active,
  (SELECT count(*) FROM trips WHERE pickup_at < now() - interval '15 minutes'
                                AND status NOT IN ('completed','cancelled')
                                AND deleted_at IS NULL)                       AS overdue,
  (SELECT count(*) FROM jobs   WHERE status='dead')                           AS dead_jobs,
  (SELECT count(*) FROM notification_deliveries
                   WHERE status='failed' AND queued_at > now() - interval '24 hours') AS failed_24h,
  (SELECT coalesce(sum(unread_count),0) FROM sms_threads WHERE status <> 'closed')    AS unread_messages,
  (SELECT count(*) FROM volunteer_applications
                   WHERE status IN ('submitted','info_requested') AND deleted_at IS NULL) AS applications,
  (SELECT count(*) FROM equipment_loans
                   WHERE returned_at IS NULL AND expected_return_at < now())    AS overdue_equipment;
```

`overdue` is the one that matters most: a trip whose pickup time has passed and
which is not finished means somebody may be standing outside a hospital.

---

## People

### Reset a volunteer's password

*Preferred — the volunteer does it themselves:*

1. They tap "Forgot password" and enter their address.
2. The API always answers `{ok:true}`, whether or not the address exists.
3. The link is written to the logs:
   ```bash
   fly logs --app rvc-dispatch-api | grep 'auth token issued'
   ```
   It is valid for 60 minutes and single-use.
4. Send it to them over a channel you trust — **the link is the credential.**
   Confirm you are talking to the right person before you send it.

`issueAuthToken` builds and logs the link; it does not email it. Applicant
messages (including the approval that carries an invite) *are* sent through the
email and SMS providers, so an approved volunteer receives theirs directly when
`EMAIL_PROVIDER=smtp` is configured.

*Alternative — re-invite:*

```
POST /api/users/:id/resend-invite      (admin)
→ { "inviteUrl": "https://dispatch.refuahvchesed.org/accept-invite?token=…" }
```
Valid 7 days.

*Last resort — set a password directly.* Only when somebody is locked out and
needs access now:

```bash
fly ssh console --app rvc-dispatch-api
cd /app/apps/api
node -e "const {hashPassword}=await import('./dist/lib/crypto.js'); console.log(await hashPassword(process.argv[1]))" 'TemporaryPassword-ChangeMe-123'
```
```sql
UPDATE users
   SET password_hash = '<hash>', must_change_password = true,
       failed_login_count = 0, locked_until = NULL
 WHERE lower(email) = lower('person@example.com') AND deleted_at IS NULL;

UPDATE sessions SET revoked_at = now()
 WHERE user_id = (SELECT id FROM users WHERE lower(email)=lower('person@example.com'))
   AND revoked_at IS NULL;
```

This writes **no audit event**, which is exactly why it is the last resort.
Record what you did and why, somewhere a human will read.

### "I'm locked out"

Eight failures locks an account for 15 minutes.

```sql
SELECT full_name, failed_login_count, locked_until FROM users
 WHERE lower(email) = lower('person@example.com');

UPDATE users SET failed_login_count = 0, locked_until = NULL
 WHERE lower(email) = lower('person@example.com');
```

If `failed_login_count` is climbing on an account nobody is using, that is an
attack, not a forgetful volunteer. Check `audit_events` for `auth.login` from
unfamiliar IPs.

### "I'm not getting any offers"

Before assuming a delivery problem, check whether they were *asked*. The six
targeting filters are the usual answer:

```sql
SELECT u.full_name, u.status, u.muted_until, u.last_offered_at,
       (SELECT count(*) FROM availability_rules a WHERE a.user_id = u.id)     AS availability_rules,
       (SELECT count(*) FROM availability_exceptions e
         WHERE e.user_id = u.id AND e.kind = 'unavailable' AND e.ends_at > now()) AS future_absences,
       (SELECT array_agg(st.slug) FROM volunteer_services vs
          JOIN service_types st ON st.id = vs.service_type_id
         WHERE vs.user_id = u.id)                                             AS services,
       (SELECT array_agg(g.slug) FROM user_groups ug
          JOIN volunteer_groups g ON g.id = ug.group_id
         WHERE ug.user_id = u.id)                                             AS groups,
       u.capabilities
  FROM users u WHERE lower(u.email) = lower('person@example.com');
```

In order of likelihood: they are snoozed (`muted_until` in the future); they are
not opted in to that service; they have availability rules that do not cover the
hours the trips fall in; they are not in the group. **No availability rules at
all is not a problem** — that means always available.

Clearing a snooze is `POST /api/me/mute {hours: 0}` from their own account, a
`START` text, or:

```sql
UPDATE users SET muted_until = NULL WHERE id = '<uuid>';
```

### Deactivate someone

**UI:** Admin → People → Deactivate, with a reason. Or:

```
POST /api/users/:id/deactivate   { "reason": "left the organisation" }
```

What it does, in one transaction: sets `status='deactivated'` and `deleted_at`,
rewrites `email` to `<email>.deleted.<timestamp>` and nulls `phone` (so both live
unique indexes free up), **revokes every session**, deletes their outstanding
invite and reset tokens, and writes an audit event.

It **refuses** if the person still has active trips:

> "This volunteer still has 3 active trip(s). Reassign them first."

That is deliberate. Reassign first:

```sql
SELECT t.reference, t.status, t.pickup_at
  FROM trips t
 WHERE t.assigned_volunteer_id = '<uuid>'
   AND t.status IN ('assigned','accepted','en_route','in_progress')
   AND t.deleted_at IS NULL;
```
Then, per trip, `POST /api/trips/:id/reassign` or
`POST /api/trips/:id/return-to-pending`.

Also check whether they are the preferred driver on a standing ride, or booked on
a duty shift:

```sql
SELECT reference FROM recurring_rides
 WHERE preferred_volunteer_id = '<uuid>' AND deleted_at IS NULL;
SELECT id, kind, starts_at, ends_at FROM duty_shifts
 WHERE user_id = '<uuid>' AND deleted_at IS NULL AND ends_at > now();
```

A duty shift holds a foreign key with `ON DELETE restrict`, and the roster will
show a gap once they are gone.

Their history stays: trips they drove still show their name, and their audit rows
are untouched. Nothing is hard-deleted.

**Temporary absence** — holiday, illness — is not a deactivation. Either set
`status='inactive'` (they stop being a candidate but keep their login), have them
add a dated availability exception, or have them snooze. All three now work;
snooze and exceptions are both honoured by targeting.

### Change someone's role

```
POST /api/users/:id/role   { "role": "dispatcher" }
```

Admin only, audited, and **every session of theirs is revoked** so new privileges
require a fresh login. Demoting the last active admin is refused.

---

## Alerts

What each one means, and the first three things to check.

### `health_check_failed` — /health is not 200

The process is down, or it cannot reach Postgres.

1. `fly status --app rvc-dispatch-api` — are the machines up?
2. `fly logs --app rvc-dispatch-api | tail -100` — a crash loop? `Invalid
   environment configuration` means a secret was changed badly. In production a
   missing `FIELD_ENCRYPTION_KEY`, `COOKIE_SECURE=false` or
   `TWILIO_SKIP_SIGNATURE_VALIDATION=true` each refuse to boot.
3. `fly status --app rvc-dispatch-db` — is the database up? `/health` returns 503
   with `"database unreachable"` when `select 1` fails.

### `jobs_overdue` — pending jobs older than 5 minutes

The worker is not keeping up, or is not running. **No SMS is being sent while
this is true, offers are not expiring, nothing is escalating, and the daily
scans are not happening.**

1. `GET /api/ops/health` — is `running` also 0?
2. `fly logs | grep -i worker` — expect "background worker started" at boot.
3. `fly ssh console -C 'printenv RUN_WORKER_IN_PROCESS'` — must be `true` unless
   a separate worker app exists. If it does, check *its* status.

### `deliveries_failed` — failures above 2% over 24h

1. Are they all one channel? All SMS → Twilio. All push → VAPID. All WhatsApp →
   the WAHA session. All email → SMTP.
2. Read the `last_error` distribution (query above). One repeated code points at
   one cause.
3. `fly secrets list` — was a credential changed? Check the vendor's console for
   suspension or a spending cap.

### `jobs_dead` — any job in `dead`

Something failed ten times. Usually a bug, occasionally bad data.

1. Read `last_error` and `payload`.
2. `kind='offer.expire'` → an offer that will never expire, so the trip stays
   `offered` forever. Expire it by hand and investigate.
3. `kind='export.run'` or `announcement.send` → the requester or the audience is
   waiting on something that will not arrive. Tell them.
4. Fix the cause, then requeue. Do not just delete it.

### `sms_signature_rejected` — rejected webhooks appearing

```sql
SELECT created_at, from_number, detail FROM sms_events
 WHERE outcome = 'rejected_signature' ORDER BY created_at DESC LIMIT 20;
```

1. Did a deploy change `API_PUBLIC_URL`? It must match the URL Twilio calls
   **exactly**, including scheme and any query string.
2. Was `TWILIO_AUTH_TOKEN` rotated in Twilio but not in Fly?
3. If neither: somebody is probing you. The requests are already rejected and
   recorded; note the IPs and carry on.

### `trips_overdue` — pickup time passed, trip not finished

Not a technical alert. A dispatcher rings the volunteer, then the caller.

### `db_connections_high` — above 70% of `max_connections`

1. `select count(*), state from pg_stat_activity group by 2;`
2. Machines × `DATABASE_POOL_MAX` is your floor. Two machines at 10 = 20, plus
   one LISTEN connection each, plus the release_command and any psql sessions.
3. Look for idle-in-transaction: that is a leaked transaction, and it is a bug.
   ```sql
   SELECT pid, now()-xact_start AS age, query FROM pg_stat_activity
    WHERE state = 'idle in transaction' ORDER BY 2 DESC;
   ```

---

## "The phone system is down"

Twilio is unreachable, the account is suspended, or SMS is not being delivered.

### Confirm

1. https://status.twilio.com
2. `GET /api/notifications/deliveries?status=failed` — are SMS deliveries failing
   while push deliveries succeed?
3. `fly logs | grep -i twilio`
4. Twilio console: account status, spending cap, the number itself.

### What still works

**Most of the system.** Offers are database rows, not messages:

- offers are created regardless of whether any message is sent;
- **in-app acceptance works** — volunteers who open the app see their offers and
  can accept;
- **web push works** — it does not go through Twilio at all;
- **email and WhatsApp work**, if configured, for the volunteers whose preference
  includes them;
- the dispatcher board, assignment, reassignment and completion all work;
- failed SMS is recorded as failed, and retried with backoff. Nothing is lost.

**What does not work:** SMS notification, SMS acceptance (`YES <code>`), inbound
conversations, and masked calling.

### Do this

1. **Tell the dispatchers**, by phone: *"SMS is down. Volunteers must use the
   app. Ring anyone who does not respond."*
2. **Switch offers to direct assignment.** A broadcast that nobody sees is worse
   than a phone call. Dispatchers ring volunteers and use
   `POST /api/trips/:id/assign`, which is recorded and audited exactly like an
   accepted offer.
3. **Lengthen the offer window** so nothing expires while people are not being
   reached:
   ```
   PUT /api/settings/dispatch.offer_window_minutes   { "value": 180 }
   ```
   Write down the old value (30). Put it back afterwards.
4. **Do not delete the queued deliveries.** They retry and back off on their own;
   when Twilio returns they will send, and a stale offer message is better than a
   missing audit trail.
5. **When it recovers:** check the failed list, re-offer anything that expired
   unnoticed, restore the offer window, and tell the dispatchers.

If the outage is account-specific rather than a Twilio outage (suspension,
spending cap), the provider boundary means a second SMS vendor is a new file in
`apps/api/src/services/providers/` and one line in `providers/index.ts` — a
same-day change, not a rewrite. That is why the boundary exists.

---

## "WhatsApp has stopped working"

The WAHA session has dropped — the paired phone went flat, or WhatsApp logged the
device out.

1. `wahaWhatsAppProvider.health()` reports the session state; WAHA returns
   `WORKING` only when it is paired and connected. Otherwise the WAHA server's own
   dashboard will show it needs re-pairing.
2. Deliveries on the `whatsapp` channel will be failing in
   `notification_deliveries` with the WAHA error attached.
3. **Nothing critical is lost.** WhatsApp is never the sole carrier: the
   `whatsapp` preference always pairs it with push, and offers force SMS and push
   regardless of preference. That is precisely because a silently dropped session
   is indistinguishable from a delivered message.
4. Re-pair the session on the WAHA server. No change is needed here.

---

## "Email is not arriving"

1. `EMAIL_PROVIDER` must be `smtp` **and** `SMTP_HOST` must be set, or the
   in-memory provider is selected and mail is logged rather than sent. In
   production `env.ts` refuses to boot with `EMAIL_PROVIDER=smtp` and no host.
2. Email failures appear in `notification_deliveries` with the SMTP error — for
   anything sent through `notify()`. Applicant messages are sent directly, so
   look in the logs and for `application.messaged` in the audit trail.
3. Invite and password-reset links are **not** emailed by `issueAuthToken`; they
   are logged and returned to the administrator. Only the applicant approval
   message carries an invite link by email.

---

## "The database is down"

Nothing works. `/health` returns 503 or times out, and the API cannot serve a
single request.

### Confirm, in this order

```bash
fly status --app rvc-dispatch-db
fly logs --app rvc-dispatch-db | tail -100
fly postgres connect --app rvc-dispatch-db -c 'select 1'
curl -s -o /dev/null -w '%{http_code}\n' https://api.dispatch.refuahvchesed.org/health
```

Then distinguish:

| | Symptom | Then |
| --- | --- | --- |
| **Down** | machines stopped, cannot connect | restart, below |
| **Full** | writes fail, "no space left on device" | extend the volume |
| **Overloaded** | connects, but slow; `pg_stat_activity` full | kill the offending queries |
| **Corrupt / lost** | it starts but the data is wrong or gone | this is a restore |

### First: tell people

Ring the dispatch lead. *"The system is down. Take calls on paper. We will tell
you when it is back and you will need to re-enter what you took."* This is the
single most useful thing you can do in the first two minutes, and it is easy to
forget while typing.

The printed volunteer phone list from the migration checklist lives with the
dispatchers for exactly this.

### Restart

```bash
fly machine list --app rvc-dispatch-db
fly machine restart <id> --app rvc-dispatch-db
# then the API, so the connection pool is rebuilt cleanly
fly machine restart <id> --app rvc-dispatch-api
curl -s https://api.dispatch.refuahvchesed.org/health
```

### Volume full

```bash
fly volumes list --app rvc-dispatch-db
fly volumes extend <volume-id> --size 20 --app rvc-dispatch-db
```

Then find out why. `notifications`, `notification_deliveries`, `sms_events`,
`sms_messages` and `calls` are aged out by the `cleanup.retention` job — check it
has been running, and check the retention settings have not been raised:

```sql
SELECT key, value FROM settings WHERE key LIKE 'retention.%';
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;
```

`audit_events` grows without bound by design and is never pruned.

### Overloaded

```sql
SELECT pid, now()-query_start AS age, state, left(query, 120)
  FROM pg_stat_activity
 WHERE state <> 'idle' ORDER BY 2 DESC LIMIT 20;

SELECT pg_cancel_backend(<pid>);     -- polite
SELECT pg_terminate_backend(<pid>);  -- not
```

### Failing over (HA pair)

```bash
fly postgres failover --app rvc-dispatch-db
fly status --app rvc-dispatch-db
```
Expect a few seconds of errors while the API's pool reconnects; it recovers on
its own.

### Data is gone or wrong

Stop. This is a restore, and rushing it will make it worse. Go to
[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md#restoring-production) and follow it
exactly — including step 2, which backs up the *broken* database before you
overwrite it.

### After any database incident

```bash
curl -s https://api.dispatch.refuahvchesed.org/health
```
```sql
-- did anything get left in an impossible state?
SELECT count(*) FROM trips
 WHERE status IN ('assigned','accepted','en_route','in_progress')
   AND assigned_volunteer_id IS NULL;                        -- must be 0

SELECT count(*) FROM jobs WHERE status = 'running'
   AND locked_at < now() - interval '10 minutes';            -- reclaim these

SELECT count(*) FROM trip_offers
 WHERE status = 'pending' AND expires_at < now();            -- should have expired

-- did the daily work run since the incident?
SELECT kind, max(completed_at) FROM jobs
 WHERE kind IN ('recurring.materialise','equipment.due_scan','duty.reminder_scan')
 GROUP BY 1;
```

Then: create a test trip, offer it to yourself, accept it, complete it. Two
minutes, and it exercises the path that matters. Finally, write the incident up —
what broke, what you did, what you would want to have known.

---

## Routine maintenance

| When | Do |
| --- | --- |
| Daily | glance at `GET /api/ops/health` — dead jobs, overdue jobs, failed deliveries. Glance at the board's unread-message and application counts |
| Weekly | confirm the restore drill passed; skim `audit_events` for `user.role_changed`, `user.deactivated` and `caller.searched`; clear the applications queue; check overdue equipment |
| Monthly | `npm audit`, review who holds admin, check backup bucket size and oldest object, review the duty roster for the coming month |
| Quarterly | human restore drill ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md#quarterly-human-drill--checklist)); review `settings` against how dispatch actually works; review message templates against what is actually being sent; rotate `FLY_API_TOKEN` and the backup bucket credentials |

## Things that are not wired up

So nobody wastes an hour looking for them:

- **No alerting exists yet.** The alert names above are what you should
  configure, not what is running.
- **Error aggregation is opt-in and not installed.** `initMonitoring()` loads
  `@sentry/node` at runtime when `SENTRY_DSN` is set, but that package is not a
  dependency of `@rvc/api`. With a DSN set and the package absent the API logs an
  error at boot saying so, and errors go to the logs only.
- **Invite and reset links are not emailed** by `issueAuthToken`. An
  administrator passes them on. Applicant messages, including the approval that
  carries an invite, *are* sent.
- **`GET /api/ops/health` does not check the providers.** It reports job and
  delivery counts only; SMTP and WAHA health have their own functions
  (`verifySmtp()`, `wahaWhatsAppProvider.health()`) that no endpoint currently
  exposes.
- **`audit_events` has no retention job** and grows without bound. That is
  deliberate; everything else with personal data is aged out by
  `cleanup.retention`.

## Monitoring and alerts (free)

- **Errors:** set `SENTRY_DSN` on rvc-api (free Sentry project). Unhandled request
  errors, crashes, worker failures and jobs that exhaust their retries are sent there.
- **Health:** `GET /health` is liveness only. `GET /health/deep` runs the
  operational checks and answers 503 when a critical one fails: database, worker
  ticking, jobs stuck in `running`, dead jobs, today's standing rides not created,
  object storage, plus warnings for delivery failure spikes, webhook signature
  failure spikes and rides with no volunteer near pickup. Counts only, no personal
  data. Set `HEALTH_CHECK_TOKEN` and call `/health/deep?token=...` to keep it private.
- **Alerting:** point a free uptime monitor (UptimeRobot / Better Stack) at
  `/health/deep` with email/SMS alerts. It also keeps the free Render instance awake.
  The worker additionally reports each failing check to Sentry, at most hourly.
- **Backups:** the GitHub Actions Backup workflow fails loudly (GitHub emails the
  repo owner) when a dump or restore check fails.
