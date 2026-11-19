// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import { ignoreOverride, zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType, ZodTypeDef } from 'zod';

import { runMigrations } from '@api/db/client';
import { seedDevData } from '@api/db/seed';
import { authRoutes } from '@api/modules/auth/auth.routes';
import { controlKeyGuard, noCorsOnControlPaths } from '@api/modules/auth/control-key';
import { bootstrap_canyonos } from '@api/modules/canyonos/canyonos.bootstrap';
import { canyonosRoutes } from '@api/modules/canyonos/canyonos.routes';
import { start_registered_workflows_sync } from '@api/modules/canyonos/canyonos.sync';
import { start_governance_publisher } from '@api/modules/governance/governance.publisher';
import { resourcesRoutes } from '@api/modules/resources/resources.routes';
import { start_metrics_retention } from '@api/modules/telemetry/telemetry.retention';
import { telemetryRoutes } from '@api/modules/telemetry/telemetry.routes';
import { resume_apply_loops } from '@api/modules/workflow-groups/workflow-groups.apply';
import {
  MAX_UPLOAD_BYTES,
  workflowGroupsRoutes,
} from '@api/modules/workflow-groups/workflow-groups.routes';
import { WORKFLOW_GROUP_MODELS } from '@api/modules/workflow-groups/workflow-groups.types';
import { workflowsRoutes } from '@api/modules/workflows/workflows.routes';
import { config } from '@core/env';
import { ApiErrorSchema, errorPlugin } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import { enterRequestContext } from '@core/request-context';
import { securityHeaders } from '@core/security-headers';
import { emitMetric } from '@core/telemetry';

import packageJson from '../package.json';

const httpLogger = logger.child({ domain: LOG_DOMAINS.HTTP });

// The API reference page /docs loads; pinned, so it does not change under a running API.
const SCALAR_VERSION = '1.76.4';

// The error every route answers: one component, which each error answer refers to.
const ERROR_COMPONENT = 'ApiError';
// Each registered model, by its schema, so a model nested in another is a reference to its
// component and the SDK generators make one type of each.
const COMPONENT_NAMES = new Map<ZodTypeDef, string>(
  Object.entries(WORKFLOW_GROUP_MODELS).map(([name, schema]) => [schema._def, name])
);
const component_ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const to_openapi_schema = (schema: ZodType) =>
  zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    override: (def, refs) => {
      if (def === ApiErrorSchema._def) return component_ref(ERROR_COMPONENT);
      // A model itself, where it is the component, stays whole.
      const nested = refs.currentPath.length > refs.basePath.length;
      const name = nested ? COMPONENT_NAMES.get(def) : undefined;
      return name ? component_ref(name) : ignoreOverride;
    },
  });

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
    // Before the CORS plugin, so a /v1 request without the control key gets no CORS answer.
    .use(controlKeyGuard)
    .use(cors())
    .use(noCorsOnControlPaths)
    .use(
      openapi({
        path: '/docs',
        // Renders /docs per request, with the spec in it; the static page the plugin makes
        // otherwise keeps `bun test` from seeing any test finish.
        embedSpec: true,
        mapJsonSchema: { zod: to_openapi_schema },
        scalar: { version: SCALAR_VERSION },
        documentation: {
          info: {
            title: 'CanyonOS API',
            // The version every CanyonOS package shares, which `bun run version:set` writes.
            version: packageJson.version,
            description:
              'With CANYONOS_API_KEY_HASH set, every /workflows and /resources route needs the API key as `Authorization: Bearer <key>`. Without it every route is open. Every /v1 route needs the control key the CLI made, whose hash is CANYONOS_CONTROL_KEY_HASH, as `Authorization: Bearer <key>`; without that hash every /v1 route is refused.',
          },
          tags: [
            { name: 'Auth' },
            { name: 'Workflows' },
            { name: 'Requests' },
            { name: 'Metrics' },
            { name: 'Telemetry' },
            { name: 'CanyonOS' },
            { name: 'WorkflowGroups' },
          ],
          components: {
            schemas: {
              [ERROR_COMPONENT]: zodToJsonSchema(ApiErrorSchema, {
                target: 'openApi3',
                $refStrategy: 'none',
              }) as Record<string, unknown>,
            },
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer' },
              controlKey: { type: 'http', scheme: 'bearer' },
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
    .use(workflowsRoutes)
    // Deliberately unauthenticated: the OTLP emitter is an agent process, which holds no API key.
    .use(telemetryRoutes)
    .use(canyonosRoutes)
    .use(workflowGroupsRoutes);

export const forgeApi = createApp();

export type ForgeApi = typeof forgeApi;

export const setupApi = async () => {
  await runMigrations();
  await seedDevData();
  // Kubernetes: the operator lists the workflows; there is no one controller to register.
  if (config.canyonos.workflowsFile) await start_registered_workflows_sync();
  else await bootstrap_canyonos();
  await resume_apply_loops();
  httpLogger.info('Setup complete', { env: config.environment });
};

export const startApi = async ({ host, port }: { host: string; port: number }) => {
  httpLogger.info('Starting API', { env: config.environment });
  await setupApi();
  start_governance_publisher();
  start_metrics_retention();
  // Bun's own cap is 128 MB; a workflow archive may be larger.
  return forgeApi.listen(
    { hostname: host, port, maxRequestBodySize: MAX_UPLOAD_BYTES },
    ({ port }) => {
      httpLogger.info('API listening', { host, port, env: config.environment });
    }
  );
};
