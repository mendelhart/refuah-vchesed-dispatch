#!/usr/bin/env bash
# =============================================================================
# Outage drill — on a THROWAWAY database only.
#
# Starts the API against a local database, then breaks things on purpose and
# checks the app behaves:
#
#   1. Database unreachable  -> /health answers 503 (not a hang, not a crash),
#                               the API process stays up
#   2. Database back         -> /health is 200 again without restarting the API
#   3. Worker stopped        -> a due job waits (nothing runs while asleep)
#   4. Restart               -> the job is caught up on boot, exactly once
#   5. Hard kill mid-flight  -> a fresh start is healthy and catches up
#
# This mirrors the free-tier reality: the database can drop away and the API
# can sleep or be killed, and nothing may be lost or done twice.
#
# Usage (from the repo root, after `npm ci` and `npm run build --workspace=@rvc/shared`):
#
#   DATABASE_URL=postgres://rvc:rvc_local_dev_only@localhost:5432/rvc_dev \
#     scripts/outage-drill.sh
#
# Database control defaults to docker compose; override for other setups:
#
#   DB_STOP_CMD="docker compose stop db"     (default)
#   DB_START_CMD="docker compose start db"   (default)
#
# It refuses a database that is not on this machine, does not have a
# throwaway name, or holds anyone who is not synthetic. It never sends a
# message or calls another service: those settings are cleared for the API
# it starts.
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a throwaway local database}"
DB_STOP_CMD="${DB_STOP_CMD:-docker compose stop db}"
DB_START_CMD="${DB_START_CMD:-docker compose start db}"
PORT="${DRILL_PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t rvc-drill-XXXX.log)"
API_PID=""
PASS=0
FAIL=0

# --- refuse anything that is not a throwaway local database ------------------
read -r host dbname < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.hostname.replace(/^\[|\]$/g, ""), decodeURIComponent(u.pathname.slice(1)));
' "$DATABASE_URL")
case "$host" in
  localhost|127.0.0.1|::1|db|postgres) ;;
  *) echo "refusing: $host is not this machine. The drill stops the database on purpose." >&2; exit 2 ;;
esac
# A tunnel to a real database also looks like localhost, so the name must be a
# throwaway one too.
case "$dbname" in
  rvc_dev|rvc_test|rvc_e2e|*_drill|*_staging) ;;
  *) if [ "${DRILL_ALLOW_DB:-}" != "$dbname" ]; then
       echo "refusing: database '$dbname' is not a known throwaway name (rvc_dev, rvc_test, rvc_e2e, *_drill, *_staging)." >&2
       echo "If it really is throwaway, set DRILL_ALLOW_DB=$dbname." >&2
       exit 2
     fi ;;
esac
# The default commands act on whatever Docker engine is active; make sure it
# is this machine's.
if [ "$DB_STOP_CMD" = "docker compose stop db" ]; then
  if [ -n "${DOCKER_HOST:-}" ] || { command -v docker >/dev/null && [ "$(docker context show 2>/dev/null || echo default)" != "default" ]; }; then
    echo "refusing: DOCKER_HOST or a non-default docker context is set; the drill would stop a database on another engine." >&2
    exit 2
  fi
fi
# And it must hold only invented people (same rule as the staging seed).
real="$(psql "$DATABASE_URL" -X -A -t -q -c "
  select
    (select count(*) from users
      where case when email is null then regexp_replace(coalesce(phone,''), '\D', '', 'g') !~ '^1?514555'
                 else lower(email) not like '%.test' and lower(email) not like '%@test.local' end)
  + (select count(*) from callers where primary_phone is not null and regexp_replace(primary_phone, '\D', '', 'g') !~ '^1?514555')
  + (select count(*) from trips where caller_phone is not null and regexp_replace(caller_phone, '\D', '', 'g') !~ '^1?514555')
" 2>/dev/null || echo "unreadable")"
if [ "$real" != "0" ]; then
  echo "refusing: this database holds people who are not synthetic (or could not be checked: $real). Use a staging database." >&2
  exit 2
fi
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/health"; then
  echo "refusing: something already answers on port $PORT. Stop it or set DRILL_PORT." >&2
  exit 2
fi

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '   FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
status() { curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE/health" || true; }
psqlq() { psql "$DATABASE_URL" -X -A -t -q -c "$1"; }

start_api() {
  # $1 = run the worker in process (true/false)
  env -u TWILIO_ACCOUNT_SID -u TWILIO_AUTH_TOKEN -u SMTP_HOST -u WAHA_BASE_URL \
      -u VAPID_PRIVATE_KEY -u VAPID_PUBLIC_KEY -u SENTRY_DSN \
      -u S3_ENDPOINT -u S3_BUCKET -u S3_ACCESS_KEY_ID -u S3_SECRET_ACCESS_KEY \
      -u LICENCE_VERIFICATION_URL -u LICENCE_VERIFICATION_API_KEY \
    FILE_STORAGE_DRIVER=db LICENCE_VERIFICATION_PROVIDER=none \
    NODE_ENV=development PORT="$PORT" HOST=127.0.0.1 LOG_LEVEL="${LOG_LEVEL:-warn}" \
    RUN_WORKER_IN_PROCESS="$1" MESSAGING_TEST_MODE=true \
    SESSION_SECRET="${SESSION_SECRET:-outage-drill-session-secret-not-used-anywhere-else}" \
    FIELD_ENCRYPTION_KEY="${FIELD_ENCRYPTION_KEY:-$(node -e 'console.log(Buffer.alloc(32,9).toString("base64"))')}" \
    node --import tsx apps/api/src/index.ts >>"$LOG" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 60); do
    [ "$(status)" = "200" ] && return 0
    kill -0 "$API_PID" 2>/dev/null || { echo "API exited during start; log: $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
    sleep 1
  done
  echo "API did not become healthy in 60s; log: $LOG" >&2; exit 1
}

stop_api() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null && wait "$API_PID" 2>/dev/null || true
  API_PID=""
}

cleanup() {
  stop_api
  bash -c "$DB_START_CMD" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_db() {
  for _ in $(seq 1 30); do psqlq 'select 1' >/dev/null 2>&1 && return 0; sleep 1; done
  echo "database did not come back" >&2; exit 1
}

# A harmless job kind: it deletes long-expired sessions, and a throwaway
# database has none worth keeping. Tracked by id (a finished job's dedupe
# key is cleared by the queue).
JOB_ID=""
job_status() { psqlq "select coalesce(max(status), 'missing') from jobs where id = '$JOB_ID'"; }
job_runs() { psqlq "select coalesce(max(attempts), 0) from jobs where id = '$JOB_ID'"; }

say "boot (worker on)"
start_api true
ok "API healthy on $BASE"

say "1. database unreachable"
bash -c "$DB_STOP_CMD" >/dev/null
sleep 2
if psqlq 'select 1' >/dev/null 2>&1; then
  echo "abort: the stop command did not stop the database at DATABASE_URL. Check DB_STOP_CMD." >&2
  exit 1
fi
code="$(status)"
if [ "$code" = "503" ]; then ok "/health answers 503 while the database is down"; else bad "/health answered '$code' (expected 503)"; fi
sleep 5
if kill -0 "$API_PID" 2>/dev/null; then ok "API process still running after 5s without a database"; else bad "API process died without its database"; fi

say "2. database back"
bash -c "$DB_START_CMD" >/dev/null
wait_db
recovered=""
for _ in $(seq 1 20); do [ "$(status)" = "200" ] && { recovered=1; break; }; sleep 1; done
if [ -n "$recovered" ]; then ok "/health is 200 again without restarting the API"; else bad "/health did not recover within 20s"; fi
stop_api

say "3. worker stopped (API asleep)"
start_api false
JOB_ID="$(psqlq "insert into jobs (kind, payload, run_at) values ('cleanup.sessions', '{}', now() - interval '1 hour') returning id")"
sleep 5
st="$(job_status)"
if [ "$st" = "pending" ]; then ok "a due job waits while no worker runs"; else bad "job status '$st' with no worker (expected pending)"; fi
stop_api

say "4. restart catches up"
start_api true
for _ in $(seq 1 30); do [ "$(job_status)" = "done" ] && break; sleep 1; done
st="$(job_status)"; runs="$(job_runs)"
if [ "$st" = "done" ]; then ok "the waiting job ran after restart"; else bad "job status '$st' after restart (expected done)"; fi
if [ "$runs" = "1" ]; then ok "it ran exactly once"; else bad "it ran $runs times"; fi

say "5. hard kill, then start again"
kill -9 "$API_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true
API_PID=""
start_api true
ok "a fresh start after kill -9 is healthy"
stop_api

psqlq "delete from jobs where id = '$JOB_ID'" >/dev/null

printf '\n%d passed, %d failed. API log: %s\n' "$PASS" "$FAIL" "$LOG"
[ "$FAIL" -eq 0 ]
