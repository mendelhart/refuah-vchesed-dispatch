# Backup and restore

A backup you have never restored is a rumour. This document exists so that the
first time anyone restores this database is **not** the day they need to.

Three scripts, three jobs:

| Script | Does | Runs |
| --- | --- | --- |
| `scripts/backup.sh` | dump → verify readable → upload off-host → prune | nightly |
| `scripts/verify-backup.sh` | restore the latest backup into a scratch DB and assert it contains real, consistent data | weekly |
| `scripts/restore.sh` | restore a named backup into a target database | on demand |

---

## What is being protected

The database is the entire system of record. There is no other copy of:

- the volunteer roster, with phone numbers and emergency contacts;
- every trip, with caller names, addresses and passenger notes;
- `audit_events`, which is append-only *by design* and therefore cannot be
  reconstructed from anything;
- `trip_offers` and `trip_assignments` — the answer to "who was asked, who
  agreed, and when".

Losing a day of this is not an inconvenience. It is a list of rides the
organisation no longer knows it promised.

### A database dump alone is not a complete backup

Three things together make a restorable system:

| Piece | Where it lives | How it is backed up |
| --- | --- | --- |
| Rows (everything above) | Postgres | nightly dump (this document) |
| Uploaded files (licence images, broadcast pictures) | `FILE_STORAGE_DRIVER`: **`db`** on Render → table `stored_file_blobs`; `s3` → bucket; `local` → disk | `db`: inside the same dump, nothing extra. `s3`: bucket versioning + object lock. `local`: only safe on a persistent volume, and the volume needs its own snapshot |
| Encryption key(s) | `FIELD_ENCRYPTION_KEY` (+ `FIELD_ENCRYPTION_OLD_KEYS`) in the host's secret settings, **never in the repo** | a copy kept by the administrator outside the host (password manager). See [KEY_ROTATION.md](KEY_ROTATION.md) |

Nonces and authentication tags are stored inside each encrypted value and file
(see KEY_ROTATION.md), so nothing about them needs separate backup. Without the
key, a restored database still has every trip and volunteer, but licence numbers,
licence images and authenticator secrets are unreadable forever.

Render's free plan wipes the disk on every deploy and restart, which is why
render.yaml sets `FILE_STORAGE_DRIVER=db`. Files stored before that change on the
old `local` driver are gone from disk; `npm run files:check` lists them so the
volunteer can be asked to upload the licence again.

---

## Schedule and retention

| | Frequency | Retention | Where |
| --- | --- | --- | --- |
| Application backup (`backup.sh`) | nightly, 03:00 America/Toronto | 30 days | S3-compatible bucket, Canadian region, **a different provider from the database** |
| Restore drill (`verify-backup.sh`) | weekly, Sunday 04:00 | — | scratch database on a non-production cluster |
| Fly Postgres volume snapshots | daily, automatic | 7 days | Fly, same provider |
| Pre-migration backup | before every schema migration that is not purely additive | 30 days | same bucket, `--label pre-<migration>` |

**Why two independent mechanisms.** Fly's snapshots are fast and adjacent —
perfect for "the volume is corrupt", useless for "the Fly account was suspended"
or "someone deleted the cluster". `backup.sh` puts a logical dump on a different
provider, in a bucket with different credentials. Neither alone is sufficient.

**Why 30 days.** Long enough that a slow-burn problem (a bad migration nobody
noticed, a bulk edit done wrong) is still recoverable; short enough that the
organisation is not holding years of personal information in object storage for
no operational reason. See [SECURITY.md](SECURITY.md#retention).

**RPO / RTO.**

| | Target | Reality |
| --- | --- | --- |
| Recovery point (data loss) | ≤ 24 hours | the nightly dump. Between dumps, a failure loses that day's trips — dispatchers keep paper notes; that is the fallback. |
| Recovery time | ≤ 1 hour | restore of a database this size is minutes; the hour is people, DNS and verification. |

If 24 hours of loss is ever judged unacceptable, the answer is WAL archiving /
point-in-time recovery on the Postgres cluster, not more frequent `pg_dump`.

**Is 24 hours right for live dispatch? (audit, September 2026)** For a first
season it is workable only because dispatchers keep paper notes: losing a day
means re-entering that day's rides from paper and re-checking who is driving
tomorrow. It is not equivalent to point-in-time recovery, and this document
does not claim it is. What exists today:

- nightly encrypted `pg_dump` via GitHub Actions (`.github/workflows/backup.yml`) —
  **not running yet**: the `BACKUP_DATABASE_URL` and `BACKUP_PASSPHRASE`
  repository secrets are not set, so every nightly run fails at its first step
  (visible in the Actions tab);
- uploaded files (licence photos) live in the database (`FILE_STORAGE_DRIVER=db`),
  so the same dump covers them;
- encryption keys are *not* in the dump by design — recovery needs the
  `FIELD_ENCRYPTION_KEY` (and any `FIELD_ENCRYPTION_OLD_KEYS`) from the owner's
  vault; see KEY_ROTATION.md.

Production-hardening enhancement, not done: WAL archiving / PITR (a paid
Postgres tier on Render, or a managed provider). Until then, the recovery point
is "last successful nightly dump", and backup failures show on the Actions tab
only — add an email notification for failed workflow runs in GitHub settings.

---

## Setting up the nightly backup

### 1. Bucket

Any S3-compatible provider, in a Canadian region, **not the one hosting the
database**. Backblaze B2, Cloudflare R2 and Wasabi all work; `backup.sh` takes
the endpoint as configuration.

Create the bucket with:

- **object lock / immutability** if the provider offers it — ransomware and
  `rm -rf` both look like a delete;
- **versioning on**;
- a lifecycle rule matching `BACKUP_RETENTION_DAYS` as a backstop, in case the
  script's own pruning stops running;
- an access key scoped to **that bucket only**, with put/get/list/delete.

### 2. Credentials

```bash
fly secrets set --app rvc-dispatch-backup \
  DATABASE_URL="postgres://…"  \
  BACKUP_S3_BUCKET=rvc-dispatch-backups \
  BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
  BACKUP_S3_REGION=ca-central-1 \
  AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
```

Never pass credentials on the command line — they land in `ps` output and in
shell history.

### 3. Schedule

Any host with `pg_dump` 16, `pg_restore`, `aws` and network access to the
database. A small Fly machine, a cron box, or a GitHub Actions scheduled
workflow using a read-only database role.

```cron
# /etc/cron.d/rvc-backup   — 03:00 America/Toronto
CRON_TZ=America/Toronto
0 3 * * *  rvc  /opt/rvc-dispatch/scripts/backup.sh >> /var/log/rvc-backup.log 2>&1
0 4 * * 0  rvc  /opt/rvc-dispatch/scripts/verify-backup.sh --min-trips 50 --min-users 20 >> /var/log/rvc-verify.log 2>&1
```

Both scripts exit non-zero on any failure. **Alert on the exit code.** A backup
job that fails silently for six weeks is the normal way this goes wrong.

### 4. Prove it works, today

```bash
scripts/backup.sh --local-only --label setup-test
scripts/verify-backup.sh --file backups/rvc-dispatch-*-setup-test.dump
```

Then again with the upload enabled. Do not consider the setup finished until
`verify-backup.sh` has printed `OK — backup restores cleanly`.

---

## What `backup.sh` actually does

1. `pg_dump --format=custom --compress=6 --no-owner --no-privileges` to
   `backups/rvc-dispatch-<ISO8601>Z[-label].dump`.
   Custom format because it is compressed *and* selectively restorable — one
   table, or schema-only. `--no-owner/--no-privileges` because the restore
   target's roles are not this cluster's roles, and a restore must not fail on a
   missing role.
2. **Fails if the dump is smaller than `BACKUP_MIN_BYTES`** (default 20000). A
   near-empty dump is a failed dump, not a small one.
3. **Verifies with `pg_restore --list`** and greps the table of contents for
   `users`, `trips`, `trip_offers`, `trip_assignments`, `audit_events` and
   `notifications`. This catches truncation and corruption. It does *not* prove
   the data is right — that is `verify-backup.sh`.
4. Writes a `.sha256` beside the dump.
5. Uploads both, then **re-reads the object's `ContentLength`** and compares it
   to the local size. `aws s3 cp` can exit 0 against a misconfigured endpoint.
6. Prunes local and remote copies older than `BACKUP_RETENTION_DAYS` — **last**,
   and only after a successful verified upload, so a failed run can never be the
   reason an old good backup was deleted. If pruning would leave zero backups in
   the bucket, the script fails instead of reporting success.

A failed run deletes its own unverified output rather than leaving a
plausible-looking file for a future restore to pick up.

---

## Restoring

### Into a scratch database (practice, or inspecting old data)

```bash
createdb rvc_restore_test
scripts/restore.sh \
  --file backups/rvc-dispatch-20260914T030000Z.dump \
  --target postgres://rvc:rvc@localhost:5432/rvc_restore_test
```

It prints what it is about to overwrite and asks you to type the database name.
`--force` skips the prompt; the script refuses to run unattended without it.

### Restoring production

Read this once before you need it.

```bash
# ---- 1. STOP WRITES -------------------------------------------------------
# Nothing may write while the restore runs, or you will interleave old and new.
fly scale count 0 --app rvc-dispatch-api
# Tell the dispatchers, by phone, that the system is down and to use paper.

# ---- 2. PRESERVE THE EVIDENCE --------------------------------------------
# Back up the BROKEN database first. It is the only copy of whatever happened
# between the last good backup and the incident, and you may need to reconcile
# from it afterwards.
DATABASE_URL="<production url>" BACKUP_DIR=/tmp/incident \
  scripts/backup.sh --local-only --label incident-$(date -u +%Y%m%dT%H%M%SZ)

# ---- 3. CHOOSE A BACKUP ---------------------------------------------------
aws s3 ls s3://rvc-dispatch-backups/dispatch/ \
  --endpoint-url "$BACKUP_S3_ENDPOINT" | tail -20

# ---- 4. REHEARSE IT. Do not skip this. ------------------------------------
# Restore the chosen backup into a scratch database and look at it.
ADMIN_DATABASE_URL="postgres://…/postgres" \
  scripts/verify-backup.sh --keep
# It prints the scratch connection string. Open it and check: are the trips you
# expect there? Is the newest one from when you think?

# ---- 5. RESTORE ------------------------------------------------------------
scripts/restore.sh --latest-remote --clean --allow-production \
  --target "$(fly ssh console --app rvc-dispatch-api -C 'printenv DATABASE_URL')"

# ---- 6. BRING THE SCHEMA UP TO DATE ---------------------------------------
# The dump may predate the current code's schema.
fly ssh console --app rvc-dispatch-api -C 'node /app/apps/api/dist/db/migrate.js'

# ---- 7. RESTART AND VERIFY -------------------------------------------------
fly scale count 2 --app rvc-dispatch-api
curl -s https://api.dispatch.refuahvchesed.org/health
```

`--allow-production` is required because `restore.sh` refuses any target whose
database name does not look like a scratch database. That guard is there to stop
a tired person restoring last week's data over a live system at 3am.

After the restore, `restore.sh` asserts that the schema guarantees came back
too: `next_trip_reference()`, the `audit_events` immutability triggers,
`trip_offers_one_accepted_uq`, `trips_engaged_requires_volunteer_chk`. A schema
restored without them is a silently weaker system, which is worse than an
obviously broken one.

### Restore order

1. Recover the encryption key(s) from the password manager and set
   `FIELD_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY_ID` and any
   `FIELD_ENCRYPTION_OLD_KEYS` **before** the app starts on the restored data.
   A backup taken before a key rotation needs the key that was current then.
2. Restore the database (above). With the `db` driver this also restores files.
3. With `s3`: point at the bucket (or restore the bucket version from the same
   time as the dump). With `local`: restore the volume snapshot.
4. Run the migrations (the app does this on boot).
5. Verify consistency:

   ```sh
   npm run files:check -w apps/api
   ```

   It is read-only and reports, per file:
   - `missingObjects` - **row exists, bytes missing.** The app answers with a
     clear "file is missing from storage" (404), never a crash, and never serves
     anything else in its place. Fix: restore the bytes from a matching
     backup, or ask the person to upload again and delete the old row.
   - `corrupt` - bytes present but they fail decryption (wrong or missing key)
     or the sha256 check. Never served. Fix: set the right key; otherwise treat
     as missing.
   - `orphanObjects` (db driver) - **bytes exist, no row.** Harmless and never
     reachable through the app (every read goes through a row). Delete them once
     you are sure the matching rows are not coming from a later restore.

   Exit code 0 means every live file row has readable bytes matching its
   checksum.

### Then: reconcile

Everything created between the backup and the incident is gone. Work through:

1. `GET /api/trips?scope=all&from=<backup time>` on the **incident** copy (step
   2) — the trips that existed and now do not;
2. dispatchers' paper notes for anything created after the last write;
3. re-create them in the live system. They get **new** references; tell the
   volunteers, because their SMS carries the old one.

Write up what was lost. `audit_events` on the incident copy is the authoritative
record of what the system did before it broke.

### Restoring a single table

```bash
pg_restore --data-only --table=contacts \
  --dbname="$DATABASE_URL" backups/rvc-dispatch-20260914T030000Z.dump
```

Be careful: `--data-only` does not clear existing rows, so you will get
duplicate-key errors on anything already present. For a genuine single-table
rollback, restore the whole dump into a scratch database and copy the rows
across with a `postgres_fdw` or a `\copy` — do not experiment on production.

---

## The restore drill

Weekly, automated (`verify-backup.sh`), plus **a human-run drill once a
quarter**, because the automated one cannot notice that the runbook is wrong.

### What `verify-backup.sh` asserts, automatically

- a scratch database can be created and the newest backup restored into it via
  the same `restore.sh` an operator would use;
- `users`, `trips`, `volunteer_groups`, `settings` and `addresses` are all
  non-empty (thresholds configurable — raise them in production, because a
  database that suddenly restores with 3 trips is a silent data-loss incident);
- at least one **active administrator** exists — otherwise nobody can administer
  the restored system;
- integrity invariants hold: no trip in an engaged state without a volunteer, no
  trip with two live assignments, no trip with two accepted offers, no cancelled
  trip without a reason, no orphaned offers;
- the schema guarantees survived: `next_trip_reference()`, both `audit_events`
  triggers, `trips_notify_change`, `trip_offers_one_accepted_uq`,
  `trip_assignments_one_live_uq`, `trips_engaged_requires_volunteer_chk`;
- **`audit_events` still rejects an `UPDATE`** — the one assertion that actually
  exercises a trigger rather than observing that it exists.

The scratch database is dropped afterwards unless `--keep` is given.

### Quarterly human drill — checklist

Do it from the documentation, not from memory. If a step is wrong, fix the
document as part of the drill.

- [ ] **Announce it.** A drill nobody knows about is an incident.
- [ ] Pick a backup **at random** from the last 30 days, not the newest one.
- [ ] Restore it to a scratch database using only what is written above.
      *Record how long it took.*
- [ ] Run `verify-backup.sh --keep` against it and read every assertion.
- [ ] Open the scratch database and eyeball real data: pick three trips, check
      the addresses, the assigned volunteer and the audit trail look sane.
- [ ] Confirm the newest row is the age you expect for that backup's date.
- [ ] Point a local API at the scratch database, sign in as the seeded admin,
      open the board. *Does the application actually work against it?*
- [ ] Deliberately break something: take a dump, truncate the file, and confirm
      `backup.sh`'s verification and `restore.sh` both refuse it.
- [ ] Check the bucket: is the retention policy doing what you think? Count the
      objects. Is the oldest ~30 days?
- [ ] Confirm the credentials still work and are not about to expire.
- [ ] Confirm someone **other than the person who set it up** can do all of the
      above from this document alone. This is the real test.
- [ ] Drop the scratch database and any downloaded dumps.
- [ ] Write down what was unclear and fix this page.

### Failure modes this drill has to catch

| Failure | Caught by |
| --- | --- |
| The cron job has been failing for weeks | exit-code alerting — check it is actually wired |
| The bucket credentials expired | `backup.sh` step 5 (upload verification) |
| Retention deleted everything | `backup.sh`'s refusal to report success with 0 remaining |
| The dump is technically valid but empty | `BACKUP_MIN_BYTES` and `verify-backup.sh` row-count assertions |
| Triggers and constraints were not captured | `restore.sh` / `verify-backup.sh` schema assertions |
| Nobody knows how to restore | the human drill, run by someone else |
| The restore takes four hours, not five minutes | timing the drill |

## Free-tier backups (GitHub Actions)

The database is Aiven's free Postgres 18. `.github/workflows/backup.yml` takes
a nightly backup at no cost, and is built for a **public** repository:
anything a workflow uploads as an artifact, and every line it logs, is
readable by anyone. So it never uploads an artifact and logs only sizes and
counts.

Each night at about 03:17 Montreal time it:

1. runs `scripts/backup.sh --local-only` against the live database with the
   Postgres 18 client, checking the server's certificate (`sslmode=verify-full`
   and the Aiven CA from a secret),
2. restores the dump into a throwaway Postgres 18 inside the runner with
   `scripts/verify-backup.sh` to prove it loads,
3. encrypts it (AES-256, gpg, with a passphrase only the organisation holds)
   and deletes the plain copy,
4. uploads the encrypted file to a **private** S3-compatible bucket. Cloudflare
   R2 and Backblaze B2 both have free allowances that cover this; choosing one
   is the owner's decision.

Until all seven `BACKUP_*` secrets are set (listed at the top of the workflow)
it does nothing and finishes with a notice, so it does not fail every night.
Run it on demand from GitHub: Actions > Backup > Run workflow.

To restore (including moving to a new database):

```
# 1. Download the newest nightly/rvc-dispatch-*.dump.gpg from the bucket.
gpg --batch --decrypt --passphrase-file <file holding the passphrase> rvc-dispatch-*.dump.gpg > rvc.dump
# 2. Create the new database and copy its connection string.
pg_restore --no-owner --no-privileges -d "$NEW_DATABASE_URL" rvc.dump
# 3. Point rvc-api's DATABASE_URL at the new database and redeploy.
# 4. Update the BACKUP_DATABASE_URL secret.
```

Licence numbers and photos inside the dump stay encrypted with
`FIELD_ENCRYPTION_KEY`; a restore needs that key too (see KEY_ROTATION.md).
