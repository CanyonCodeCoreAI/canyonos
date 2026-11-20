// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { health, readiness } from './health.service';
import { HealthSchema, ReadinessSchema } from './health.types';

// Both answer without a key and without the database: /v1/healthz while the process serves
// (what a liveness probe asks), /v1/readyz once its database is ready (what traffic waits for).
export const healthRoutes = new Elysia({ prefix: '/v1', name: 'health.routes' })
  .get('/healthz', health, {
    response: { 200: HealthSchema },
    detail: { summary: 'Health Check', tags: ['system'] },
  })
  .get(
    '/readyz',
    async ({ status }) => {
      const result = await readiness();
      return result.status === 'ready' ? result : status(503, result);
    },
    {
      response: { 200: ReadinessSchema, 503: ReadinessSchema },
      detail: {
        summary: 'Ready once the database is migrated and answers; also says whether Docker does',
        tags: ['system'],
      },
    }
  );
