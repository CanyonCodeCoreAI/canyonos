// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import { ZodFirstPartyTypeKind } from 'zod';
import { ignoreOverride, zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodOptionalDef, ZodType, ZodTypeDef } from 'zod';

import { close_db, run_migrations } from '@api/db/client';
import { set_database_state, wait_for_database } from '@api/db/database';
import { seedDevData } from '@api/db/seed';
import { apiKeyGuard } from '@api/modules/auth/auth.plugin';
import { authRoutes } from '@api/modules/auth/auth.routes';
import { healthRoutes } from '@api/modules/health/health.routes';
import {
  bootstrap_registry,
  start_listed_workflows_sync,
  start_registered_workflows_tick,
} from '@api/modules/registry/registry.service';
import { resourcesRoutes } from '@api/modules/resources/resources.routes';
import { start_metrics_retention } from '@api/modules/telemetry/telemetry.retention';
import { resume_apply_loops } from '@api/modules/workflow-groups/workflow-groups.apply';
import {
  noCorsOnWorkflowGroups,
  workflowGroupsGuard,
} from '@api/modules/workflow-groups/workflow-groups.caller';
import {
  MAX_UPLOAD_BYTES,
  workflowGroupsRoutes,
} from '@api/modules/workflow-groups/workflow-groups.routes';
import { WORKFLOW_GROUP_MODELS } from '@api/modules/workflow-groups/workflow-groups.types';
import { workflowsRoutes } from '@api/modules/workflows/workflows.routes';
import { dotSegmentGuard } from '@core/dot-segments';
import { config } from '@core/env';
import { ApiErrorSchema, errorPlugin } from '@core/errors';
import { emit_metric, LOG_DOMAINS, logger } from '@core/logger';
import { begin_request, request_timing } from '@core/request-context';
import { securityHeaders } from '@core/security-headers';

import packageJson from '../package.json';

const http_logger = logger.child({ domain: LOG_DOMAINS.HTTP });
const database_logger = logger.child({ domain: LOG_DOMAINS.DB });

// Probes, asked every few seconds: no request metric for them.
const UNMEASURED_PATHS = new Set(['/v1/healthz', '/v1/readyz']);

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
/** The schema `def` makes optional, if it is a ZodOptional. */
const optional_of = (def: ZodTypeDef): ZodTypeDef | undefined =>
  def instanceof Object && 'typeName' in def && def.typeName === ZodFirstPartyTypeKind.ZodOptional
    ? (def as ZodOptionalDef).innerType._def
    : undefined;

const to_openapi_schema = (schema: ZodType) =>
  zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    override: (def, refs) => {
      if (def === ApiErrorSchema._def) return component_ref(ERROR_COMPONENT);
      // A model itself, where it is the component, stays whole; an optional body of one is the
      // model, which the route's description says may be left out.
      const nested = refs.currentPath.length > refs.basePath.length;
      const model = nested ? def : optional_of(def);
      const name = model && COMPONENT_NAMES.get(model);
      return name ? component_ref(name) : ignoreOverride;
    },
  });

export const app = new Elysia({ name: 'canyonos.api' })
  .use(errorPlugin)
  .use(securityHeaders())
  // First, so every refusal after it carries the request's id.
  .onRequest(({ request, set }) => {
    set.headers['x-request-id'] = begin_request(request).request_id;
  })
  .onAfterResponse(({ request, set, path: route }) => {
    const timing = request_timing(request);
    const path = new URL(request.url).pathname;
    if (!timing || UNMEASURED_PATHS.has(path)) return;
    emit_metric(
      'http.request.duration',
      Math.round((performance.now() - timing.started_at) * 100) / 100,
      {
        request_id: timing.request_id,
        method: request.method,
        path,
        route,
        status: set.status ?? 200,
      }
    );
  })
  // Before every guard: a `..` the router matches but request.url resolves would let a guard
  // judge another path than the route that answers.
  .use(dotSegmentGuard)
  // Before the CORS plugin, so a /v1/workflow-groups request it refuses gets no CORS answer.
  .use(workflowGroupsGuard)
  .use(cors())
  .use(noCorsOnWorkflowGroups)
  // After the CORS plugin, which answers a preflight before it, and whose headers a browser
  // needs to read the 401.
  .use(apiKeyGuard)
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
            "Each workflow group has its own API key, the one it was deployed with, sent as `Authorization: Bearer <key>` and checked before the request is read: a request without it is 401 whatever it sends. A workflow group deployed with no key is open. The requests, metrics, monitoring, prompts, scaling, governance, history and sample-data routes of a workflow under /v1/workflow-groups/<workflow_group_id> take that workflow group's key; a workflow group this API has no record of is 401. /v1/workflows and /v1/resources answer with the workflows of the workflow groups the key opens and of the open ones; a key that opens none of the workflow groups that have one is 401. /v1/auth/check answers 200 to a key that opens a workflow group, and to anyone while none has a key. The telemetry routes of a workflow group (POST traces, metrics and logs under /v1/workflow-groups/<workflow_group_id>) take no key: the Global Controller that sends them holds none. On Docker every other /v1/workflow-groups route takes the machine's deploy key (the sha256 of which is CANYONOS_DEPLOY_KEY_HASH) or the workflow group's own key, and is open on a workflow group with none; a workflow group this API has no record of yet takes the deploy key only, and the list shows each caller the workflow groups its key opens, the deploy key every one. On Kubernetes (CANYONOS_TARGET=kubernetes) each of those routes needs the Kubernetes login of its caller as `Authorization: Bearer <token>`, and a route on a workflow group needs the right to get (to read) or update (to change) CanyonProjects in its namespace. Until its database is migrated and answers, every route that reads it, the key checks included, answers 503 `database.unavailable`; /v1/readyz says when the API is ready.",
        },
        tags: [
          { name: 'Auth' },
          { name: 'Workflows' },
          { name: 'Requests' },
          { name: 'Metrics' },
          { name: 'Telemetry' },
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
            kubernetesToken: { type: 'http', scheme: 'bearer' },
          },
        },
      },
    })
  )
  .use(healthRoutes)
  .use(authRoutes)
  .use(resourcesRoutes)
  .use(workflowsRoutes)
  .use(workflowGroupsRoutes);

export type CanyonosApi = typeof app;

/** What runs on the database once it is ready; stopped on shutdown. */
const background: { stop(): void }[] = [];

/** Readies the database the routes need, then starts the loops that read it, unless `signal`
 * aborts first: the API is shutting down. */
async function prepare_database(signal: AbortSignal): Promise<void> {
  // A loop started while the API shuts down is stopped at once: stop() has already run.
  const keep = (loop: { stop(): void }) => {
    if (signal.aborted) loop.stop();
    else background.push(loop);
  };
  await wait_for_database(signal);
  if (signal.aborted) return;
  set_database_state('migrating');
  await run_migrations();
  await seedDevData();
  // Kubernetes: the operator lists the workflows; there is no one controller to register.
  if (config.canyonos.workflowsFile) keep(await start_listed_workflows_sync());
  else await bootstrap_registry();
  // On Kubernetes first finds the deploys running in the cluster again, then resumes nothing.
  await resume_apply_loops();
  if (signal.aborted) return;
  keep(start_registered_workflows_tick(config.registry.tickIntervalMs));
  keep(start_metrics_retention());
  set_database_state('ready');
  database_logger.info('Database ready', { env: config.environment });
}

/** A started API: `stop` closes its connections, the loops on its database and the database. */
export interface RunningApi {
  stop(): Promise<void>;
}

/** Listens at once and readies the database in the background, so /v1/healthz, /v1/readyz and
 * /v1/auth/status answer while it is down and every route that needs it answers 503. A setup that
 * fails once the database answers (a migration, a restore) exits the process with code 1, so its
 * restart policy, or Kubernetes, starts it again; a database that does not answer is waited for. */
export function start_api({ host, port }: { host: string; port: number }): RunningApi {
  http_logger.info('Starting API', { env: config.environment });
  // Bun's own cap is 128 MB; a workflow archive may be larger.
  const listening = app.listen(
    { hostname: host, port, maxRequestBodySize: MAX_UPLOAD_BYTES },
    ({ port }) => {
      http_logger.info('API listening', { host, port, env: config.environment });
    }
  );
  const shutting_down = new AbortController();
  void prepare_database(shutting_down.signal).catch((error: unknown) => {
    // A shutdown closing the database under the setup is no failure: it exits 0 itself.
    if (shutting_down.signal.aborted) return;
    set_database_state('failed');
    database_logger.error('Database setup failed; exiting so the API is started again', {
      error,
    });
    process.exit(1);
  });
  return {
    async stop() {
      shutting_down.abort();
      for (const loop of background.splice(0)) loop.stop();
      // Closes open connections too: a followed log or a long stop would hold a graceful stop.
      await listening.stop(true);
      await close_db();
    },
  };
}
