// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { runMigrations } from '@api/db/client';
import { seedDevData } from '@api/db/seed';
import { authRoutes } from '@api/modules/auth/auth.routes';
import { bootstrap_canyonos } from '@api/modules/canyonos/canyonos.bootstrap';
import { canyonosRoutes } from '@api/modules/canyonos/canyonos.routes';
import { start_registered_projects_sync } from '@api/modules/canyonos/canyonos.sync';
import { start_governance_publisher } from '@api/modules/governance/governance.publisher';
import { projectsRoutes } from '@api/modules/projects/projects.routes';
import { resourcesRoutes } from '@api/modules/resources/resources.routes';
import { telemetryRoutes } from '@api/modules/telemetry/telemetry.routes';
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
              info: {
                title: 'CanyonOS API',
                version: '0.1.0',
                description:
                  'Bearer authentication applies only with AUTH_MODE=password; with AUTH_MODE=none every route is open.',
              },
              tags: [
                { name: 'Projects' },
                { name: 'Requests' },
                { name: 'Metrics' },
                { name: 'Telemetry' },
                { name: 'CanyonOS' },
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
    .use(resourcesRoutes)
    .use(projectsRoutes)
    // Deliberately unauthenticated in every mode: the OTLP emitter is an agent process, not a person.
    .use(telemetryRoutes)
    .use(canyonosRoutes);

export const forgeApi = createApp();

export type ForgeApi = typeof forgeApi;

export const setupApi = async () => {
  await runMigrations();
  await seedDevData();
  // Kubernetes: the operator lists the projects; there is no one controller to register.
  if (config.canyonos.projectsFile) await start_registered_projects_sync();
  else await bootstrap_canyonos();
  httpLogger.info('Setup complete', { env: config.environment });
};

export const startApi = async ({ host, port }: { host: string; port: number }) => {
  httpLogger.info('Starting API', { env: config.environment });
  await setupApi();
  start_governance_publisher();
  return forgeApi.listen({ hostname: host, port }, ({ port }) => {
    httpLogger.info('API listening', { host, port, env: config.environment });
  });
};
