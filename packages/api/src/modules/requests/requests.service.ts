import { notFound } from '@core/errors';

import { requests_repo } from './requests.repo';
import type { MetricsWindow } from '../metrics/metrics.types';
import type { RequestFilters } from './requests.repo';
import type {
  ListRequestsQuery,
  RequestList,
  RequestMetricRange,
  RequestSort,
  RequestTrace,
  SortDirection,
} from './requests.types';

// The window the distribution card reads by default, so a bucket picked from it filters the same
// requests it was drawn from without the client having to repeat the window.
const DEFAULT_METRIC_WINDOW: MetricsWindow = '30d';

// Newest first: what the listing meant before it could be ordered at all, and the only order that
// keeps the top-N index plan.
const DEFAULT_SORT: RequestSort = 'created_at';
const DEFAULT_ORDER: SortDirection = 'desc';

// The query schema admits metric/min/max only as a complete set, so all three being present is the
// same thing as the listing being scoped to a histogram bucket.
const metric_range = (query: ListRequestsQuery): RequestMetricRange | undefined =>
  query.metric !== undefined && query.min !== undefined && query.max !== undefined
    ? {
        metric: query.metric,
        min: query.min,
        max: query.max,
        time_window: query.time_window ?? DEFAULT_METRIC_WINDOW,
      }
    : undefined;

// The project is resolved upstream by resolveProjectAccess, so the service only shapes the page.
export async function list_requests(
  project_id: string,
  query: ListRequestsQuery
): Promise<RequestList> {
  const filters: RequestFilters = {
    status: query.status,
    time_window: query.time_window,
    range: metric_range(query),
    created_from: query.created_from,
    created_to: query.created_to,
  };
  const [items, total] = await Promise.all([
    requests_repo.list_by_project(project_id, {
      limit: query.limit,
      offset: query.offset,
      sort: query.sort ?? DEFAULT_SORT,
      order: query.order ?? DEFAULT_ORDER,
      ...filters,
    }),
    // `total` counts the same filtered set, so the client can render "showing 8 of N". The order
    // never changes which rows match, so the count is shared across every page and sort of one
    // selection.
    requests_repo.count_by_project(project_id, filters),
  ]);
  return { total, items };
}

export async function get_request_trace(
  project_id: string,
  session_id: string
): Promise<RequestTrace> {
  const trace = await requests_repo.trace_by_project(project_id, session_id);
  if (!trace) {
    throw notFound('requests.not_found', `Request "${session_id}" was not found`);
  }
  return trace;
}
