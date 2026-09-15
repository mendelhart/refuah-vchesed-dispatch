# Base44 cutover

Moving Refuah V'Chesed off the Base44 application and onto this one. One-way,
one-shot, on a planned date, with a rehearsal first and a rollback that is
genuinely available up until the moment the phone number is repointed.

The tool is `tools/migrate` (`@rvc/migrate`). It is deliberately not a
general-purpose ETL: it knows one source shape, one target schema, and how to
tell you everything it had to decide.

---

## Interface

```bash
npm run migrate:base44 -- --source <dir> --database-url <url> [--dry-run] [options]
```

| Flag | Meaning |
| --- | --- |
| `--source <dir>` | Directory containing the Base44 export |
| `--database-url <url>` | Target Postgres. Must already be migrated (`npm run db:migrate`). |
| `--dry-run` | Read, transform, reconcile, write the report — **touch nothing**. Always run this first. |
| `--report <path>` | Where to write the reconciliation report (default `tools/migrate/reports/`) |
| `--only <Entity,…>` | Restrict to some legacy entities. For debugging one problem, not for a real run. |
| `--continue-on-error` | Import what is valid and report the rest. **Do not use for the real cutover** — errors mean data would be lost or wrong. |

Exit codes: `0` clean; `1` errors were found (in `--dry-run` this means "do not
proceed"); `2` bad arguments or an unreadable source.

### Accepted source layouts

`tools/migrate/src/read.ts` is the only module that knows how Base44 serialises
an export, so a change in export format is a change to that one file. Per
entity it accepts:

```
<dir>/Trip.json          a JSON array, or {"records":[…]}, or {"Trip":[…]}, or one object
<dir>/Trip.ndjson        one JSON object per line
<dir>/Trip.jsonl         ditto
<dir>/trip.json          filename match is case-insensitive
<dir>/entities/Trip.json
<dir>/export.json        one combined file keyed by entity name
```

Thirteen legacy entities are recognised: `Trip`, `User`, `Volunteer`,
`PublicVolunteerDirectory`, `Vehicle`, `Equipment`, `EquipmentCategory`,
`RecurringTask`, `Contact`, `MaskedCall`, `TextTemplate`, `AuditLog`,
`OrganizationInfo`.

### Principles the tool holds to

- **Tolerant reading.** Every field except the primary key is optional, and
  unknown fields are ignored. A Base44 export is not a schema-validated
  artefact: screens wrote whichever subset of fields they knew about.
- **Nothing is silently coerced.** Normalisation functions are total and report
  failure in their return value; the caller turns that into an `Issue`. A
  transform may not `console.warn`, may not silently null a field, and may not
  drop a row.
- **Rows that fail validation are not discarded.** They are counted, reported as
  `parse_failed` with whatever id could be recovered, excluded from the import,
  and they make a real run exit non-zero.
- **Every imported row carries its `legacyId`** into an import ledger, which is
  what makes re-running idempotent rather than duplicating.

### Issue severities

| Severity | Meaning | Effect |
| --- | --- | --- |
| `error` | data would be lost or wrong | `--dry-run` reports it; a real run exits non-zero |
| `warning` | data preserved, but something was decided for you — a merge precedence, a status remap, a re-issued reference | review, not a blocker |
| `info` | bookkeeping — a duplicate merged as designed | read the count |

Issue codes are enumerated in `tools/migrate/src/issues.ts`. The ones that
reliably appear, and what each means:

| Code | What happened |
| --- | --- |
| `duplicate_merged` | one person existed as `User` + `Volunteer` + `PublicVolunteerDirectory`; merged into one `users` row |
| `field_conflict` | those copies disagreed — the detail carries the competing values and which won |
| `volunteer_without_user` | a `Volunteer` with no matching `User`; no login until an admin invites them |
| `directory_entry_unresolved` | a directory entry that matched nobody |
| `phone_collision` / `duplicate_email_collision` | two people share a phone or email. **Must be fixed in Base44 before cutover** — the target's live unique indexes will reject it, and inbound SMS must resolve to exactly one person |
| `phone_unnormalisable` / `phone_kept_raw` | a number that is not E.164 and could not be made so |
| `trip_missing_pickup_time` / `trip_missing_address` / `trip_missing_group` | a required field the legacy schema did not require |
| `trip_unresolved_assignee` | the trip names a volunteer nobody can identify |
| `trip_assignee_resolved_by_fallback` | resolved by name or phone rather than by id — check these |
| `trip_status_remapped` / `trip_status_demoted` | a legacy status with no equivalent, or one that the new CHECK constraints would reject (e.g. "assigned" with no volunteer → `pending`) |
| `call_id_collision` | two live trips shared a 4-digit `call_id`. This is the defect that motivated the new offer codes; see [SECURITY.md](SECURITY.md#offer-codes) |
| `reference_reissued` | a new `RVC-YYMMDD-NNNN` was allocated because the legacy id could not be carried |
| `equipment_loan_state_inconsistent` | an item marked available with an open loan, or vice versa |
| `actor_unresolved` | an `AuditLog` row whose actor cannot be identified; imported with the recorded name and no user id |

---

## Phase 1 — Export

**Owner: the Base44 administrator. Timebox: one day.**

1. Export every entity listed above. Take the export **on the same day** as the
   dry run, so the reconciliation counts mean something.
2. Put it in one directory. Do not edit the files by hand — if something needs
   fixing, fix it in Base44 and re-export, so the source system stays the
   authority right up to cutover.
3. Record, from Base44's own UI, and keep this page:
   - total trips, and trips by status;
   - total users; total volunteers; total directory entries;
   - open (non-terminal) trips;
   - contacts, vehicles, equipment items, open equipment loans.

   This is the denominator for reconciliation. Getting it from Base44's UI
   rather than from the export is the point: it catches an incomplete export.
4. The export contains every caller's name, phone, address and passenger notes.
   Treat it like the database: encrypted disk, not a shared drive, deleted when
   the migration is signed off.

## Phase 2 — Dry run

**Owner: engineering. Timebox: as many iterations as it takes.**

```bash
# a scratch database at the current schema
createdb rvc_migration_dry
DATABASE_URL=postgres://…/rvc_migration_dry npm run db:migrate

npm run migrate:base44 -- \
  --source ./base44-export-2026-09-14 \
  --database-url postgres://…/rvc_migration_dry \
  --dry-run \
  --report ./tools/migrate/reports/dry-2026-09-14.md
```

Nothing is written. The report tells you:

- rows found per entity, rows valid, rows that would be imported;
- every issue, by severity, with the legacy id of the record it came from;
- every record that would **not** be imported, listed individually;
- which file each entity was read from (provenance — this catches "we exported
  Trip twice and User not at all").

Iterate: read the report, fix the data **in Base44**, re-export, re-run. Repeat
until there are zero `error`-severity issues and every `warning` has been read
and accepted by a person.

Run the dry run at least twice on different days. A migration that only works
against one snapshot is not a migration.

## Phase 3 — Reconciliation review

**Owner: the organisation's dispatch lead, with engineering. Timebox: one
sitting, together, before cutover is scheduled.**

This phase is a person reading a report, not a script. It cannot be skipped: the
tool can tell you that 41 trips had an unresolvable assignee, but only a
dispatcher knows whether that matters.

Go through, in order:

1. **Counts against Phase 1.** Every number from Base44's UI, against the
   report. Investigate *any* difference — an off-by-three in trips is a
   truncated export, not a rounding error.
2. **Identity merges.** `duplicate_merged` and `field_conflict` together. For
   each conflict, confirm the winning value is the right one. This is where the
   legacy three-way split (User / Volunteer / PublicVolunteerDirectory) gets
   resolved, and it is the highest-risk part of the whole migration: get a phone
   number wrong and that volunteer silently stops receiving trips.
3. **Phone and email collisions.** Must be zero. Each one is two people the new
   system cannot tell apart.
4. **Open trips.** Every non-terminal trip, one at a time, against the
   dispatcher's own knowledge. These are the rides that still have to happen.
   `trip_status_demoted` rows especially: a trip that Base44 showed as assigned,
   with nobody actually assigned, now shows as `pending` — correctly, and
   someone has to re-offer it.
5. **Unresolved assignees.** Each is a trip whose volunteer the new system will
   not know.
6. **Equipment loans.** Open loans are items in someone's home. Confirm the list
   with whoever manages them.
7. **Sign-off.** The dispatch lead writes, in the report, that they have read it
   and accept the warnings. Keep it — this is the record of what was knowingly
   changed.

## Phase 4 — Cutover

**Owner: engineering, with the dispatch lead available by phone. Window: a
Sunday morning, 07:00–10:00 Toronto. Hard stop at 10:00.**

Choose the quietest window the organisation actually has. Never a Friday
(Shabbat starts), never a day with scheduled medical transport if that can be
avoided.

### T-7 days
- [ ] Window agreed and announced to every dispatcher and volunteer.
- [ ] Production deployed and health-checked ([DEPLOYMENT.md](DEPLOYMENT.md)).
- [ ] Backups running and **one verified restore drill completed**
      ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)).
- [ ] A second Twilio number acquired for the new system, so both can run in
      parallel during the window.
- [ ] Full rehearsal against staging with the real export: import, then have two
      dispatchers use it for an hour.
- [ ] Rollback decision-maker named. One person, by name.

### T-1 day
- [ ] Freeze Base44 configuration changes.
- [ ] Final dry run against a fresh export. Zero errors.
- [ ] Production backup taken and verified.
- [ ] Print the volunteer phone list. If everything fails, the organisation
      still needs to run rides on Sunday.

### The window

```bash
# 07:00 — freeze Base44. Dispatchers take calls on paper from here.
#         Tell them explicitly: "do not create trips in the old system."

# 07:15 — final export from Base44, copied to the migration host.

# 07:30 — backup of the (empty) production database, so there is a clean
#         pre-import restore point.
DATABASE_URL="$PROD_URL" scripts/backup.sh --label pre-base44-import

# 07:45 — final dry run against production's schema, using a scratch copy.
npm run migrate:base44 -- --source ./export-final \
  --database-url postgres://…/rvc_cutover_check --dry-run \
  --report ./reports/cutover-dry.md
#         Zero errors, warnings identical to what was signed off. If not: STOP.

# 08:15 — the real import.
npm run migrate:base44 -- --source ./export-final --database-url "$PROD_URL"
#         Non-zero exit = STOP and roll back. Do not use --continue-on-error.

# 08:45 — verification (below).
# 09:30 — repoint the Twilio number to the new system, or publish the new one.
# 10:00 — hard stop. Either it is live, or it is rolled back.
```

### Verification checklist

Do all of it. In the production system, as a real user.

**Data**
- [ ] Counts match the import report and Phase 1.
- [ ] Pick 10 trips at random across statuses: caller, addresses, time, group,
      assignee, notes all correct against Base44.
- [ ] Every open trip is present with the right status and the right volunteer.
- [ ] Every active volunteer is present, in the right groups, with a phone in
      E.164. `select count(*) from users where phone is null and role='volunteer'`
      — each one cannot receive SMS.
- [ ] No duplicate people: `select lower(email), count(*) from users where
      deleted_at is null group by 1 having count(*) > 1` returns nothing.
- [ ] Contacts, vehicles, equipment and open loans all present.
- [ ] `select count(*) from trips where status in
      ('assigned','accepted','en_route','in_progress') and assigned_volunteer_id
      is null` → 0. (The CHECK constraint should have made this impossible.)

**Function** — a real trip, end to end, with two real phones:
- [ ] Dispatcher signs in, creates a trip, address autocomplete works.
- [ ] Offer it to a group of two. **Both phones receive an SMS** containing a
      reference and a code.
- [ ] Volunteer A accepts by replying `YES <code>`. A is confirmed and receives
      the full address and caller phone.
- [ ] Volunteer B accepts the same trip: B is told it is taken. **Nothing is
      double-assigned.**
- [ ] B's in-app notification says the trip was taken.
- [ ] The board updates without a refresh (SSE).
- [ ] A marks en route, then in progress, then complete.
- [ ] The trip history panel shows every transition with the right actor.
- [ ] Accept a second trip from the app instead of SMS.
- [ ] Cancel a third trip: the assigned volunteer is notified.
- [ ] `GET /api/notifications/deliveries?status=failed` → empty.
- [ ] `GET /api/ops/health` → no dead jobs, no overdue jobs.
- [ ] A volunteer signs in and sees only their group's trips, with no caller
      names or phone numbers on unclaimed ones.

**Operations**
- [ ] Twilio webhooks are hitting the new URL (`GET /api/sms-events`).
- [ ] Signature validation is on: an unsigned POST returns 403 and is recorded.
- [ ] Backups run tonight against the now-populated database.
- [ ] Base44 is read-only for everyone.

### Sign-off

The dispatch lead says "we are live" — nobody else. Record the time. Every
dispatcher is told, by phone, in the same ten minutes.

## Phase 5 — After

- **Day 1–7:** Base44 stays readable but frozen. Check
  `/api/notifications/deliveries?status=failed` and `/api/ops/health` every
  morning. Expect a handful of "my number changed" problems — those are Phase 3
  issues surfacing.
- **Day 7:** retrospective. Re-run the reconciliation counts against live data.
- **Day 30:** export Base44 one final time, archive it encrypted alongside the
  migration reports, and close the account. Delete the working copies of the
  export from every laptop.

---

## Rollback

**The rollback is available right up until the Twilio number is repointed
(09:30).** Before that, Base44 is untouched and authoritative.

### During the window, before 09:30

1. Stop. Announce it: "we are staying on Base44 today."
2. Unfreeze Base44.
3. Restore the production database to the pre-import backup:
   ```bash
   scripts/restore.sh --file backups/rvc-dispatch-*-pre-base44-import.dump \
     --clean --allow-production --target "$PROD_URL"
   ```
4. Dispatchers enter the paper trips from the window into Base44.
5. Fix, re-rehearse, re-schedule. A migration postponed by two weeks is
   inexpensive. A migration half-done is not.

### After the number is repointed

Rolling back now means Base44 has no record of anything that happened since
08:15, so it is a data-merge exercise rather than a restore:

1. Repoint Twilio back to Base44 (fast — do this first).
2. Export the trips created in the new system since cutover:
   ```sql
   select reference, status, caller_name, caller_phone, pickup_at,
          (select line1 from addresses where id = pickup_address_id)  as pickup,
          (select line1 from addresses where id = dropoff_address_id) as dropoff,
          (select full_name from users where id = assigned_volunteer_id) as volunteer
     from trips where created_at > '<cutover time>' order by created_at;
   ```
3. Re-enter them in Base44 by hand.
4. Tell every affected volunteer that the reference in their SMS is no longer
   valid.
5. Leave the new system's database intact. Do not delete it — it is the record
   of what happened during the period Base44 does not know about.

### The decision

One named person decides, and the criteria are agreed in advance. Roll back if:

- the import exits non-zero, or the counts do not reconcile;
- the end-to-end functional check fails on offer, accept or notify;
- SMS is not being delivered;
- more than one trip is wrong in a way that could send a volunteer to the wrong
  address.

Do **not** roll back for: cosmetic problems, a missing non-critical field, or
one volunteer's phone number being wrong. Fix those in the new system.
