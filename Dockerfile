# syntax=docker/dockerfile:1
# One image for both processes: the API (default CMD) and the Temporal worker
# (compose overrides the command). bookworm-slim, not Alpine: @temporalio/core-bridge
# ships glibc native binaries only, so the worker cannot load on musl.

FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---- build: full deps, compile TypeScript, pre-bundle workflow code ----
FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsc → dist/, then bundleWorkflowCode → dist/temporal/workflow-bundle.js
RUN npm run build

# ---- deps: production dependencies only ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
# Files stay root-owned: the node user can read but not modify the app.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
# Exec form: node receives SIGTERM directly (no npm/sh wrapper).
CMD ["node", "dist/api/server.js"]
