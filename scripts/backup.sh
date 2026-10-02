#!/usr/bin/env bash
#
# backup.sh — take a verified, off-host backup of the dispatch database.
#
# A backup that has never been read is a rumour. This script therefore does four
# things, and fails if any of them fails:
#
#   1. pg_dump in custom format (-Fc), compressed, to a timestamped file
#   2. verify the dump is structurally readable with `pg_restore --list`
#   3. upload it to S3-compatible object storage on another provider
#   4. apply the retention policy, locally and remotely
#
# Step 2 is what separates this from `pg_dump | gzip`: a truncated or
# half-written dump exits non-zero here instead of being discovered during an
# outage. It does NOT prove the data restores correctly — that is
# verify-backup.sh, which runs weekly and actually loads it.
#
# Exits non-zero on any failure, so cron/systemd/Fly machines can alert on it.
#
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/backup.sh [--local-only] [--keep-days N] [--label TEXT]

Takes a compressed pg_dump of $DATABASE_URL, verifies it is readable, uploads
it to S3-compatible storage and prunes old copies.

Options:
  --local-only     Skip the upload. For testing the script itself.
  --keep-days N    Override BACKUP_RETENTION_DAYS for this run.
  --label TEXT     Extra token in the filename, e.g. "pre-migration".
  -h, --help       This text.

Required environment:
  DATABASE_URL              postgres://user:pass@host:port/db
                            Use a read-only-capable role if you have one; the
                            dump only needs SELECT.

Required unless --local-only:
  BACKUP_S3_BUCKET          e.g. rvc-dispatch-backups
  AWS_ACCESS_KEY_ID         credentials for the object store
  AWS_SECRET_ACCESS_KEY

Optional environment:
  BACKUP_S3_ENDPOINT        Custom endpoint. Set this for anything that is not
                            AWS S3 — the script is written against the S3 API,
                            not against AWS:
                              Backblaze B2  https://s3.us-west-004.backblazeb2.com
                              Cloudflare R2 https://<account-id>.r2.cloudflarestorage.com
                              Wasabi        https://s3.ca-central-1.wasabisys.com
                            Leave unset for AWS S3 itself.
  BACKUP_S3_PREFIX          Key prefix inside the bucket   (default: dispatch)
  BACKUP_S3_REGION          Region                          (default: ca-central-1)
  BACKUP_S3_STORAGE_CLASS   e.g. STANDARD_IA. Omitted by default because most
                            S3-compatible providers reject the header.
  BACKUP_DIR                Local staging directory         (default: ./backups)
  BACKUP_RETENTION_DAYS     Days to keep, local and remote  (default: 30)
  BACKUP_MIN_BYTES          Fail if the dump is smaller     (default: 20000)

Never pass credentials on the command line: they end up in `ps` and in shell
history. Use the environment, a systemd EnvironmentFile, or `fly secrets`.

Examples:
  # nightly, to Backblaze B2
  BACKUP_S3_BUCKET=rvc-dispatch-backups \
  BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
  scripts/backup.sh

  # right before a risky migration
  scripts/backup.sh --label pre-0003-migration
USAGE
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
LOCAL_ONLY=false
LABEL=""
KEEP_DAYS_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local-only) LOCAL_ONLY=true; shift ;;
    --keep-days)  KEEP_DAYS_OVERRIDE="${2:-}"; shift 2 ;;
    --label)      LABEL="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "backup: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
: "${DATABASE_URL:?DATABASE_URL is required (see --help)}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${KEEP_DAYS_OVERRIDE:-${BACKUP_RETENTION_DAYS:-30}}"
MIN_BYTES="${BACKUP_MIN_BYTES:-20000}"
S3_PREFIX="${BACKUP_S3_PREFIX:-dispatch}"
S3_REGION="${BACKUP_S3_REGION:-ca-central-1}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX=""
[ -n "$LABEL" ] && SUFFIX="-$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-')"
FILENAME="rvc-dispatch-${STAMP}${SUFFIX}.dump"
TARGET="${BACKUP_DIR%/}/${FILENAME}"

log()  { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { printf '[backup ERROR] %s\n' "$*" >&2; exit 1; }

# Anything half-written is removed, so a failed run never leaves a plausible
# looking file that a later restore might pick up.
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$TARGET" ] && [ "${VERIFIED:-false}" != "true" ]; then
    log "run failed — removing unverified ${TARGET}"
    rm -f "$TARGET"
  fi
  exit "$status"
}
trap cleanup EXIT

command -v pg_dump    >/dev/null || fail "pg_dump not found (apt install postgresql-client-18)"
command -v pg_restore >/dev/null || fail "pg_restore not found (apt install postgresql-client-18)"
if [ "$LOCAL_ONLY" = false ]; then
  command -v aws >/dev/null || fail "aws CLI not found, and --local-only was not given"
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required unless --local-only}"
fi

mkdir -p "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# 1. Dump
#
# -Fc  custom format: compressed, and restorable selectively (one table, or
#      schema-only) which plain SQL is not.
# -Z6  zstd/gzip level inside the custom format. 6 is the point where more CPU
#      stops buying much.
# --no-owner / --no-privileges: the restore target's roles are not this
#      cluster's roles, and a restore must not fail on a missing role.
# ---------------------------------------------------------------------------
log "dumping to ${TARGET}"
if ! pg_dump \
      --dbname="$DATABASE_URL" \
      --format=custom \
      --compress=6 \
      --no-owner \
      --no-privileges \
      --verbose \
      --file="$TARGET" 2> >(sed 's/^/[pg_dump] /' >&2); then
  fail "pg_dump failed"
fi

[ -f "$TARGET" ] || fail "pg_dump reported success but ${TARGET} does not exist"

SIZE_BYTES="$(wc -c < "$TARGET" | tr -d ' ')"
if [ "$SIZE_BYTES" -lt "$MIN_BYTES" ]; then
  fail "dump is only ${SIZE_BYTES} bytes (< BACKUP_MIN_BYTES=${MIN_BYTES}) — treating as a failed dump"
fi
log "dump written: ${SIZE_BYTES} bytes"

# ---------------------------------------------------------------------------
# 2. Verify the archive is readable and contains the tables that matter.
#
# `pg_restore --list` reads the whole table of contents. It catches truncation,
# corruption and a dump that silently captured nothing. It does not execute any
# SQL, so it is safe to run anywhere.
# ---------------------------------------------------------------------------
log "verifying archive with pg_restore --list"
TOC="$(mktemp)"

if ! pg_restore --list "$TARGET" > "$TOC" 2>/dev/null; then
  rm -f "$TOC"
  fail "pg_restore --list could not read ${TARGET} — the dump is not restorable"
fi

# The tables without which a restore is worthless. `trips` and `users` are the
# operational system; `audit_events` is the record we are legally obliged to
# keep; `trip_offers` is how "who was asked" is answerable.
MISSING=""
for table in users trips trip_offers trip_assignments audit_events notifications; do
  grep -Eq "TABLE DATA public ${table}( |$)" "$TOC" || MISSING="${MISSING} ${table}"
done
ENTRIES="$(wc -l < "$TOC" | tr -d ' ')"
rm -f "$TOC"

[ -n "$MISSING" ] && fail "archive is missing table data for:${MISSING}"
log "archive verified: ${ENTRIES} TOC entries, all critical tables present"
VERIFIED=true

# A checksum so a later restore can prove it read the same bytes that were
# written here.
if command -v sha256sum >/dev/null; then
  sha256sum "$TARGET" > "${TARGET}.sha256"
elif command -v shasum >/dev/null; then
  shasum -a 256 "$TARGET" > "${TARGET}.sha256"
fi

# ---------------------------------------------------------------------------
# 3. Upload off-host.
#
# On another provider, deliberately. A backup sitting in the same account as
# the database survives a disk failure but not a compromised account, a billing
# suspension or a mis-aimed `terraform destroy`.
# ---------------------------------------------------------------------------
aws_s3() {
  # shellcheck disable=SC2086
  aws s3 "$@" \
    --region "$S3_REGION" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
}
aws_s3api() {
  # shellcheck disable=SC2086
  aws s3api "$@" \
    --region "$S3_REGION" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
}

if [ "$LOCAL_ONLY" = true ]; then
  log "--local-only: skipping upload"
else
  KEY="s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}/${FILENAME}"
  log "uploading to ${KEY}${BACKUP_S3_ENDPOINT:+ via ${BACKUP_S3_ENDPOINT}}"

  # shellcheck disable=SC2086
  aws_s3 cp "$TARGET" "$KEY" \
    --only-show-errors \
    ${BACKUP_S3_STORAGE_CLASS:+--storage-class "$BACKUP_S3_STORAGE_CLASS"} \
    || fail "upload failed"

  [ -f "${TARGET}.sha256" ] && aws_s3 cp "${TARGET}.sha256" "${KEY}.sha256" --only-show-errors

  # Confirm the object is actually there and the right size. `aws s3 cp` can
  # exit 0 against a misconfigured endpoint that swallowed the write.
  REMOTE_SIZE="$(aws_s3api head-object \
      --bucket "$BACKUP_S3_BUCKET" \
      --key "${S3_PREFIX}/${FILENAME}" \
      --query ContentLength --output text 2>/dev/null || echo "")"
  if [ "$REMOTE_SIZE" != "$SIZE_BYTES" ]; then
    fail "remote object size (${REMOTE_SIZE:-absent}) does not match local (${SIZE_BYTES})"
  fi
  log "upload verified: ${REMOTE_SIZE} bytes at ${KEY}"
fi

# ---------------------------------------------------------------------------
# 4. Retention.
#
# Pruning happens LAST and only after a successful, verified upload, so a run
# that failed earlier can never be the reason an old good backup was deleted.
# ---------------------------------------------------------------------------
log "pruning local copies older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -name 'rvc-dispatch-*.dump*' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

if [ "$LOCAL_ONLY" = false ]; then
  log "pruning remote copies older than ${RETENTION_DAYS} days"
  CUTOFF_EPOCH="$(( $(date -u +%s) - RETENTION_DAYS * 86400 ))"

  aws_s3api list-objects-v2 \
    --bucket "$BACKUP_S3_BUCKET" \
    --prefix "${S3_PREFIX}/rvc-dispatch-" \
    --query 'Contents[].[Key,LastModified]' --output text 2>/dev/null \
  | while read -r key modified; do
      [ -z "${key:-}" ] && continue
      # Portable ISO-8601 -> epoch, GNU date and BSD date.
      obj_epoch="$(date -u -d "$modified" +%s 2>/dev/null \
                || date -u -j -f '%Y-%m-%dT%H:%M:%S' "${modified%%+*}" +%s 2>/dev/null \
                || echo 0)"
      if [ "$obj_epoch" -gt 0 ] && [ "$obj_epoch" -lt "$CUTOFF_EPOCH" ]; then
        log "deleting expired remote object ${key}"
        aws_s3 rm "s3://${BACKUP_S3_BUCKET}/${key}" --only-show-errors || true
      fi
    done

  # Never let retention empty the bucket. If pruning leaves nothing behind,
  # something is wrong with the clock or the prefix, and that is worth alerting.
  REMAINING="$(aws_s3api list-objects-v2 \
      --bucket "$BACKUP_S3_BUCKET" --prefix "${S3_PREFIX}/rvc-dispatch-" \
      --query 'length(Contents)' --output text 2>/dev/null || echo 0)"
  [ "$REMAINING" = "None" ] && REMAINING=0
  if [ "${REMAINING:-0}" -lt 1 ]; then
    fail "retention left 0 backups in the bucket — refusing to report success"
  fi
  log "${REMAINING} backup(s) retained remotely"
fi

log "OK — ${FILENAME} (${SIZE_BYTES} bytes)"
