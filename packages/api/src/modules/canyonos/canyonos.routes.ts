// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { config } from '@core/env';

import { register_workflows_at } from './canyonos.bootstrap';
import { RegisteredWorkflowsSchema, RegisterWorkflowBody } from './canyonos.types';

// Temporary: applied now so multi-workflow dashboards work without blocking the flow; revisit
// with the workflow-key design in CAN-521 (the api should not hold per-workflow Redis addresses).
// Unauthenticated: the caller is the CLI on the deploy host. The body carries only a port, its
// password, the client certificate a Docker workflow group's Redis takes and, at most, the name of
// a CanyonOS workflow's Redis container: the api connects to that or its own configured Redis host,
// never a host the caller chooses freely, and takes the workflow id from the identity a controller
// wrote there.
export const canyonosRoutes = new Elysia({ prefix: '/canyonos', name: 'canyonos.routes' }).post(
  '/workflows',
  async ({ body }) => ({
    workflows: await register_workflows_at(
      body.redis_host ?? config.canyonos.redisHost,
      body.redis_port,
      body.redis_password,
      body.redis_tls
    ),
  }),
  {
    body: RegisterWorkflowBody,
    response: { 200: RegisteredWorkflowsSchema },
    detail: { tags: ['CanyonOS'], summary: 'Register each workflow a controller runs' },
  }
);
