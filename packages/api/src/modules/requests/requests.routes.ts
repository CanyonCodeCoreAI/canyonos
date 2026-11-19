// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { TimeRangeQuerySchema } from '@core/time-range';

import { authPlugin } from '../auth/auth.middleware';
import { resolveWorkflowAccess } from '../auth/workflow-access';
import { get_request_trace, list_requests } from './requests.service';
import { ListRequestsQuerySchema, RequestListSchema, RequestTraceSchema } from './requests.types';

const doc = { tags: ['Requests'], security: [{ bearerAuth: [] }] };

// Prefix-less: composed into workflows.routes so both live in one `/workflows` tree. Two separate
// `/workflows` plugins would make Eden type `workflows[:id]` a union and drop `.get` for clients.
export const requestsRoutes = new Elysia({ name: 'requests.routes' })
  .use(authPlugin)
  .resolve(resolveWorkflowAccess)
  .get('/:workflow_id/requests', ({ params, query }) => list_requests(params.workflow_id, query), {
    params: z.object({ workflow_id: z.string().uuid() }),
    query: ListRequestsQuerySchema,
    response: { 200: RequestListSchema },
    detail: { ...doc, summary: 'List OTEL request traces with per-trace rollups' },
  })
  .get(
    '/:workflow_id/requests/:request_id',
    ({ params, query }) => get_request_trace(params.workflow_id, params.request_id, query),
    {
      params: z.object({
        workflow_id: z.string().uuid(),
        // OTEL trace IDs are opaque; this API accepts up to 255 characters. The otel_spans
        // column itself has no length limit.
        request_id: z.string().min(1).max(255),
      }),
      query: TimeRangeQuerySchema,
      response: { 200: RequestTraceSchema },
      detail: {
        ...doc,
        summary: 'Get a single request trace',
        description:
          'The trace reads whole; its medians cover the requests that started in from/to.',
      },
    }
  );
