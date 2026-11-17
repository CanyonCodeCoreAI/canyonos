// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { TimeRangeQuerySchema } from '@core/time-range';

import { authPlugin, requireScope } from '../auth/auth.middleware';
import { get_fleet_overview } from './resources.service';
import { FleetOverviewSchema } from './resources.types';

export const resourcesRoutes = new Elysia({ prefix: '/resources', name: 'resources.routes' })
  .use(authPlugin)
  .get('/overview', ({ query }) => get_fleet_overview(query), {
    query: TimeRangeQuerySchema,
    response: { 200: FleetOverviewSchema },
    beforeHandle: requireScope('read'),
    detail: {
      tags: ['Resources'],
      security: [{ bearerAuth: [] }],
      summary: 'Fleet overview: per-deployment cost/requests/tokens over a time range',
      description: 'Counts the requests that started in the range, each whole.',
    },
  });
