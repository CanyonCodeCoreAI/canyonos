# dist is architecture independent, so building it natively instead of under QEMU changes nothing.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/web/package.json ./packages/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build:sdk

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" >&2; exit 1)
# Vite inlines this, so local mode is a property of the image and not of the container.
ARG VITE_CANYONOS_LOCAL_MODE
ENV VITE_CANYONOS_LOCAL_MODE=$VITE_CANYONOS_LOCAL_MODE
RUN cd packages/web && bun run build

FROM caddy:2.11.4-alpine AS serve
# Moves Caddy's autosave dirs off the root-owned /config and /data to paths uid 1000 owns.
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
COPY --from=builder --chown=1000:1000 /app/packages/web/dist /srv
USER 1000:1000
EXPOSE 8080

# `docker build --target canyonos` produces the self-hosted image.
FROM serve AS canyonos
COPY packages/web/Caddyfile /etc/caddy/Caddyfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1
