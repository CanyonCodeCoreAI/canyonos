// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { databasePlugin } from '@api/db/database';
import { TimeRangeQuerySchema } from '@core/time-range';

import { opened_by_key } from '../auth/auth.plugin';
import { get_fleet_overview } from './resources.service';
import { FleetOverviewSchema } from './resources.types';

// The key is checked before the request's query is, in `derive`.
export const resourcesRoutes = new Elysia({ prefix: '/v1/resources', name: 'resources.routes' })
  .use(databasePlugin)
  .derive(async ({ request }) => ({ opened: await opened_by_key(request) }))
  .get('/overview', ({ query, opened }) => get_fleet_overview(query, opened.ids), {
    query: TimeRangeQuerySchema,
    response: { 200: FleetOverviewSchema },
    detail: {
      tags: ['Resources'],
      security: [{ bearerAuth: [] }],
      summary: 'Fleet overview: per-workflow cost/requests/tokens over a time range',
      description:
        'Counts the requests that started in the range, each whole, of the workflows of the ' +
        'workflow groups the key opens, the open ones included.',
    },
  });
