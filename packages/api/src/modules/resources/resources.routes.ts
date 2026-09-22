import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { MetricsWindowSchema } from '../metrics/metrics.types';
import { resourceCpuMock } from './resources.mock';
import { get_fleet_overview } from './resources.service';
import { FleetOverviewSchema } from './resources.types';

const OverviewQuery = z.object({ time_window: MetricsWindowSchema.default('30d') });

// `/cpu` stays the unauthenticated mock (resource detail screen, out of scope here); the auth
// resolver is registered after it so only `/overview` is protected.
export const resourcesRoutes = new Elysia({ prefix: '/resources', name: 'resources.routes' })
  .get('/cpu', () => resourceCpuMock)
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .get('/overview', ({ query }) => get_fleet_overview(query.time_window), {
    query: OverviewQuery,
    response: { 200: FleetOverviewSchema },
    detail: {
      tags: ['Resources'],
      security: [{ bearerAuth: [] }],
      summary: 'Fleet overview: per-project cost/requests/tokens over a time window',
    },
  });
