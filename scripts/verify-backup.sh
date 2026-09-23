#!/usr/bin/env bash
#
# verify-backup.sh — prove the latest backup actually restores.
#
# backup.sh checks that a dump is *readable*. This script checks that it is
# *usable*: it creates a scratch database, restores the newest backup into it,
# asserts that the tables that carry the organisation's work are non-empty and
# internally consistent, and then throws the scratch database away.
#
# This is the difference between having backups and being able to recover.
# Schedule it weekly (see docs/BACKUP_AND_RESTORE.md); a failure here is a
# page-worthy alert even though nothing is currently broken in production.
#
# Exits non-zero if the backup cannot be restored or the restored data fails an
# assertion.
#
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/verify-backup.sh [--file <dump>] [--keep] [--min-trips N]

Restores a backup into a throwaway database and asserts it contains real data.

Options:
  --file PATH        Verify this dump instead of downloading the newest remote
                     one. Useful right after running backup.sh --local-only.
  --keep             Do not drop the scratch database afterwards, so you can
                     poke at it. Prints the connection string.
  --min-trips N      Minimum trips expected (default: 1). Raise it in
                     production — a real database that suddenly restores with
                     3 trips is a silent data-loss incident.
  --min-users N      Minimum users expected (default: 1).
  -h, --help         This text.

Required environment:
  ADMIN_DATABASE_URL   A postgres:// URL with CREATE DATABASE rights on the
                       cluster used for the scratch restore. This should be a
                       NON-PRODUCTION cluster: a dev machine, a CI service
                       container, or a temporary Fly Postgres. It must not be
                       the live database.

Required unless --file is given:
  BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  BACKUP_S3_ENDPOINT   for Backblaze B2 / Cloudflare R2 / Wasabi
  BACKUP_S3_PREFIX     default: dispatch
  BACKUP_S3_REGION     default: ca-central-1

Example (weekly drill against a dev cluster):
  ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  BACKUP_S3_BUCKET=rvc-dispatch-backups \
  BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
  scripts/verify-backup.sh --min-trips 50 --min-users 20
USAGE
}

FILE=""
KEEP=false
MIN_TRIPS=1
MIN_USERS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --file)       FILE="${2:-}"; shift 2 ;;
    --keep)       KEEP=true; shift ;;
    --min-trips)  MIN_TRIPS="${2:-1}"; shift 2 ;;
    --min-users)  MIN_USERS="${2:-1}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "verify-backup: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

log()  { printf '[verify %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { printf '[verify FAIL] %s\n' "$*" >&2; exit 1; }
ok()   { printf '[verify  ok ] %s\n' "$*" >&2; }

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required (see --help)}"
command -v psql >/dev/null || fail "psql not found"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -x "${HERE}/restore.sh" ] || fail "scripts/restore.sh not found next to this script"

# Refuse to run the drill against anything that looks live.
case "$ADMIN_DATABASE_URL" in
  *dispatch-api*|*rvc_prod*|*rvc-prod*|*production*)
    fail "ADMIN_DATABASE_URL looks like production. Use a separate cluster." ;;
esac

SCRATCH_DB="rvc_verify_$(date -u +%Y%m%d%H%M%S)_$$"
# Swap the database component of the admin URL for the scratch database.
SCRATCH_URL="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]+(\?|$)#/${SCRATCH_DB}\1#")"
SAFE_SCRATCH="$(printf '%s' "$SCRATCH_URL" | sed -E 's#(//[^:/@]+):[^@]*@#\1:****@#')"

drop_scratch() {
  if [ "$KEEP" = true ]; then
    log "--keep: leaving ${SCRATCH_DB} in place (${SAFE_SCRATCH})"
    return
  fi
  psql "$ADMIN_DATABASE_URL" -q -c \
    "drop database if exists \"${SCRATCH_DB}\" with (force)" >/dev/null 2>&1 || true
}
trap drop_scratch EXIT

# ---------------------------------------------------------------------------
# 1. Scratch database
# ---------------------------------------------------------------------------
log "creating scratch database ${SCRATCH_DB}"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create database \"${SCRATCH_DB}\"" \
  || fail "could not create the scratch database — does this role have CREATEDB?"

# ---------------------------------------------------------------------------
# 2. Restore, through the same script an operator would use in an incident.
# ---------------------------------------------------------------------------
if [ -n "$FILE" ]; then
  log "restoring ${FILE}"
  "${HERE}/restore.sh" --file "$FILE" --target "$SCRATCH_URL" --force \
    || fail "restore.sh failed for ${FILE}"
else
  log "restoring the newest remote backup"
  "${HERE}/restore.sh" --latest-remote --target "$SCRATCH_URL" --force \
    || fail "restore.sh failed for the newest remote backup"
fi

# ---------------------------------------------------------------------------
# 3. Assertions.
#
# Each one is a question an operator would ask on the morning after a disaster.
# A restore that "succeeds" with empty tables must fail here.
# ---------------------------------------------------------------------------
q() { psql "$SCRATCH_URL" -Atc "$1"; }

log "asserting the restored data is real"

FAILURES=0
assert_min() { # name value minimum
  if [ "${2:-0}" -lt "$3" ]; then
    printf '[verify FAIL] %s = %s, expected at least %s\n' "$1" "${2:-0}" "$3" >&2
    FAILURES=$((FAILURES + 1))
  else
    ok "$1 = $2"
  fi
}

USERS="$(q 'select count(*) from users')"
TRIPS="$(q 'select count(*) from trips')"
# NB: not GROUPS — that is a special bash variable and assigning to it fails.
GROUP_COUNT="$(q 'select count(*) from volunteer_groups')"
SETTINGS="$(q 'select count(*) from settings')"
AUDIT="$(q 'select count(*) from audit_events')"
ADDRESSES="$(q 'select count(*) from addresses')"

# The critical tables. An empty `users` or `trips` means the dump captured
# structure but not content — the classic silent backup failure.
assert_min "users"             "$USERS"     "$MIN_USERS"
assert_min "trips"             "$TRIPS"     "$MIN_TRIPS"
assert_min "volunteer_groups"  "$GROUP_COUNT" 1
assert_min "settings"          "$SETTINGS"  1
assert_min "addresses"         "$ADDRESSES" 1
# audit_events can legitimately be small in a brand-new deployment, but in a
# running system every trip transition writes one.
assert_min "audit_events"      "$AUDIT"     0

# At least one active administrator, or nobody can administer the restored
# system.
ADMINS="$(q "select count(*) from users where role='admin' and status='active' and deleted_at is null")"
assert_min "active admins" "$ADMINS" 1

# Referential and state-machine integrity that the constraints are supposed to
# guarantee. If any of these is non-zero, the dump captured a database that was
# already inconsistent, which is worth knowing before you need it.
log "asserting integrity invariants"
check_zero() { # name query
  local n; n="$(q "$2")"
  if [ "${n:-0}" -ne 0 ]; then
    printf '[verify FAIL] %s: %s row(s)\n' "$1" "$n" >&2
    FAILURES=$((FAILURES + 1))
  else
    ok "$1: none"
  fi
}

check_zero "trips in an engaged state with no volunteer" \
  "select count(*) from trips where status in ('assigned','accepted','en_route','in_progress') and assigned_volunteer_id is null"
check_zero "trips with more than one live assignment" \
  "select count(*) from (select trip_id from trip_assignments where unassigned_at is null group by trip_id having count(*) > 1) x"
check_zero "trips with more than one accepted offer" \
  "select count(*) from (select trip_id from trip_offers where status='accepted' group by trip_id having count(*) > 1) x"
check_zero "cancelled trips with no reason" \
  "select count(*) from trips where status='cancelled' and (cancelled_at is null or cancellation_reason is null)"
check_zero "orphaned offers" \
  "select count(*) from trip_offers o left join trips t on t.id = o.trip_id where t.id is null"

# The database-level guarantees themselves.
log "asserting schema guarantees survived the round trip"
for object in \
  "function next_trip_reference|select count(*) from pg_proc where proname='next_trip_reference'" \
  "trigger audit_events_no_update|select count(*) from pg_trigger where tgname='audit_events_no_update'" \
  "trigger trips_notify_change|select count(*) from pg_trigger where tgname='trips_notify_change'" \
  "index trip_offers_one_accepted_uq|select count(*) from pg_indexes where indexname='trip_offers_one_accepted_uq'" \
  "index trip_assignments_one_live_uq|select count(*) from pg_indexes where indexname='trip_assignments_one_live_uq'" \
  "check trips_engaged_requires_volunteer_chk|select count(*) from pg_constraint where conname='trips_engaged_requires_volunteer_chk'" \
; do
  name="${object%%|*}"
  query="${object#*|}"
  n="$(q "$query")"
  if [ "${n:-0}" -lt 1 ]; then
    printf '[verify FAIL] missing %s\n' "$name" >&2
    FAILURES=$((FAILURES + 1))
  else
    ok "$name present"
  fi
done

# The append-only audit trail must still refuse writes. This is the one
# assertion that actually exercises a trigger rather than observing it.
log "asserting audit_events is still append-only"
if psql "$SCRATCH_URL" -q -c \
     "update audit_events set action = action where false" >/dev/null 2>&1; then
  : # a no-op UPDATE touches no rows, so the row trigger never fires — fine
fi
if [ "${AUDIT:-0}" -gt 0 ]; then
  if psql "$SCRATCH_URL" -q -c \
       "update audit_events set action = 'tampered' where id = (select id from audit_events limit 1)" \
       >/dev/null 2>&1; then
    printf '[verify FAIL] audit_events accepted an UPDATE — the immutability trigger is missing\n' >&2
    FAILURES=$((FAILURES + 1))
  else
    ok "audit_events rejected an UPDATE as designed"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Report
# ---------------------------------------------------------------------------
AGE_NOTE=""
if [ -z "$FILE" ]; then
  LATEST_TRIP="$(q "select coalesce(max(created_at)::text, 'none') from trips" 2>/dev/null || echo unknown)"
  AGE_NOTE=" newest trip in the backup: ${LATEST_TRIP}"
fi

if [ "$FAILURES" -gt 0 ]; then
  fail "${FAILURES} assertion(s) failed — this backup is NOT known-good.${AGE_NOTE}"
fi

log "OK — backup restores cleanly: ${USERS} users, ${TRIPS} trips, ${AUDIT} audit events.${AGE_NOTE}"
