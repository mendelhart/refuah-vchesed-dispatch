# Refuah V'Chesed Dispatch

Volunteer medical-transport dispatch for Refuah V'Chesed, Montreal. A dispatcher
takes a call ("my mother needs a ride to the Jewish General at 2pm Thursday"),
creates a trip, and the system asks the volunteers who could actually take it.
One of them accepts — in the app, from a push notification, or by replying to an
SMS — and everyone else is told immediately that it is gone.

Around that core it also runs the standing rides that make up much of the
week's work, the two-way SMS conversations volunteers and callers actually send,
volunteer signup and onboarding, the equipment lending register, the phone-duty
roster, and the reports the organisation produces every month.

This replaces a Base44 application whose failure modes are the reason most of the
design decisions here look the way they do: offers that were SMS side effects
rather than records, a 4-digit trip code used as an authorisation token, two
competing masked-calling implementations (one of which would dial any number you
asked it to), and nothing at all that ran when a browser tab was closed. Every
"why is it like this" answer lives in `docs/`.

**New to the organisation rather than the codebase?** Read
[docs/PRODUCT.md](docs/PRODUCT.md) instead of this file.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22, ESM, TypeScript 5.8 strict | `noUncheckedIndexedAccess` on; the compiler is the first reviewer |
| API | Fastify 5 | schema-first, fast, first-class raw-body access for Twilio signatures |
| Database | PostgreSQL 16 | the state machine's guarantees are CHECK constraints, partial unique indexes and an exclusion constraint, not application code |
| ORM | Drizzle | SQL you can read, migrations that are plain `.sql` files |
| Queue | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED` | one fewer service to run, back up and be locked into. The dedupe key is also the whole scheduler |
| Realtime | Postgres `LISTEN/NOTIFY` → Server-Sent Events | no Redis, no websocket server |
| Web | React 18, Vite 6, Tailwind, shadcn/ui, TanStack Query | a PWA: installable, and a claimed trip is readable offline |
| SMS / voice | Twilio, behind a provider interface | swappable in one file |
| Email | SMTP via nodemailer | four environment variables move the organisation between Workspace, Postmark, SES or a shared host |
| WhatsApp | the organisation's existing WAHA server | never the sole carrier for anything |
| Push | Web Push (VAPID) | no vendor, no app store |
| Files | local disk or S3-compatible, encrypted at rest | licence photographs are the most sensitive object here |
| Geocoding | Nominatim, proxied server-side | the browser never talks to the geocoder |
| Calendar | `@hebcal/core` | Shabbos and yom tov boundaries are dispatch information, not decoration |
| Hosting | Fly.io, region `yyz` (Toronto) | Canadian data residency is a requirement |

Monorepo, npm workspaces. Node 22 is required (`.nvmrc`).

---

## Get it running in five minutes

### 1. Prerequisites

```bash
node --version      # must be 22.x — `nvm use` reads .nvmrc
docker --version    # for Postgres; a local Postgres 16 works too
```

### 2. Install

```bash
git clone <repo-url> rvc-dispatch
cd rvc-dispatch
npm ci
```

### 3. Start Postgres

```bash
docker run -d --name rvc-pg \
  -e POSTGRES_USER=rvc -e POSTGRES_PASSWORD=rvc_local_dev_only -e POSTGRES_DB=rvc_dev \
  -p 5432:5432 postgres:16-alpine
```

### 4. Set the two variables the API insists on

Copy the example file and edit it:

```bash
cp .env.example .env
```

`npm run dev`, `db:migrate` and `db:seed` read `.env` through Node's own
`--env-file-if-exists`, so no dotenv dependency is involved and the file is
optional — variables already exported in your shell win, and a missing `.env` is
not an error. Everything that runs the compiled build (`npm start`, Docker, Fly)
takes its configuration from the environment as usual; `.env` is a development
convenience, not a deployment mechanism.

Locally only two are mandatory — `DATABASE_URL` and a `SESSION_SECRET` of at
least 32 characters:

```bash
DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_dev
SESSION_SECRET=<openssl rand -base64 48>
```

Everything else has a working default. No Twilio account, no VAPID keys, no SMTP
host and no WAHA server are needed: with `NODE_ENV` unset (so `development`) the
API selects the in-memory SMS, push, calling, email, WhatsApp and file providers.
They accept every send, record it in memory for the tests to assert on, and
return a fake provider id — so nothing leaves the machine, and the delivery row,
the notification and the outbound `sms_events` entry (which carries the message
body) are all written exactly as they would be in production.

Add a third if you want to exercise licence uploads, which refuse to store
anything rather than storing it in clear when it is missing:

```bash
export FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)   # must be exactly 32 bytes
```

### 5. Migrate and seed

```bash
npm run build --workspace=@rvc/shared   # the API's tsconfig references it
npm run db:migrate                      # applies apps/api/drizzle/*.sql
npm run db:seed                         # 3 groups, 5 people, 2 trips
```

The seeder prints the shared development password. Sign in as any of:

| Email | Role |
| --- | --- |
| `admin@refuahvchesed.test` | admin |
| `dispatch@refuahvchesed.test` | dispatcher |
| `volunteer1@refuahvchesed.test` | volunteer |

Password for all of them: `ChangeMeInDev123!` (`apps/api/src/db/seed.ts`). The
seeder refuses to run against `NODE_ENV=production`.

Reference data — the volunteer groups, the five service types, the default
settings and every message template — is created by `bootstrapReferenceData()` at
every boot, in every environment, idempotently. It never overwrites an
administrator's edits.

### 6. Run

```bash
npm run dev          # API on :8080, web on :5173
```

Check it:

```bash
curl -s localhost:8080/health
# {"status":"ok","time":"..."}
```

Open http://localhost:5173 and sign in as the dispatcher. Create a trip, press
Offer, then sign in as `volunteer1` in a private window and accept it — that is
the whole product in ninety seconds. To read the text the volunteer "received",
look at `sms_events` or the in-app notification feed; the in-memory provider
records the message rather than printing it.

### Or: the whole stack in Docker

```bash
docker compose up --build
docker compose exec api npm run db:seed --workspace=@rvc/api
```

Postgres, the API and the Vite dev server, with health checks and a persistent
volume. `docker compose down -v` destroys the database.

---

## Everyday commands

```bash
npm run dev                 # API + web, watch mode
npm run build               # shared -> api -> web
npm run typecheck           # tsc --noEmit across all four workspaces
npm run lint                # eslint . --max-warnings=0
npm test                    # vitest, apps/api — needs a real Postgres
npm run test:e2e            # playwright, apps/web — servers must already be up
npm run db:migrate          # apply pending migrations
npm run db:seed             # development data (refuses production)
npm run migrate:base44      # the Base44 import tool — see docs/MIGRATION.md

# generate a migration after editing apps/api/src/db/schema.ts
npm run db:generate --workspace=@rvc/api
```

### Tests

The API suite runs against a real Postgres with the real migrations applied,
because the parts that carry the correctness of this system — the compare-and-set
claim, the partial unique indexes, the CHECK constraints, the append-only audit
trigger, the duty-shift exclusion constraint — live in SQL.

```bash
DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_test \
NODE_ENV=test npm test
```

Fifteen files, roughly by subject: the trip lifecycle end to end
(`lifecycle`), genuinely simultaneous acceptance (`concurrency`), the six
targeting filters and what they must *not* exclude (`targeting`), the database
guarantees themselves (`database`), authorisation and the read projections
(`authz`, `privacy`), signed Twilio webhooks (`sms-webhook`), conversations
(`conversations`), signup and approval (`applications`), templates, delivery
channels and licences (`communications`), delivery failure and retry
(`notifications`), masked calling (`calling`), standing rides and duplication
(`recurring`), the duty roster, equipment, exports, broadcasts and the calendar
(`operations`), and authentication with the cryptographic primitives (`auth`).

### The browser suite

```bash
DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_e2e scripts/e2e.sh
DATABASE_URL=… scripts/e2e.sh --project=phone       # arguments pass through
```

`scripts/e2e.sh` migrates and seeds the database you name, builds all three
workspaces, starts the API and a `vite preview` of the built SPA, waits for both,
and runs Playwright against them. `DATABASE_URL` is the only variable you must
supply — it will be written to. Two projects run, `phone` (Pixel 7) first because
that is the screen most volunteers actually use, then `desktop`.

It does not use Playwright's `webServer`: when the API fails to start, this
prints the API's own error instead of a browser timeout thirty seconds later. The
browser suite does not currently run in CI.

### Backups

```bash
scripts/backup.sh --local-only         # dump + verify, no upload
scripts/verify-backup.sh --file <dump> # restore it into a scratch DB and assert
scripts/restore.sh --help
```

---

## Words used in the code vs. on screen

A few names changed on screen after the code was written. The code and the
database keep the old names so nothing has to be migrated.

| In the code / database | On screen | Notes |
| --- | --- | --- |
| `dispatcher` (role) | Coordinator | Can add, edit, message, pause and remove **volunteers only**. Anything touching a coordinator or admin needs an admin. The rule lives in one place: `apps/api/src/auth/permissions.ts`. `requireDispatcher` means "coordinator or admin". |
| `admin` (role) | Admin | Everything, including exports, settings, templates and resetting two-step sign-in. |
| `volunteer` (role) | Volunteer | Sees only their own rides and offers. |
| `trip` | Ride / trip | One request on the board. |
| `recurring` | Standing rides | Templates that turn into ordinary trips. |
| `deactivate` | Remove | Clears phone and email and blocks sign-in; kept in the audit log with a reason. |
| `suspend` | Pause | Keeps the person on file; optional end date. |

## Layout

```
apps/
  api/                    Fastify API + background worker (one process)
    src/routes/           HTTP surface; one endpoint per state transition
    src/domain/           dispatch.service.ts is the engine; all writes are here
                          targeting · recurring · callers · conversations ·
                          applications · licences · volunteer · duty · exports ·
                          announcements · equipment · calls
    src/services/         notification.service.ts, templates, files, and
                          providers/ — the vendor edge
    src/jobs/             Postgres-backed queue, worker and handlers
    src/auth/             sessions, guards
    src/lib/              crypto, offer codes, phone, audit, settings, time,
                          hebcal, errors, monitoring
    src/db/               drizzle schema, client, migrate, bootstrap, seed
    src/test/             vitest, against a real Postgres
    drizzle/              *.sql migrations. 0001 and 0004 hold the constraints
  web/                    React SPA (Vite), a PWA
    src/pages/            one file per screen; admin screens under admin/
    src/components/ui/    VENDORED shadcn/ui — not linted, re-vendored on upgrade
    e2e/                  Playwright: dispatch, navigation, accessibility, PWA
packages/
  shared/                 domain vocabulary, zod schemas, API types.
                          TRIP_STATE_MACHINE, SETTING_KEYS, TEMPLATE_KEYS and
                          CRITICAL_NOTIFICATION_EVENTS live here and are the
                          single source of truth
tools/
  migrate/                one-shot Base44 importer
scripts/                  backup / restore / verify-backup / e2e / docker entrypoint
docs/                     everything below
```

The API and the web app share `@rvc/shared`, so a status the server refuses is a
status the client cannot offer.

---

## Where to go next

| If you want to… | Read |
| --- | --- |
| understand what the product does, by role | [docs/PRODUCT.md](docs/PRODUCT.md) |
| understand the shape of the system and why | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| look up an endpoint | [docs/API.md](docs/API.md) |
| know what a table or a constraint is for | [docs/DATABASE.md](docs/DATABASE.md) |
| review the authorisation model, the privacy boundary, the threat model | [docs/SECURITY.md](docs/SECURITY.md) |
| deploy it, configure it, or scale it | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| know the backup schedule and how to restore | [docs/BACKUP_AND_RESTORE.md](docs/BACKUP_AND_RESTORE.md) |
| run the Base44 cutover | [docs/MIGRATION.md](docs/MIGRATION.md) |
| handle a 2am "nobody got the text" | [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md) |

---

## Contributing

`main` is protected. A pull request merges when the `ci` status check is green,
which requires typecheck, lint, the API tests against a real Postgres 16, and a
successful container build. See
[docs/DEPLOYMENT.md#branch-protection](docs/DEPLOYMENT.md#branch-protection) for
the exact required-checks configuration.

Rules that are not negotiable:

1. **No endpoint may write `trips.status` directly.** Add a transition to
   `TRIP_STATE_MACHINE` and a function in `dispatch.service.ts`.
2. **No vendor SDK outside `src/services/providers/`.** If you need Twilio
   somewhere, you need a method on the provider interface.
3. **No string literal for a domain concept outside `packages/shared/src/domain.ts`.**
   Statuses, events, channels, template keys and setting keys are all defined
   there and nowhere else.
4. **An invariant that must never be violated belongs in the database.** If the
   rule is "this cannot happen", it is a constraint or a trigger, not a careful
   code path.
5. **Nothing may send a message without a record of the attempt.** Go through
   `notify()`, or — for applicants and equipment borrowers, who have no user row —
   record the attempt in the audit log.

---

## Known gaps

Things that are deliberately not finished, so nobody discovers them at 2am:

- **No error aggregation.** `SENTRY_DSN` is honoured by `initMonitoring()`, which
  imports `@sentry/node` at runtime — but that package is not a dependency of
  `@rvc/api`. With a DSN set and the package absent the API logs an error at boot
  and errors go to the logs only.
- **No alerting.** The alert names in the runbook are what you should configure,
  not what is running.
- **The browser suite does not run in CI**, and `ci.yml` still passes
  `--passWithNoTests` to vitest from when there were no API tests. There are
  fifteen test files now; the flag should go.
- **Invite and password-reset links are not emailed.** `issueAuthToken` logs the
  link and returns it to the administrator, who passes it on. Applicant messages —
  including the approval that carries an invite link — *are* sent through the
  email and SMS providers.
- **Rotating `FIELD_ENCRYPTION_KEY` is not supported.** Nothing re-encrypts
  existing values, and losing the key loses every stored licence number and every
  encrypted file.
- **Object storage is not covered by the database backup.** Licence images and
  exports live in the bucket, not in the dump.
- **No automated dependency or container scanning in CI.**

These are tracked in the code with the same wording. Fix them, then delete the
bullet.

## Role naming

The internal `dispatcher` role is labeled Coordinator in the app. Coordinators manage volunteers; only admins manage coordinators and admins.
