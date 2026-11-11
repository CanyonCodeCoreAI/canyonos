// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { config } from '@core/env';

import { register_project_at } from './canyonos.bootstrap';
import { RegisteredProjectSchema, RegisterProjectBody } from './canyonos.types';

// Temporary: applied now so multi-project dashboards work without blocking the flow; revisit
// with the project-key design in CAN-521 (the api should not hold per-project Redis addresses).
// Unauthenticated because the caller is the CLI on the deploy host, which holds no dashboard
// token. The body carries only a port, its password and, at most, the name of a CanyonOS
// project's Redis container: the api connects to that or its own configured Redis host, never a
// host the caller chooses freely, and takes the project id from the identity a controller wrote
// there.
export const canyonosRoutes = new Elysia({ prefix: '/canyonos', name: 'canyonos.routes' }).post(
  '/projects',
  ({ body }) =>
    register_project_at(
      body.redis_host ?? config.canyonos.redisHost,
      body.redis_port,
      body.redis_password
    ),
  {
    body: RegisterProjectBody,
    response: { 200: RegisteredProjectSchema },
    detail: { tags: ['CanyonOS'], summary: 'Register the project a controller runs' },
  }
);
