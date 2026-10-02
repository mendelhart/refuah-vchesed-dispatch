# Staging: a safe copy to try things on

Staging is a throwaway copy of the app filled with **invented** people. Use it
to try a change, take phone screenshots, or rehearse a migration before it
goes near the real system.

Three rules, no exceptions:

1. **Never put real data in it.** Do not restore a production backup onto a
   laptop or a staging database. The seed below makes everything you need.
2. **Never put real messaging credentials in it.** With no Twilio, SMTP, WAHA
   or VAPID settings, every message is recorded and nothing is sent (see
   "Where the messages go"). In development and test, a credential that *is*
   set is used for real, so keep them out of `.env`.
   The staging passwords below are published in this file: never make a
   staging copy reachable from the internet.
3. **Throw it away when you are done.** Nothing in staging is kept.

## Start one (about five minutes)

You need Docker, or Postgres 16 or newer (production runs 18) on your machine.

```sh
# 0. Local settings (no real credentials in here, ever). Fill in
#    SESSION_SECRET and FIELD_ENCRYPTION_KEY as the comments in it say.
cp .env.example .env

# 1. A database. With Docker:
docker compose up -d db
export DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_dev

# 2. The schema (same migrations production runs).
npm run db:migrate

# 3. Invented people and two months of history.
npm run db:seed:staging

# 4. The app.
npm run dev
```

Sign in at <http://localhost:5173>:

| Who | Email | Password |
|---|---|---|
| Coordinator | `coordinator.a@staging.rvc.test` | `StagingOnly-NotSecret-123!` |
| Volunteer | `volunteer01@staging.rvc.test` | `StagingOnly-NotSecret-123!` |
| Admin (from the dev seed) | `admin@refuahvchesed.test` | `ChangeMeInDev123!` |

## What the seed makes

- 3 coordinators and 40 volunteers (3 of them inactive), with weekly availability
- 20 callers, some with access notes
- about 130 rides from 60 days ago to 7 days ahead: completed, cancelled,
  pending, offered and assigned; a few are flagged as test rides
- 24 pieces of equipment, 10 loans (4 returned, the rest out, some overdue)
- 3 vehicles and a week of phone-duty shifts

Every name is made up, every email ends in `.test`, and every phone number is
in the 555-01xx range kept for fiction. The random generator is seeded, so
every run makes the same people and the same pattern of rides; the dates are
counted from the day you run it.

## The seed refuses to run when

- `NODE_ENV=production`
- the database is not on this machine (`localhost`, `127.0.0.1`, or the
  compose service `db`/`postgres`). For a throwaway database elsewhere, name it
  exactly: `STAGING_SEED_ALLOW_HOST=<host> npm run db:seed:staging`
- the database already holds a real-looking person: a staff or volunteer
  email that is not `.test`, an account with no email and a non-555 number, or
  a caller or ride passenger with a non-555 number. That would mean it is not
  a staging database.

Running it twice does nothing the second time. If a run stopped part-way, the
next run says so and asks you to start again (below).

## Where the messages go

Nothing leaves the machine. Each SMS, email, WhatsApp, push or call is
recorded as a delivery row and logged instead:

- in the app: **Admin → Notifications** shows every message that "would have
  been sent", to whom and with what text
- in the API log: a line per message
- in tests: `captured` and `capturedExtra` from `services/providers/inmemory.ts`;
  `fake-messaging.test.ts` fails if any channel in CI is not the fake one

## Start again

```sh
docker compose down -v      # deletes the staging database volume
docker compose up -d db && npm run db:migrate && npm run db:seed:staging
```

## In CI

CI builds its own empty database for every run (`.github/workflows/ci.yml`)
and has no provider credentials. Nothing there can reach a real person.
