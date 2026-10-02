#!/usr/bin/env bash
#
# restore.sh — restore a dump into a target database.
#
# This is a destructive operation and is written to behave like one: it prints
# exactly what it is about to overwrite, refuses to touch a database that looks
# like production unless told twice, and requires a typed confirmation unless
# --force is given.
#
# It is also the procedure in docs/BACKUP_AND_RESTORE.md — the same script for
# the drill and for the real thing, because a restore path that is only used in
# an emergency is a restore path nobody knows works.
#
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/restore.sh --file <dump> --target <database-url> [options]
       scripts/restore.sh --latest-remote --target <database-url> [options]

Restores a pg_dump custom-format archive into the target database.

Required (one of):
  --file PATH            Local .dump file produced by scripts/backup.sh
  --latest-remote        Download the newest dump from S3-compatible storage
                         (needs BACKUP_S3_BUCKET and credentials)

Required:
  --target URL           Destination postgres:// URL. THE DATA IN THIS DATABASE
                         WILL BE REPLACED.

Options:
  --force                Skip the typed confirmation. For automation only
                         (verify-backup.sh uses it against a scratch database).
  --clean                Drop existing objects before recreating them. Use for
                         restoring over a database that already has a schema.
                         Default: restore into an empty database.
  --jobs N               Parallel restore workers (default: 4). Ignored with
                         --clean on some versions; halve it if the target is
                         small.
  --schema-only          Structure only, no rows.
  --data-only            Rows only, no structure. The schema must already match.
  --allow-production     Required if the target URL does not look like a
                         scratch/staging database. Read the runbook first.
  -h, --help             This text.

Environment (for --latest-remote):
  BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (default: dispatch),
  BACKUP_S3_ENDPOINT (Backblaze/R2/Wasabi), BACKUP_S3_REGION (default:
  ca-central-1), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.

Examples:
  # restore a specific file into a local scratch database
  scripts/restore.sh --file backups/rvc-dispatch-20260914T030000Z.dump \
                     --target postgres://rvc:rvc@localhost:5432/rvc_restore_test

  # production recovery, after reading docs/BACKUP_AND_RESTORE.md
  scripts/restore.sh --latest-remote --clean --allow-production \
                     --target "$DATABASE_URL"
USAGE
}

FILE=""
TARGET=""
FORCE=false
CLEAN=false
JOBS=4
SCHEMA_ONLY=false
DATA_ONLY=false
LATEST_REMOTE=false
ALLOW_PRODUCTION=false

while [ $# -gt 0 ]; do
  case "$1" in
    --file)              FILE="${2:-}"; shift 2 ;;
    --target)            TARGET="${2:-}"; shift 2 ;;
    --latest-remote)     LATEST_REMOTE=true; shift ;;
    --force)             FORCE=true; shift ;;
    --clean)             CLEAN=true; shift ;;
    --jobs)              JOBS="${2:-4}"; shift 2 ;;
    --schema-only)       SCHEMA_ONLY=true; shift ;;
    --data-only)         DATA_ONLY=true; shift ;;
    --allow-production)  ALLOW_PRODUCTION=true; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) echo "restore: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

log()  { printf '[restore %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { printf '[restore ERROR] %s\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || { usage >&2; fail "--target is required"; }
command -v pg_restore >/dev/null || fail "pg_restore not found (apt install postgresql-client-18)"
command -v psql       >/dev/null || fail "psql not found"

# ---------------------------------------------------------------------------
# Fetch the newest remote dump if asked.
# ---------------------------------------------------------------------------
DOWNLOADED=""
if [ "$LATEST_REMOTE" = true ]; then
  [ -z "$FILE" ] || fail "--file and --latest-remote are mutually exclusive"
  command -v aws >/dev/null || fail "aws CLI not found"
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required with --latest-remote}"
  S3_PREFIX="${BACKUP_S3_PREFIX:-dispatch}"
  S3_REGION="${BACKUP_S3_REGION:-ca-central-1}"

  aws_s3api() {
    # shellcheck disable=SC2086
    aws s3api "$@" --region "$S3_REGION" \
      ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
  }
  aws_s3() {
    # shellcheck disable=SC2086
    aws s3 "$@" --region "$S3_REGION" \
      ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
  }

  log "finding the newest object under s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}/"
  KEY="$(aws_s3api list-objects-v2 \
      --bucket "$BACKUP_S3_BUCKET" --prefix "${S3_PREFIX}/rvc-dispatch-" \
      --query 'sort_by(Contents[?ends_with(Key, `.dump`)], &LastModified)[-1].Key' \
      --output text 2>/dev/null || echo "None")"
  if [ -z "$KEY" ] || [ "$KEY" = "None" ]; then
    fail "no backups found under s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}/"
  fi

  DOWNLOADED="$(mktemp -t rvc-restore-XXXXXX.dump)"
  log "downloading ${KEY}"
  aws_s3 cp "s3://${BACKUP_S3_BUCKET}/${KEY}" "$DOWNLOADED" --only-show-errors \
    || fail "download failed"
  FILE="$DOWNLOADED"
fi

[ -n "$FILE" ] || { usage >&2; fail "--file or --latest-remote is required"; }
[ -f "$FILE" ] || fail "no such file: $FILE"

# NB: must return 0. An EXIT trap whose last command is false sets the script's
# exit status, which would make every successful restore look like a failure.
cleanup() {
  if [ -n "$DOWNLOADED" ]; then rm -f "$DOWNLOADED"; fi
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Prove the archive is readable before touching the target.
# ---------------------------------------------------------------------------
log "checking the archive"
TOC_LINES="$(pg_restore --list "$FILE" 2>/dev/null | wc -l | tr -d ' ')" \
  || fail "pg_restore --list failed — this file is not a readable custom-format dump"
[ "${TOC_LINES:-0}" -gt 10 ] || fail "archive contains almost nothing (${TOC_LINES} TOC entries)"

if [ -f "${FILE}.sha256" ]; then
  log "verifying checksum"
  ( cd "$(dirname "$FILE")" && \
    { sha256sum -c "$(basename "$FILE").sha256" >/dev/null 2>&1 \
      || shasum -a 256 -c "$(basename "$FILE").sha256" >/dev/null 2>&1; } ) \
    || fail "checksum mismatch — this file is not the one that was written"
  log "checksum OK"
fi

# ---------------------------------------------------------------------------
# Describe the target, and what is about to be destroyed.
# ---------------------------------------------------------------------------
# Redact the password before anything is printed or logged.
SAFE_TARGET="$(printf '%s' "$TARGET" | sed -E 's#(//[^:/@]+):[^@]*@#\1:****@#')"
TARGET_DB="$(printf '%s' "$TARGET" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"

psql "$TARGET" -Atc 'select 1' >/dev/null 2>&1 \
  || fail "cannot connect to ${SAFE_TARGET}"

EXISTING_TABLES="$(psql "$TARGET" -Atc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
EXISTING_TRIPS="$(psql "$TARGET" -Atc \
  "select count(*) from trips" 2>/dev/null || echo 'n/a')"
EXISTING_USERS="$(psql "$TARGET" -Atc \
  "select count(*) from users" 2>/dev/null || echo 'n/a')"

# A crude but effective production guard. Scratch databases are named like
# scratch/test/restore/verify/tmp/staging; anything else must be opted into.
case "$TARGET_DB" in
  *scratch*|*test*|*restore*|*verify*|*tmp*|*staging*|*dev*) LOOKS_SCRATCH=true ;;
  *) LOOKS_SCRATCH=false ;;
esac
if [ "$LOOKS_SCRATCH" = false ] && [ "$ALLOW_PRODUCTION" = false ]; then
  fail "target database '${TARGET_DB}' does not look like a scratch database. \
Re-run with --allow-production if you really mean to overwrite it."
fi

cat >&2 <<SUMMARY

  ------------------------------------------------------------------
  RESTORE
    archive      : ${FILE}
    TOC entries  : ${TOC_LINES}
    target       : ${SAFE_TARGET}
    database     : ${TARGET_DB}
    currently has: ${EXISTING_TABLES} tables, ${EXISTING_TRIPS} trips, ${EXISTING_USERS} users
    mode         : $([ "$CLEAN" = true ] && echo 'DROP AND RECREATE (--clean)' || echo 'restore into existing schema')$([ "$SCHEMA_ONLY" = true ] && echo ' schema-only')$([ "$DATA_ONLY" = true ] && echo ' data-only')

  Everything currently in this database will be replaced.
  ------------------------------------------------------------------

SUMMARY

# ---------------------------------------------------------------------------
# Confirmation.
# ---------------------------------------------------------------------------
if [ "$FORCE" = true ]; then
  log "--force given: skipping confirmation"
else
  if [ ! -t 0 ]; then
    fail "not a terminal and --force was not given — refusing to restore unattended"
  fi
  printf 'Type the database name (%s) to proceed, anything else to abort: ' "$TARGET_DB" >&2
  read -r answer
  [ "$answer" = "$TARGET_DB" ] || fail "aborted — you typed '${answer}'"
fi

# ---------------------------------------------------------------------------
# Restore.
#
# --no-owner / --no-privileges: the dump's roles are not this cluster's roles.
# --exit-on-error is deliberately NOT used with --clean, because dropping
# objects that do not exist is expected noise; errors are counted afterwards.
# ---------------------------------------------------------------------------
ARGS=(--dbname="$TARGET" --no-owner --no-privileges --verbose)
[ "$CLEAN" = true ]       && ARGS+=(--clean --if-exists)
[ "$SCHEMA_ONLY" = true ] && ARGS+=(--schema-only)
[ "$DATA_ONLY" = true ]   && ARGS+=(--data-only)
[ "$JOBS" -gt 1 ] && [ "$DATA_ONLY" = false ] && ARGS+=(--jobs="$JOBS")

log "restoring…"
START="$(date -u +%s)"
set +e
pg_restore "${ARGS[@]}" "$FILE" 2> >(tee /tmp/rvc-restore.log | sed 's/^/[pg_restore] /' >&2)
RC=$?
set -e
ELAPSED=$(( $(date -u +%s) - START ))

if [ "$RC" -ne 0 ]; then
  ERRORS="$(grep -c '^pg_restore: error' /tmp/rvc-restore.log 2>/dev/null || echo 0)"
  if [ "$CLEAN" = true ] && [ "$ERRORS" -gt 0 ]; then
    log "pg_restore exited ${RC} with ${ERRORS} error line(s); with --clean some \
'does not exist' errors are expected. Checking the result instead."
  else
    fail "pg_restore exited ${RC}. See /tmp/rvc-restore.log"
  fi
fi

# ---------------------------------------------------------------------------
# Post-restore assertions. An empty restore is a failed restore.
# ---------------------------------------------------------------------------
log "restore finished in ${ELAPSED}s — checking the result"

psql "$TARGET" -v ON_ERROR_STOP=1 -Atc "
  select 'users='       || (select count(*) from users)
      || ' trips='      || (select count(*) from trips)
      || ' offers='     || (select count(*) from trip_offers)
      || ' audit='      || (select count(*) from audit_events)
      || ' settings='   || (select count(*) from settings);
" >&2 || fail "the restored database does not have the expected tables"

# The guarantees that live in SQL rather than in the application must have come
# back too; a schema restored without them is a silently weaker system.
MISSING_OBJECTS="$(psql "$TARGET" -Atc "
  select string_agg(missing, ', ') from (
    select 'next_trip_reference()' as missing
      where not exists (select 1 from pg_proc where proname = 'next_trip_reference')
    union all
    select 'audit_events_no_update trigger'
      where not exists (select 1 from pg_trigger where tgname = 'audit_events_no_update')
    union all
    select 'trip_offers_one_accepted_uq'
      where not exists (select 1 from pg_indexes where indexname = 'trip_offers_one_accepted_uq')
    union all
    select 'trips_engaged_requires_volunteer_chk'
      where not exists (select 1 from pg_constraint where conname = 'trips_engaged_requires_volunteer_chk')
  ) t;")"

if [ -n "$MISSING_OBJECTS" ]; then
  fail "restore completed but these database guarantees are missing: ${MISSING_OBJECTS}"
fi

log "OK — schema, data, triggers and constraints all present"
log "Next: run migrations (npm run db:migrate --workspace=@rvc/api) in case the \
dump predates the current schema version."
