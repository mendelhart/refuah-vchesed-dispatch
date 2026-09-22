# Deployment

Target: **Fly.io, region `yyz` (Toronto)**. Canadian data residency is a
requirement, not a preference — see [SECURITY.md](SECURITY.md#retention). The
only other acceptable region is `yul` (Montreal). Do not add regions outside
Canada and do not let autoscaling create one.

---

## Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Where | laptop / `docker compose` | Fly app `rvc-dispatch-api-staging` | Fly app `rvc-dispatch-api` |
| Database | local Postgres 16 | Fly Postgres, 1 node, `yyz` | Fly Postgres, HA pair, `yyz` |
| `NODE_ENV` | `development` | `production` | `production` |
| SMS / voice | in-memory provider (recorded, not sent) | Twilio **test credentials** or a real number the team owns | Twilio production |
| Push | usually off | real VAPID pair (staging's own) | real VAPID pair |
| Email | in-memory (`EMAIL_PROVIDER=none`) | a real SMTP host, sending to team addresses | the organisation's SMTP host |
| WhatsApp | in-memory | staging WAHA session, or off | the organisation's WAHA server |
| Files | local disk (`./var/files`) | S3-compatible bucket | S3-compatible bucket, Canadian region |
| Seed data | `npm run db:seed` | `npm run db:seed` against staging | **never** (the seeder refuses) |
| Machines | 1 | 1, `shared-cpu-1x` / 512MB | 2, `shared-cpu-1x` / 512MB |
| Backups | none | nightly, 7-day retention | nightly + weekly verified restore drill |

Staging exists to rehearse the two things that hurt: a migration against real
volume, and the Base44 import. It uses **its own Twilio number and its own WAHA
session**. Never point staging at production's number — a staging broadcast would
text 500 real volunteers.

`NODE_ENV=production` on staging is deliberate: it exercises the same config
guards (`COOKIE_SECURE` must be true, signature validation must be off,
`FIELD_ENCRYPTION_KEY` must be present) rather than a code path production will
never take.

---

## Configuration reference

Everything is validated by `apps/api/src/env.ts` at boot; a bad value stops the
process with a list of what is wrong rather than failing later inside a request.
`.env.example` mirrors that file variable for variable and in the same order.

Note that **nothing in the repository loads `.env`**: there is no dotenv and no
`--env-file` in any npm script. On Fly the configuration is `[env]` plus
`fly secrets`; in Docker it is `--env-file` or the inline values in
`docker-compose.yml`; locally the variables have to be in your shell. Note also
that a variable env.ts types as a URL cannot be present-but-empty — zod rejects
`""` where it expects a URL — so `WAHA_BASE_URL`, `S3_ENDPOINT` and
`LICENCE_VERIFICATION_URL` must be either a real URL or genuinely unset.

### Required everywhere

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres 16. Set by `fly postgres attach`; include `?sslmode=require` if you manage it yourself |
| `SESSION_SECRET` | ≥32 characters. Signs session cookies. Rotating it logs everyone out |

### Required in production (the process refuses to boot otherwise)

| Variable | Must be | Why |
| --- | --- | --- |
| `COOKIE_SECURE` | `true` | the session cookie must be `Secure` |
| `TWILIO_SKIP_SIGNATURE_VALIDATION` | `false` | there is no runtime path that can turn signature validation off |
| `FIELD_ENCRYPTION_KEY` | 32 bytes, base64 | licence numbers and restricted files are encrypted at rest. Any value that does not decode to exactly 32 bytes is rejected in every environment |
| `SMTP_HOST` | set, when `EMAIL_PROVIDER=smtp` | an email provider with no host is a silent failure |
| `LICENCE_VERIFICATION_URL` | set, when `LICENCE_VERIFICATION_PROVIDER=http` | same |

Absent VAPID keys in production produce a warning at boot, not a refusal: push is
simply disabled and every push delivery is recorded `skipped`.

### Everything else

| Variable | Default | What it does, and what happens without it |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`/`test` select the in-memory SMS, push, calling, email, WhatsApp and object-store providers, which record every send instead of performing it |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | `0.0.0.0` is required inside a container |
| `LOG_LEVEL` | `info` | pino level. Logs redact cookies, tokens, phone numbers and passenger notes |
| `DATABASE_POOL_MAX` | `10` | per process. machines × this must stay under the server's `max_connections` |
| `APP_URL` | `http://localhost:5173` | the CORS allow-list in production, and the base for offer deep links and invite/reset links |
| `API_PUBLIC_URL` | `http://localhost:8080` | what Twilio webhook signatures are validated against. Wrong value ⇒ every webhook 403s |
| `SESSION_COOKIE_NAME` | `rvc_session` | |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | unset | all three are needed for the Twilio provider to report enabled. Without them: in-memory locally; in production the provider stays selected but disabled, so every SMS delivery fails visibly in `notification_deliveries` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | unset / `mailto:admin@refuahvchesed.org` | web push. Replacing the pair invalidates every stored browser subscription |
| `GEOCODER_BASE_URL` / `GEOCODER_USER_AGENT` / `GEOCODER_BIAS` | Nominatim / `RefuahVChesedDispatch/1.0` / `Montreal, QC, Canada` | address search, proxied server-side. Nominatim's policy requires a real identifier with a contact address |
| `EMAIL_PROVIDER` | `none` | `none` selects the in-memory provider: mail is recorded, never sent — so a dev machine can never email a real volunteer. `smtp` selects nodemailer |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE` | — / `587` / — / — / `false` | the SMTP connection. Omit user and password for a host that does not authenticate |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | `Refuah V'Chesed <dispatch@refuahvchesed.org>` / unset | the From and default Reply-To on outbound mail |
| `WAHA_BASE_URL` / `WAHA_API_KEY` / `WAHA_SESSION` | unset / unset / `default` | the organisation's existing WAHA server. Absent ⇒ the in-memory WhatsApp provider. WhatsApp is never the sole carrier for anything, so this being down is not an outage |
| `FILE_STORAGE_DRIVER` | `local` | `local` writes under `FILE_STORAGE_PATH`; `s3` uses the S3 variables |
| `FILE_STORAGE_PATH` | `./var/files` | where the local driver writes. **On Fly this is ephemeral unless a volume is mounted** — see below |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | unset / `us-east-1` / unset / unset / unset | S3-compatible storage, spoken to directly over REST with SigV4 |
| `FIELD_ENCRYPTION_KEY` | unset | AES-256-GCM key for licence numbers and restricted files. Absent outside production, those features **refuse to store anything** rather than storing it in clear |
| `LICENCE_VERIFICATION_PROVIDER` | `none` | `none` is the honest default: a licence can never reach `verified`. `http` enables the client |
| `LICENCE_VERIFICATION_URL` / `LICENCE_VERIFICATION_API_KEY` | unset | the contracted verification service, if one exists |
| `PUBLIC_SIGNUP_ENABLED` | `true` | `false` closes the public application form and its options endpoint with a 403 |
| `SIGNUP_MAX_PER_IP_PER_HOUR` | `5` | the per-IP limit on the only unauthenticated write endpoint. Read per request, so it can be changed without a restart |
| `SENTRY_DSN` | unset | when set, `initMonitoring()` tries to `import('@sentry/node')` at runtime. **That package is not a dependency of `@rvc/api`**, so with a DSN set and the package absent the API logs an error at boot and errors go to the logs only |
| `RUN_WORKER_IN_PROCESS` | `true` | `false` means you must run `node dist/jobs/worker.js` separately, or nothing expires, escalates or sends |
| `WORKER_POLL_MS` | `2000` | queue poll interval, 200–60000 |
| `WORKER_CONCURRENCY` | `4` | jobs claimed per tick, 1–50. Keep below `DATABASE_POOL_MAX` |

`VITE_API_URL` is read by Vite in `apps/web`, not by `env.ts`.

### A note on file storage on Fly

`FILE_STORAGE_DRIVER=local` writes to the machine's filesystem. Fly machines have
ephemeral disks unless you attach a volume, and a rolling deploy replaces them —
so licence images and exports written locally disappear. Either mount a volume
and point `FILE_STORAGE_PATH` at it, or use `s3` with a bucket in a Canadian
region. The local driver is genuinely adequate for this organisation's volume on
a machine with persistent storage; it is the ephemeral disk that is the problem,
not the driver.

---

## First deploy

### 0. Prerequisites

```bash
brew install flyctl              # or https://fly.io/docs/flyctl/install
fly auth login
fly orgs list                    # confirm the right org
```

### 1. Create the apps

```bash
fly apps create rvc-dispatch-api --org refuah-vchesed
fly apps create rvc-dispatch-web --org refuah-vchesed
```

### 2. Postgres, in Toronto

```bash
fly postgres create \
  --name rvc-dispatch-db \
  --region yyz \
  --initial-cluster-size 2 \
  --vm-size shared-cpu-1x \
  --volume-size 10

fly postgres attach rvc-dispatch-db --app rvc-dispatch-api
# sets DATABASE_URL as a secret on rvc-dispatch-api
```

Confirm the region before going further — this is the one mistake that is
expensive to undo:

```bash
fly status --app rvc-dispatch-db | grep -i region     # must be yyz
```

### 3. Secrets

Nothing below belongs in `fly.toml`, in the repo, or in `[env]`.

```bash
# REQUIRED
fly secrets set --app rvc-dispatch-api \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  FIELD_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

`FIELD_ENCRYPTION_KEY` must decode to exactly 32 bytes; `env.ts` checks and says
so if it does not. **Losing this key makes every stored licence number and every
encrypted file unreadable — there is no recovery.** Keep it wherever the
organisation keeps its other irreplaceable secrets, and note that rotating it
requires re-encrypting existing values, which nothing in the codebase does today.

```bash
# REQUIRED for SMS, voice and SMS-based acceptance
fly secrets set --app rvc-dispatch-api \
  TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx \
  TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxx \
  TWILIO_PHONE_NUMBER=+15145550000

# REQUIRED for web push — generate ONCE and keep; replacing it invalidates
# every browser subscription already stored in push_subscriptions.
npx web-push generate-vapid-keys
fly secrets set --app rvc-dispatch-api \
  VAPID_PUBLIC_KEY=BN... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:admin@refuahvchesed.org

# Transactional email (applicant acknowledgements, approvals, export-ready mail)
fly secrets set --app rvc-dispatch-api \
  EMAIL_PROVIDER=smtp \
  SMTP_HOST=smtp.example.org SMTP_PORT=587 SMTP_SECURE=false \
  SMTP_USER=dispatch@refuahvchesed.org SMTP_PASSWORD=... \
  EMAIL_FROM="Refuah V'Chesed <dispatch@refuahvchesed.org>"

# WhatsApp, against the organisation's existing WAHA server
fly secrets set --app rvc-dispatch-api \
  WAHA_BASE_URL=https://waha.internal.example WAHA_API_KEY=... WAHA_SESSION=default

# File storage. Use S3 unless a volume is mounted — see above.
fly secrets set --app rvc-dispatch-api \
  FILE_STORAGE_DRIVER=s3 \
  S3_ENDPOINT=https://s3.ca-central-1.example S3_REGION=ca-central-1 \
  S3_BUCKET=rvc-dispatch-files \
  S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...

fly secrets list --app rvc-dispatch-api      # names and digests only
```

Leave `LICENCE_VERIFICATION_PROVIDER` unset unless the organisation has an actual
contract with a verification service. The default is not a degraded mode; it is
the honest answer, and setting `http` without a working URL is refused at boot in
production.

Set `PUBLIC_SIGNUP_ENABLED=false` if the organisation is not ready to take public
applications on the day it goes live. Raise `SIGNUP_MAX_PER_IP_PER_HOUR` only
deliberately — it is the front door's lock.

### 4. Deploy the API

```bash
fly deploy --config fly.toml --remote-only
```

What happens, in order:

1. the API image is built from `./Dockerfile` (the SPA from `./Dockerfile.web`);
2. `[deploy] release_command = "node dist/db/migrate.js"` runs against the
   production database **before any new machine takes traffic** — if it exits
   non-zero the release is aborted and the old version keeps serving;
3. machines roll one at a time; `[[http_service.checks]]` polls `/health` (which
   does a `select 1`) before each takes traffic.

On boot the API also runs `bootstrapReferenceData()`, which is idempotent and
creates anything missing: the three volunteer groups, the five service types, the
default settings rows, and the message templates. It never overwrites an
administrator's edits. This matters on a first deploy — with no `service_types`
rows, targeting has nothing to match and would offer trips to nobody.

### 5. Certificates and DNS

```bash
fly certs create api.dispatch.refuahvchesed.org --app rvc-dispatch-api
fly certs create dispatch.refuahvchesed.org      --app rvc-dispatch-web
fly ips list --app rvc-dispatch-api              # the A/AAAA records to publish
```

`APP_URL` and `API_PUBLIC_URL` in `fly.toml` must match these exactly, with no
trailing slash. `API_PUBLIC_URL` is what Twilio signatures are validated against:
get it wrong and every webhook 403s.

### 6. Twilio

In the Twilio console, on the number in `TWILIO_PHONE_NUMBER`:

| Setting | Value |
| --- | --- |
| Messaging — a message comes in | `POST https://api.dispatch.refuahvchesed.org/webhooks/twilio/sms` |
| Messaging — status callback | `POST https://api.dispatch.refuahvchesed.org/webhooks/twilio/sms-status` |
| Voice — status callback | `POST https://api.dispatch.refuahvchesed.org/webhooks/twilio/call-status` |

The voice *answer* URL is set per call by the API and does not need configuring.

Verify signature validation is live — an unsigned POST must be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.dispatch.refuahvchesed.org/webhooks/twilio/sms \
  -d 'From=%2B15145550111&Body=YES+ABCDE-FGHJK'
# expect: 403
```

Then check it was recorded, not just rejected: `GET /api/sms-events` as a
dispatcher shows a row with `outcome=rejected_signature`.

### 7. The first administrator

The seeder refuses to run in production, so bootstrap by hand:

```bash
fly ssh console --app rvc-dispatch-api
cd /app/apps/api
node -e "
const {hashPassword}=await import('./dist/lib/crypto.js');
console.log(await hashPassword(process.argv[1]));
" 'a-long-password-you-will-change-immediately'
```

```bash
fly postgres connect --app rvc-dispatch-db --database rvc_dispatch_api
```
```sql
INSERT INTO users (email, full_name, role, status, password_hash, must_change_password)
VALUES ('admin@refuahvchesed.org', 'First Admin', 'admin', 'active', '<paste hash>', true);
```

The volunteer groups, service types, settings and templates are already there
from `bootstrapReferenceData()`. Sign in, change the password (which revokes every
other session), and create the rest of the roster through the UI so that every
account is audited.

### 8. The web app

```bash
# fly.web.toml — the SPA, built from ./Dockerfile.web
fly deploy --config fly.web.toml --remote-only
```

`fly.web.toml` sets `API_ORIGIN` to the API's public URL. nginx in that image
serves the SPA and proxies `/api` and `/webhooks` to `API_ORIGIN`, so the browser
addresses one origin only. That is not a convenience: the session cookie is
`SameSite=Lax` and a Lax cookie is not sent on a cross-site request, so an SPA
on one host calling an API on another is a sign-in that never holds.

The API does not serve the SPA. Another static host will work — Cloudflare
Pages, Netlify, an S3 bucket behind a CDN — but only if it can proxy `/api` and
`/webhooks` to the API without buffering (`/api/events/stream` is SSE), and the
origin it serves must equal `APP_URL`, which is the CORS allow-list in
production. `deploy/web-nginx.conf.template` is the reference for what such a
host has to do.

The SPA is a PWA: it ships a service worker and a manifest, and the nginx config
serves `/service-worker.js` with `Cache-Control: no-cache` and hashed assets with
a one-year immutable cache.

### 9. Backups

Set up before the system carries real trips, not after. See
[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md). Note that backups cover the
database; **files in object storage are a separate backup problem** — a licence
image or an export lives in the bucket, not in the dump.

---

## Everyday commands

```bash
npm run dev                 # API + web, watch mode
npm run build               # shared -> api -> web
npm run typecheck           # tsc --noEmit across all four workspaces
npm run lint                # eslint . --max-warnings=0
npm test                    # vitest, apps/api, against a real Postgres
npm run test:e2e            # playwright, apps/web (servers must already be up)
npm run db:migrate          # apply pending migrations
npm run db:seed             # development data (refuses production)
npm run migrate:base44      # the Base44 import tool — see docs/MIGRATION.md

npm run db:generate --workspace=@rvc/api    # generate a migration after editing schema.ts
```

### The browser suite

`scripts/e2e.sh` runs the Playwright suite against a **real API and a real
build** — not a mocked server, because a component test that mocks the server
proves nothing about whether the two agree.

```bash
DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_e2e scripts/e2e.sh
# pass anything through to playwright:
DATABASE_URL=… scripts/e2e.sh --project=phone
DATABASE_URL=… scripts/e2e.sh e2e/dispatch.spec.ts --headed
```

`DATABASE_URL` is the only variable you must supply, and it must point at a
database the suite may write to — it migrates and seeds it. Everything else has a
default: `NODE_ENV=development`, `PORT=8080`, the app on `127.0.0.1:4173`, a
throwaway `SESSION_SECRET`, and a `FIELD_ENCRYPTION_KEY` generated on the spot.

The script migrates, seeds, builds all three workspaces, starts the API and a
`vite preview` of the built SPA, waits for both to answer, and then runs
Playwright. It deliberately does not use Playwright's `webServer`: when the API
fails to start, this prints the API's own error instead of a browser timeout
thirty seconds later.

The suite runs two projects, `phone` (Pixel 7) first and `desktop` second, both
depending on a `setup` project that signs in once per role and stores the session
— `POST /api/auth/login` is rate-limited, so a suite that signs in per test
throttles itself and fails with timeouts that look like application bugs. What it
covers: a dispatcher completing a trip intake on a phone-sized screen
(`dispatch.spec.ts`), every screen opening for the role meant to reach it with no
console errors (`navigation.spec.ts`), the four accessibility properties this
product cannot do without (`accessibility.spec.ts`), and the PWA claims — the
manifest, the service worker, and the job card surviving the browser actually
going offline (`pwa.spec.ts`).

Backups:

```bash
scripts/backup.sh --local-only         # dump + verify, no upload
scripts/verify-backup.sh --file <dump> # restore it into a scratch DB and assert
scripts/restore.sh --help
```

---

## Branch protection

`main` is protected. Settings → Branches → Add rule:

| Setting | Value |
| --- | --- |
| Branch name pattern | `main` |
| Require a pull request before merging | on, 1 approval |
| Dismiss stale approvals on new commits | on |
| **Require status checks to pass** | on, **strict** (branch must be up to date) |
| Required checks | **`ci`** |
| Require conversation resolution | on |
| Do not allow bypassing | on (yes, including administrators) |
| Allow force pushes / deletions | off |

Require the single aggregate check `ci`, not the individual jobs. `ci` in
`.github/workflows/ci.yml` depends on `typecheck`, `lint`, `api tests` and
`build` and fails if any of them did not succeed, so adding a job later does not
mean editing the protection rule and does not leave a new job silently optional.

The `api tests` job runs against a real Postgres 16 service container with the
real migrations applied, and asserts before the tests that the schema guarantees
are present — `next_trip_reference`, the append-only audit trigger,
`trip_offers_one_accepted_uq` and `trips_engaged_requires_volunteer_chk`. A
stubbed database would not exercise the parts that carry the correctness of this
system, because they live in SQL.

`build` compiles all three workspaces, asserts the API emitted
`dist/index.js`, `dist/db/migrate.js` and `dist/jobs/worker.js`, builds both
container stages, and smoke-tests that the image rejects an invalid
configuration at boot.

**The browser suite does not run in CI.** `scripts/e2e.sh` is a local command;
nothing in `ci.yml` starts Postgres, builds the SPA and runs Playwright. Adding
it is a job that needs a database service and a browser image.

`deploy.yml` gates on CI's result via `workflow_run`, and deploys the commit CI
actually tested (`github.event.workflow_run.head_sha`), not whatever `main` has
drifted to.

Add `FLY_API_TOKEN` as a repository secret (Settings → Secrets → Actions):

```bash
fly tokens create deploy --app rvc-dispatch-api --name github-actions
```

Use a deploy-scoped token, not a personal one. Rotate it when anyone with access
leaves.

---

## Migrations

**Rule: every migration must be backward-compatible with the version currently
running.** `release_command` applies migrations before the new machines take
traffic, so the *old* code runs against the *new* schema for the length of a
rolling deploy.

| Safe in one deploy | Needs two or three |
| --- | --- |
| add a nullable column | rename a column → add new, dual-write, backfill, deploy, drop old |
| add a table | change a type → add new column, backfill, switch reads, drop old |
| add an index (use `CONCURRENTLY` on a large table) | add `NOT NULL` → add nullable, backfill, then set |
| add a CHECK as `NOT VALID`, then `VALIDATE` | drop a column still read by the running version |
| relax a constraint (0005 is the worked example) | tighten a constraint that existing rows violate |

Writing one:

```bash
# 1. edit apps/api/src/db/schema.ts
npm run db:generate --workspace=@rvc/api    # -> apps/api/drizzle/000N_*.sql
# 2. READ the generated SQL
# 3. add constraints/triggers the ORM cannot express, in the same file
# 4. test against a copy of production volume
scripts/backup.sh --local-only
scripts/restore.sh --file backups/<latest>.dump --target postgres://…/rvc_migration_test
DATABASE_URL=postgres://…/rvc_migration_test npm run db:migrate
```

Time it on that copy. Anything that takes a lock for more than a second or two on
`trips` or `users` needs a plan, not a deploy.

Note that migration 0004 runs `CREATE EXTENSION IF NOT EXISTS btree_gist`, which
needs a role permitted to create extensions. Fly Postgres allows this for the
attached superuser; a managed provider that does not will fail the release
command, which is the correct failure.

Drizzle records applied migrations in `drizzle.__drizzle_migrations` and takes an
advisory lock, so concurrent starts are safe and re-running is a no-op. That is
why the container entrypoint can also run migrations without racing the
release_command.

**There is no `down` migration.** Rolling back a schema change means writing a
new forward migration.

---

## Rollback

### Code only (no migration in the bad release)

```bash
fly releases --app rvc-dispatch-api
fly deploy --app rvc-dispatch-api --image registry.fly.io/rvc-dispatch-api:<previous-tag>
```

Roughly 60 seconds. This is the common case, and it is why migrations are kept
backward-compatible: rolling the code back does not require rolling the schema
back.

### The release is stuck mid-deploy

```bash
fly status --app rvc-dispatch-api
fly machine restart <id> --app rvc-dispatch-api
# or take a bad machine out of rotation
fly machine stop <id> --app rvc-dispatch-api
```

### The migration was the problem

1. **Stop the bleeding.** Roll the code back to the previous image. If the
   migration was additive, the old code ignores the new column and the system is
   fine.
2. **If the schema must change back**, write a forward migration that undoes it
   and deploy that. Do not hand-edit production SQL: the next deploy will replay
   `drizzle/` and disagree with you.
3. **If data was lost**, this is a restore, not a rollback. Go to
   [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md#restoring-production) and accept
   that trips created since the backup will need re-entering from the
   dispatchers' notes.

### Post-rollback checklist

```bash
curl -s https://api.dispatch.refuahvchesed.org/health
fly logs --app rvc-dispatch-api | tail -50
# as a dispatcher:
#   GET /api/ops/health              → dead jobs, failed deliveries
#   GET /api/notifications/deliveries?status=failed
#   GET /api/board/context           → duty, unread messages, applications
```
Then: create a test trip, offer it to yourself, accept it, complete it. Two
minutes, and it tests the part that matters.

---

## Scaling for 500+ volunteers

The workload is not "500 concurrent users". It is bursty: quiet, then a
dispatcher broadcasts and N volunteers get a message within a few seconds, and a
handful of them open the app.

### What one broadcast costs

`dispatch.offer_batch_size` (default 40) caps how many volunteers one round asks,
so a broadcast is bounded regardless of roster size. For N recipients,
`offerTrip` does, in **one transaction**:

- 1 targeting query over the roster
- N `INSERT`s into `trip_offers`
- N calls to `notify()` → N `notifications` + 3N `notification_deliveries`
  (offers force SMS and push, and in-app is always added)
- N + 2 `INSERT`s into `jobs` (one expiry each, one reminder, one escalation)
- 1 `UPDATE` on `trips`, 1 `INSERT` into `audit_events`

Then the worker sends N messages at `WORKER_CONCURRENCY` (default 4) per tick
(default 2s). **If the tail of a broadcast is arriving too late, raise
`WORKER_CONCURRENCY` before doing anything else.** 10–15 is comfortable against a
10-connection pool.

### Order of operations when it gets slow

1. **`WORKER_CONCURRENCY`** — the cheapest fix for slow broadcasts.
2. **Machine memory**, `shared-cpu-1x` 512MB → 1GB. Watch RSS after a large
   broadcast.
3. **The database.** More API machines multiply `DATABASE_POOL_MAX`; adding
   connections to an undersized Postgres makes things worse. Scale Postgres first.
4. **More API machines**, `min_machines_running = 3`. Safe: the queue claims with
   `FOR UPDATE SKIP LOCKED`, each machine holds its own LISTEN connection, and
   the dedupe key stops two machines duplicating the daily scheduled work.
5. **Split the worker out** (below).

### The numbers to watch

| Signal | Where | Act when |
| --- | --- | --- |
| overdue jobs | `GET /api/ops/health` → `jobs.overdue` | persistently > 0 |
| dead jobs | same → `jobs.dead` | > 0 at all |
| failed deliveries (24h) | same → `deliveries.failed` | > 2% of `delivered` |
| p95 on `POST /trips/:id/offer` | Fly metrics | > 2s |
| database connections | `fly postgres connect` → `select count(*) from pg_stat_activity` | > 70% of `max_connections` |
| SSE connections | one per open dispatcher tab | budget per dispatcher, not per volunteer |
| object-storage size | the bucket | licence images and exports accumulate; exports self-delete after 7 days, images do not |

### Do not

- **Do not enable `auto_stop_machines`** and do not scale to zero. A stopped
  machine runs no worker: offers never expire, nothing escalates, no SMS is sent,
  standing rides are not materialised and equipment reminders do not go out.
  `fly.toml` sets `auto_stop_machines = false` for this reason.
- **Do not add regions outside Canada.**

### When to split the worker out

`RUN_WORKER_IN_PROCESS=true` today. Split it when **any** of these is true:

1. A broadcast noticeably slows HTTP requests — the worker and the API are
   competing for the same event loop.
2. You want more worker throughput without more HTTP capacity, or vice versa.
3. Worker work becomes long-running (a large export, a bulk import) and starts
   blocking request handling.
4. You need to pause the worker independently — during a migration, or while a
   provider is misbehaving — without taking the API down.

How, with no code change:

```bash
fly apps create rvc-dispatch-worker
fly secrets set --app rvc-dispatch-worker \
  DATABASE_URL="<same as the API>" SESSION_SECRET="<same>" \
  FIELD_ENCRYPTION_KEY="<same>" \
  TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… TWILIO_PHONE_NUMBER=… \
  VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… \
  EMAIL_PROVIDER=… SMTP_HOST=… WAHA_BASE_URL=… \
  FILE_STORAGE_DRIVER=s3 S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
  APP_URL="<same>" \
  RUN_WORKER_IN_PROCESS=true
# fly.worker.toml: same image, no [http_service], and
#   processes = ["node dist/jobs/worker.js"]

# then, on the API:
fly secrets set --app rvc-dispatch-api RUN_WORKER_IN_PROCESS=false
```

Order matters: start the worker app first, confirm it is claiming jobs
(`jobs.pending` falling), *then* turn the in-process worker off. Reversed, the
queue stops draining for as long as the gap lasts, which means offers stop
expiring and nothing is sent.

The worker needs the **same** provider credentials — it is the process that
actually sends — the **same** `FIELD_ENCRYPTION_KEY` and file storage, because it
writes exports, and `APP_URL`, because it builds the deep links inside message
bodies.

---

## Known gaps

Things an operator will trip over, stated plainly:

- **No error aggregation.** `SENTRY_DSN` is honoured by `initMonitoring()` but
  `@sentry/node` is not a dependency of `@rvc/api`; with a DSN set and the package
  missing the API logs an error at boot and errors go to the logs only. Either
  `npm i @sentry/node -w @rvc/api` or leave the DSN unset.
- **No alerting.** The alert names in
  [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md#alerts) are what you should
  configure, not what is running.
- **The browser suite does not run in CI.** It runs locally through
  `scripts/e2e.sh`.
- **`ci.yml` still passes `--passWithNoTests` to vitest**, from when the API had
  no tests. It has fifteen test files now; remove the flag so an empty suite
  fails loudly again.
- **`fly.web.toml` is not in the repository.** The SPA deploy step in
  `deploy.yml` skips with a notice until it exists.
- **The Dockerfile still rewrites `packages/shared/package.json`'s `exports`
  field** to point at `dist`. The package manifest already declares exactly that,
  so the step is now a no-op that can be deleted.
- **`docker-compose.yml` still says the web service will exit** because there is
  no app shell. There is one; `docker compose up` brings up all three services.
- **Invite and password-reset links are not emailed.** `issueAuthToken` logs the
  link and returns it to the administrator; only applicant messages go out through
  the email provider.
- **Rotating `FIELD_ENCRYPTION_KEY` is not supported.** Nothing re-encrypts
  existing values. Losing it loses every stored licence number and every
  encrypted file.
- **Object storage is not covered by the database backup.** A licence image or an
  export lives in the bucket; back that up separately.
- **No automated dependency or image scanning in CI.**
