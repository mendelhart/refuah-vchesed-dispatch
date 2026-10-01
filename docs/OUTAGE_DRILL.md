# Outage drill and alerts

What happens when something breaks, how to rehearse it safely, and who gets
told. Written for the free-tier setup: the API sleeps when idle, the worker
runs inside it, and the free database can be switched off when idle.

## What the app does when things break

| What breaks | What people see | What the app does | What happens after |
|---|---|---|---|
| Database unreachable | Screens cannot load or save | `/health` answers **503**; the API keeps running | Reconnects on its own when the database is back, no restart needed |
| API asleep or killed | First visit takes about a minute | Nothing runs: no offers, reminders or escalations | On boot, jobs that came due while asleep run once (catch-up) |
| API crashes | Same as asleep | The crash is logged (and sent to Sentry if set up); the host starts it again | Same catch-up on boot |

Each of these is checked by the drill below. Nothing is lost and nothing is
done twice: jobs live in the database, are claimed with a lock, and record
their attempts.

## Run the drill (local, throwaway database only)

```sh
docker compose up -d db
export DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_dev
npm run db:migrate
scripts/outage-drill.sh
```

It starts the API, then on purpose:

1. stops the database: `/health` must answer 503 and the API must stay up
2. starts it again: `/health` must be 200 without restarting the API
3. runs the API with the worker off and adds a due job: the job must wait
4. restarts with the worker on: the job must run, exactly once
5. kills the API with `kill -9` and starts it again: it must come up healthy

It prints PASS or FAIL per step and exits non-zero on any failure.

It refuses to start unless the database is on this machine, has a throwaway
name (`rvc_dev`, `rvc_test`, `rvc_e2e`, `*_drill` or `*_staging`; or the one
named in `DRILL_ALLOW_DB`), and holds only invented people, the same rule as
the staging seed. A tunnel to a real database looks like `localhost`, which is
why the name and contents are checked too. With the default Docker commands
it also refuses when `DOCKER_HOST` or another Docker context is active, and it
stops at step 1 if the stop command did not actually stop that database. The
API it starts has no messaging, storage or verification credentials, so it
cannot send anything or call any outside service.

Not using Docker? Pass your own commands:
`DB_STOP_CMD="..." DB_START_CMD="..." scripts/outage-drill.sh`.

The first run of this drill found a real defect: with the database down,
`/health` answered 500 instead of 503 because the rate limiter (which keeps
its counters in the database) ran first. Health checks are now outside the
rate limiter; `health-rate-limit.test.ts` keeps it that way. Only the plain
`/health` (one `select 1`) is exempt: `/health/deep` runs several queries and
is still rate-limited.

Run it after any change to the worker, the job queue, the database client or
start-up, and once a quarter otherwise.

## Alerts: who gets told

Two things, both free, both **off until Mendel turns them on**:

**1. Error reports (Sentry).** Already built in. Set `SENTRY_DSN` on rvc-api to
a free Sentry project's DSN. Unhandled errors, crashes, worker failures and
jobs that run out of retries are reported there. With it unset, errors go to
the Render logs only. Sentry stores error details; set its data scrubbing on
before connecting it, because a stack trace can include a request's content.

**2. Uptime check.** A free monitor (for example UptimeRobot or Better Stack)
calling the API on a schedule and emailing when it fails:

- URL: `https://<rvc-api host>/health` (database round trip, no personal data)
- or `https://<rvc-api host>/health/deep?token=<HEALTH_CHECK_TOKEN>` for the
  full checklist (worker ticking, stuck or dead jobs, standing rides created).
  Keep the token out of shared screenshots.
- Alert after 2 failures in a row, so one slow wake-up is not an alert.

**Watch the free hours.** Each call wakes the API, and it then stays awake
for 15 minutes. A monitor every 5 minutes keeps it awake all day: about 744
hours a month for the API alone, against 750 free hours shared by both Render
services, so the web service would run out (see FIX_PLAN_PROGRESS.md, item 1,
where keep-awake was deliberately left off for this reason). On the free plan,
either check no more often than every hour, or limit checks to daytime hours.
The upside of more frequent checks (the worker runs on time, and Aiven sees
regular activity so is less likely to power the database off) has to be
weighed against that.

Neither costs money (as long as the free hours hold). Both are new outside services that receive the app's
address (and, for Sentry, error details), which is why they are his decision.
