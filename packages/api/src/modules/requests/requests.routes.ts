import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { get_request_trace, list_requests } from './requests.service';
import { ListRequestsQuerySchema, RequestListSchema, RequestTraceSchema } from './requests.types';

const doc = { tags: ['Requests'], security: [{ bearerAuth: [] }] };

// Prefix-less: composed into projects.routes so both live in one `/projects` tree. Two separate
// `/projects` plugins would make Eden type `projects[:id]` a union and drop `.get` for clients.
export const requestsRoutes = new Elysia({ name: 'requests.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/requests', ({ params, query }) => list_requests(params.project_id, query), {
    params: z.object({ project_id: z.string().uuid() }),
    query: ListRequestsQuerySchema,
    response: { 200: RequestListSchema },
    detail: { ...doc, summary: 'List OTEL request traces with per-trace rollups' },
  })
  .get(
    '/:project_id/requests/:request_id',
    ({ params }) => get_request_trace(params.project_id, params.request_id),
    {
      params: z.object({
        project_id: z.string().uuid(),
        // OTEL trace IDs are opaque; this API accepts up to 255 characters. The otel_spans
        // column itself has no length limit.
        request_id: z.string().min(1).max(255),
      }),
      response: { 200: RequestTraceSchema },
      detail: { ...doc, summary: 'Get a single request trace' },
    }
  );
