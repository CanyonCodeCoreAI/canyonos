FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
# Bun omits packages/api/node_modules when it fully hoists deps to the root, which would break the
# COPY in the runner stage.
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && mkdir -p packages/api/node_modules

FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/api ./packages/api
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules

WORKDIR /app/packages/api
EXPOSE 3000

# The only path the runtime writes: the mock blob store, ./data/blobs under this WORKDIR
# (resolveMockStorageDir in src/modules/core/env.ts). Everything else stays read-only to `bun`.
RUN mkdir -p data && chown bun:bun data

USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=2s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
