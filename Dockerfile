# syntax=docker/dockerfile:1.7

# ─── Stage 1: build ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm via Corepack (version pinned in package.json#packageManager)
RUN corepack enable

# Install deps with cache-friendly layer
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm build

# Prune dev deps for runtime image
RUN pnpm prune --prod


# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    DASHBOARD_ENABLED=true \
    DASHBOARD_PORT=3737 \
    CREDENTIAL_STORE_PATH=/data \
    SITES_STORE_PATH=/data \
    AUDIT_LOG_PATH=/data \
    AGENT_CHAT_PATH=/data

# Create non-root user
RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /data && chown -R app:app /data

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/drizzle ./drizzle
COPY --chown=app:app package.json ./

USER app

EXPOSE 3737

# Healthcheck against the dashboard root
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
  CMD wget -qO- http://127.0.0.1:3737/ >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
