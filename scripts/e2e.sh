#!/usr/bin/env bash
#
# e2e.sh — run the browser suite against a real API and a real build.
#
# Deliberately not Playwright's `webServer`: when the API fails to start, this
# prints the API's own error instead of a browser timeout thirty seconds later.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL must be set (a database the suite may write to)}"
export NODE_ENV=${NODE_ENV:-development}
export PORT=${PORT:-8080}
export APP_URL=${APP_URL:-http://127.0.0.1:4173}
export API_PUBLIC_URL=${API_PUBLIC_URL:-http://127.0.0.1:8080}
export SESSION_SECRET=${SESSION_SECRET:-e2e-secret-e2e-secret-e2e-secret-e2e-secret-0123}
export FIELD_ENCRYPTION_KEY=${FIELD_ENCRYPTION_KEY:-$(head -c 32 /dev/urandom | base64)}
export COOKIE_SECURE=false
export RUN_WORKER_IN_PROCESS=true
export LOG_LEVEL=${LOG_LEVEL:-warn}
# The suite signs in as three roles from one IP, and reruns add up against the
# five-minute window. The limiter is exercised deliberately in the API suite.
export LOGIN_MAX_PER_IP_PER_5MIN=${LOGIN_MAX_PER_IP_PER_5MIN:-500}

api_pid=""
web_pid=""
cleanup() {
  [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true
  [ -n "$web_pid" ] && kill "$web_pid" 2>/dev/null || true
}
trap cleanup EXIT

echo "→ migrating and seeding"
npm run db:migrate --workspace=@rvc/api
npm run db:seed --workspace=@rvc/api

echo "→ building the web app"
npm run build --workspace=@rvc/shared
npm run build --workspace=@rvc/api
npm run build --workspace=@rvc/web

echo "→ starting the API on :$PORT"
node apps/api/dist/index.js &
api_pid=$!

echo "→ starting the built web app on :4173"
( cd apps/web && npx vite preview --port 4173 --strictPort ) &
web_pid=$!

for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 &&
     curl -fsS "http://127.0.0.1:4173/" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 40 ]; then echo "servers did not come up" >&2; exit 1; fi
  sleep 1
done

echo "→ running the browser suite"
cd apps/web
npx playwright test "$@"
