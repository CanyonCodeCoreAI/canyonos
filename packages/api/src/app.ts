import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { runMigrations } from '@api/db/client';
import { seedDevData } from '@api/db/seed';
import { authRoutes } from '@api/modules/auth/auth.routes';
import { bootstrap_canyonos } from '@api/modules/canyonos/canyonos.bootstrap';
import { companiesRoutes } from '@api/modules/companies/companies.routes';
import { DEFAULT_POLL_TIMEOUT_MS } from '@api/modules/deploy/deploy.agent';
import { sweep_stale_deployments } from '@api/modules/deploy/deploy.service';
import { ensure_deploy_listener } from '@api/modules/deploy/deploy.stream';
import { internalRoutes } from '@api/modules/internal/internal.routes';
import { onboardingRoutes } from '@api/modules/onboarding/onboarding.routes';
import { projectsRoutes } from '@api/modules/projects/projects.routes';
import { resourcesRoutes } from '@api/modules/resources/resources.routes';
import { telemetryRoutes } from '@api/modules/telemetry/telemetry.routes';
import { workflows_queue } from '@api/modules/workflows/workflows.queue';
import { config } from '@core/env';
import { errorPlugin } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import { enterRequestContext } from '@core/request-context';
import { securityHeaders } from '@core/security-headers';
import { emitMetric } from '@core/telemetry';

const httpLogger = logger.child({ domain: LOG_DOMAINS.HTTP });

const getClientIp = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
  request.headers.get('x-real-ip') ??
  'unknown';

export const createApp = () =>
  new Elysia({ name: 'forge-api' })
    .use(errorPlugin)
    .use(securityHeaders())
    .onRequest(({ request, set }) => {
      const requestId =
        request.headers.get('x-request-id') ?? request.headers.get('cf-ray') ?? Bun.randomUUIDv7();
      set.headers['x-request-id'] = requestId;
      (request as any).__requestId = requestId;
      (request as any).__startTime = performance.now();
      enterRequestContext(requestId, getClientIp(request));
    })
    .onAfterResponse(({ request, set, path: route }) => {
      const startTime = (request as any).__startTime;
      if (!startTime) return;
      const url = new URL(request.url);
      if (url.pathname === '/healthz') return;
      const duration_ms = Math.round((performance.now() - startTime) * 100) / 100;
      emitMetric('http.request.duration', duration_ms, {
        request_id: (request as any).__requestId,
        method: request.method,
        path: url.pathname,
        route,
        status: (set as any).status ?? 200,
      });
    })
    .use(cors())
    .use(
      config.isProduction || config.isTest
        ? new Elysia({ name: 'openapi-disabled' })
        : openapi({
            path: '/docs',
            mapJsonSchema: { zod: zodToJsonSchema },
            documentation: {
              info: { title: 'CanyonOS API', version: '0.1.0' },
              tags: [
                { name: 'Projects' },
                { name: 'Workflows' },
                { name: 'Deploy' },
                { name: 'Requests' },
                { name: 'Metrics' },
                { name: 'Telemetry' },
              ],
              components: {
                securitySchemes: {
                  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                },
              },
            },
          })
    )
    .get(
      '/healthz',
      () => ({
        status: 'ok',
        version: process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
        timestamp: new Date().toISOString(),
      }),
      { detail: { summary: 'Health Check', tags: ['system'] } }
    )
    .use(authRoutes)
    .use(companiesRoutes)
    .use(onboardingRoutes)
    .use(resourcesRoutes)
    .use(projectsRoutes)
    // Deliberately unauthenticated in every mode: the OTLP emitter is an agent process, not a person.
    .use(telemetryRoutes)
    .use(internalRoutes);

export const forgeApi = createApp();

export type ForgeApi = typeof forgeApi;

export const setupApi = async () => {
  await runMigrations();
  await seedDevData();
  await bootstrap_canyonos();
  httpLogger.info('Setup complete', { env: config.environment });
};

export const startApi = async ({ host, port }: { host: string; port: number }) => {
  httpLogger.info('Starting API', { env: config.environment });
  await setupApi();
  const server = forgeApi.listen(
    {
      hostname: host,
      port,
      // Headroom over the 5 MiB project-upload cap: JSON escaping and per-file metadata inflate it.
      // TODO(#55): multipart/form-data with `bytea` storage removes the need for this headroom.
      maxRequestBodySize: 16 * 1024 * 1024,
      // Elysia defaults to 30s, under deploy.agent's poll budget. Bun refuses any value above 255.
      idleTimeout: Math.min(255, Math.ceil(DEFAULT_POLL_TIMEOUT_MS / 1000) + 5),
    },
    ({ port }) => {
      httpLogger.info('API listening', { host, port, env: config.environment });
    }
  );

  // Started after listen so recovery never delays /healthz.
  void workflows_queue.sweep_and_enqueue().catch((error) => {
    httpLogger.error('workflow queue recovery failed', { error });
  });

  if (config.deploy.worker !== 'none') {
    void ensure_deploy_listener().catch((error) => {
      httpLogger.error('deploy event listener failed to start', { error });
    });
    void sweep_stale_deployments().catch((error) => {
      httpLogger.error('deploy sweep failed', { error });
    });
    // Tests drive the sweep explicitly, so only a long-running process arms the safety-net interval.
    if (!config.isTest) {
      setInterval(() => {
        void sweep_stale_deployments().catch((error) => {
          httpLogger.error('deploy sweep failed', { error });
        });
      }, config.deploy.leaseSeconds * 1000).unref();
    }
  }

  return server;
};
