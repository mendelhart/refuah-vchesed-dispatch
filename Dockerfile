# syntax=docker/dockerfile:1.7

# =============================================================================
# Refuah V'Chesed Dispatch — container image
#
# One thing ships out of this file: the API and its background worker.
#
#     docker build -t rvc-api .
#
# The SPA is ./Dockerfile.web, a separate image. The API image does NOT serve
# the web bundle: apps/api is a JSON API, it has no static-file plugin, it sets
# `crossOriginResourcePolicy: same-site`, and it disables helmet's CSP on the
# explicit grounds that "the web app sets its own" (apps/api/src/server.ts).
# Serving HTML from the same process would mean putting a CSP, a cache policy
# and an SPA fallback into an API that is deliberately not in that business.
#
# The two images are joined at the edge instead: nginx in the web image proxies
# /api and /webhooks here, so the browser addresses one origin and the
# SameSite=Lax session cookie is actually sent. See docs/DEPLOYMENT.md.
#
# Build order is shared -> api, because @rvc/shared is a workspace dependency
# imported by package name.
# =============================================================================

ARG NODE_VERSION=22

# -----------------------------------------------------------------------------
# base — the one place the Node version is pinned.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app
# tini reaps zombies and forwards SIGTERM, which the API's graceful shutdown
# handler depends on. curl is only used by the HEALTHCHECK fallback.
RUN apk add --no-cache tini

# -----------------------------------------------------------------------------
# deps — every workspace's dependencies, including dev, for the build.
#
# Only the manifests are copied first so this layer is reused on every source
# change. npm workspaces needs every workspace package.json present before
# `npm ci` will resolve the internal `@rvc/*` links.
# -----------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY tools/migrate/package.json ./tools/migrate/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include-workspace-root --workspaces

# -----------------------------------------------------------------------------
# build — compile shared, then api.
# -----------------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# 1. shared (the API imports it by package name)
RUN npm run build --workspace=@rvc/shared

# 2. api  -> apps/api/dist
#
#    packages/shared/package.json already points `exports` at ./dist/index.js,
#    so the compiled API can `import '@rvc/shared'` under plain Node. An earlier
#    revision of this file rewrote that field here because the manifest pointed
#    at the TypeScript source; the manifest was fixed, and the rewrite has been
#    removed rather than left as a no-op that looks load-bearing.
RUN npm run build --workspace=@rvc/api

# -----------------------------------------------------------------------------
# prod-deps — the runtime dependency tree only (no vite, vitest, playwright…).
# -----------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY tools/migrate/package.json ./tools/migrate/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --include-workspace-root --workspaces

# =============================================================================
# runtime — the API and its in-process worker. This is the default stage.
# =============================================================================
FROM base AS runtime

# Admin full-backup download needs a PostgreSQL client, not a new service.
# pg_dump refuses a server newer than itself, and production is Aiven PG18,
# so the client is pinned to 18 (Alpine 3.23 or later). If the base image is
# older, this line fails the build instead of shipping a download that fails.
RUN apk add --no-cache postgresql18-client && pg_dump --version | grep -q ' 18\.'

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--enable-source-maps

# node:alpine already ships an unprivileged `node` user (uid/gid 1000). The
# process owns nothing it writes to and never needs root.
WORKDIR /app

COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
# npm does not always hoist every production dependency to the root
# node_modules: drizzle-orm 0.45 lands in apps/api/node_modules instead.
# Node's resolution walks up from dist/, so the nested tree must ship too.
COPY --from=prod-deps --chown=root:root /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build     --chown=root:root /app/package.json ./package.json

# @rvc/shared: the patched manifest plus its compiled output.
COPY --from=build --chown=root:root /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=root:root /app/packages/shared/dist         ./packages/shared/dist

# The API: compiled JS plus the SQL migrations, which db/migrate.js resolves
# relative to itself at ../../drizzle.
COPY --from=build --chown=root:root /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=root:root /app/apps/api/dist         ./apps/api/dist
COPY --from=build --chown=root:root /app/apps/api/drizzle      ./apps/api/drizzle

COPY --chown=root:root scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER node
WORKDIR /app/apps/api
EXPOSE 8080

# /health checks the database round-trip and returns 503 when it cannot reach
# Postgres, so this is a real dependency check and not just "the port is open".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
