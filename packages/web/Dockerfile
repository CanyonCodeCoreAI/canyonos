# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# dist is architecture independent, so building it natively instead of under QEMU changes nothing.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/web/package.json ./packages/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/cli-usage-api/package.json ./packages/cli-usage-api/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build:sdk

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" >&2; exit 1)
RUN cd packages/web && bun run build

# Follows Caddy's own release build, with golang.org/x/net raised past the version Caddy pins.
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.23 AS caddy
ARG TARGETOS
ARG TARGETARCH
ARG CADDY_VERSION=v2.11.7
ENV CGO_ENABLED=0
WORKDIR /src
RUN apk add --no-cache libcap-setcap \
    && go mod download "github.com/caddyserver/caddy/v2@$CADDY_VERSION" \
    && cp "$(go env GOMODCACHE)/github.com/caddyserver/caddy/v2@$CADDY_VERSION/cmd/caddy/main.go" . \
    && go mod init caddy \
    && go get "github.com/caddyserver/caddy/v2@$CADDY_VERSION" golang.org/x/net@v0.60.0 \
    && go mod tidy \
    && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w" \
        -tags nobadger,nomysql,nopgx -o /out/caddy . \
    && setcap cap_net_bind_service=+ep /out/caddy

FROM alpine:3.23.6 AS serve
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates mailcap
COPY --from=caddy /out/caddy /usr/bin/caddy
# Keeps Caddy's autosave dirs off root-owned paths, in /tmp where uid 1000 can write.
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
COPY --from=builder --chown=1000:1000 /app/packages/web/dist /srv
WORKDIR /srv
USER 1000:1000
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# `docker build --target canyonos` produces the self-hosted image.
FROM serve AS canyonos
COPY packages/web/Caddyfile /etc/caddy/Caddyfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1
