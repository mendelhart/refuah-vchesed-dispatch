#!/bin/sh
# Container entrypoint: bring the schema up to date, then start the process.
#
# Migrations run here so that `docker run` and `docker compose up` are complete
# on their own. On Fly the release_command does it instead (see fly.toml), and
# RUN_MIGRATIONS_ON_START=false keeps it from happening twice.
#
# apps/api/src/index.ts also calls runMigrations() at boot. drizzle's migrator
# takes an advisory lock and records applied migrations in
# drizzle.__drizzle_migrations, so running it more than once is a no-op, not a
# conflict — including when several instances start at the same moment.
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  node dist/db/migrate.js
  echo "[entrypoint] migrations up to date"
else
  echo "[entrypoint] RUN_MIGRATIONS_ON_START=false — skipping migrations"
fi

echo "[entrypoint] starting: $*"
exec "$@"
