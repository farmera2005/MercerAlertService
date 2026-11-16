# syntax=docker/dockerfile:1.7
# Targets: worker (also runs migrations), web, mock-swis (dev/CI only).
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# Optional extra CA for networks with a TLS-inspecting proxy (build stages only, never runtime):
#   BUILD_CA_FILE=/path/to/corp-ca.pem docker compose build
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/build-extra-ca.pem; fi
COPY docker/with-build-ca.sh /usr/local/bin/with-build-ca
RUN with-build-ca corepack enable && with-build-ca corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# ---- dependencies (cached on lockfile + manifests) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/swis/package.json packages/swis/
COPY tools/mock-swis/package.json tools/mock-swis/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store with-build-ca pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
RUN pnpm --filter @mercer/worker build \
 && pnpm --filter @mercer/mock-swis build \
 && pnpm --filter @mercer/web build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    with-build-ca pnpm --filter @mercer/worker deploy --prod --legacy /out/worker

# ---- worker (and the one-shot migrate service) ----
FROM node:${NODE_VERSION}-bookworm-slim AS worker
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out/worker/node_modules ./node_modules
COPY --from=build /repo/apps/worker/package.json ./package.json
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
USER node
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---- web (Next.js standalone) ----
FROM node:${NODE_VERSION}-bookworm-slim AS web
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health?liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---- mock SWIS (dev / CI only) ----
FROM node:${NODE_VERSION}-bookworm-slim AS mock-swis
WORKDIR /app
COPY --from=build /repo/tools/mock-swis/dist ./dist
USER node
EXPOSE 17774
CMD ["node", "dist/cli.js"]
