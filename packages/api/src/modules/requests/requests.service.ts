// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from '@core/errors';
import type { TimeRange } from '@core/time-range';

import { requests_repo } from './requests.repo';
import type {
  ListRequestsQuery,
  RequestList,
  RequestMetricRange,
  RequestSort,
  RequestTrace,
  SortDirection,
} from './requests.types';

// Newest first: what the listing meant before it could be ordered at all.
const DEFAULT_SORT: RequestSort = 'created_at';
const DEFAULT_ORDER: SortDirection = 'desc';

// The query schema admits metric/min/max only as a complete set, so all three being present is the
// same thing as the listing being scoped to a histogram bucket.
const metric_range = (query: ListRequestsQuery): RequestMetricRange | undefined =>
  query.metric !== undefined && query.min !== undefined && query.max !== undefined
    ? { metric: query.metric, min: query.min, max: query.max }
    : undefined;

// The project is resolved upstream by resolveProjectAccess, so the service only shapes the page.
export async function list_requests(
  project_id: string,
  query: ListRequestsQuery
): Promise<RequestList> {
  const { total, items } = await requests_repo.page_by_project(project_id, {
    from: query.from,
    to: query.to,
    status: query.status,
    range: metric_range(query),
    created_from: query.created_from,
    created_to: query.created_to,
    limit: query.limit,
    offset: query.offset,
    sort: query.sort ?? DEFAULT_SORT,
    order: query.order ?? DEFAULT_ORDER,
  });
  return { from: query.from, to: query.to, total, items };
}

export async function get_request_trace(
  project_id: string,
  session_id: string,
  range: TimeRange
): Promise<RequestTrace> {
  const trace = await requests_repo.trace_by_project(project_id, session_id, range);
  if (!trace) {
    throw notFound('requests.not_found', `Request "${session_id}" was not found`);
  }
  return trace;
}
