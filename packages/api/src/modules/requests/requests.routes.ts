// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';
import { TimeRangeQuerySchema } from '@core/time-range';

import { resolve_group_workflow_access } from '../workflows/workflows.access';
import { GroupWorkflowParams } from '../workflows/workflows.types';
import { get_request_trace, list_requests } from './requests.service';
import { ListRequestsQuerySchema, RequestListSchema, RequestTraceSchema } from './requests.types';

const doc = { tags: ['Requests'], security: [{ bearerAuth: [] }] };

// Prefix-less: composed into workflow-groups.routes so both live in one `/v1/workflow-groups`
// tree. Two separate plugins on it would make Eden type `workflows[:id]` a union and drop `.get`
// for clients.
export const requestsRoutes = new Elysia({ name: 'requests.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .get(
    '/:workflow_group_id/workflows/:workflow_id/requests',
    ({ params, query }) => list_requests(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: ListRequestsQuerySchema,
      response: { 200: RequestListSchema },
      detail: { ...doc, summary: 'List OTEL request traces with per-trace rollups' },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/requests/:request_id',
    ({ params, query }) => get_request_trace(params.workflow_id, params.request_id, query),
    {
      params: GroupWorkflowParams.extend({
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
