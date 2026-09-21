import type { QueryClient, QueryKey } from '@tanstack/react-query';

import type { DistributionMetric, MetricsWindow } from '@cc-forge/api/metrics';
import type { FileContent } from '@cc-forge/api/projects';

import type { RequestListFilters, RequestsPage } from './projects.metrics';

export const projectQueryKeys = {
  all: ['projects'] as const,
  detail: (project_id: string) => ['projects', project_id] as const,
  status: (project_id: string) => ['projects', project_id, 'status'] as const,
  stats: (project_id: string) => ['projects', project_id, 'stats'] as const,
  workflows: (project_id: string) => ['projects', project_id, 'workflows'] as const,
  workflow: (project_id: string, workflow_id: string) =>
    ['projects', project_id, 'workflows', workflow_id] as const,
  workflowDesign: (project_id: string, workflow_id: string) =>
    ['projects', project_id, 'workflows', workflow_id, 'design'] as const,
  files: (project_id: string) => ['projects', project_id, 'files'] as const,
  file: (project_id: string, file_id: string) =>
    ['projects', project_id, 'files', file_id] as const,
  deployConfig: (project_id: string) => ['projects', project_id, 'deploy', 'config'] as const,
  deployPreview: (project_id: string) => ['projects', project_id, 'deploy', 'preview'] as const,
  deploySummary: (project_id: string) => ['projects', project_id, 'deploy', 'summary'] as const,
  // KPIs are keyed without a window: one response carries every window, so the range toggle
  // re-reads the same cache entry instead of refetching.
  metricsKpis: (project_id: string) => ['projects', project_id, 'metrics', 'kpis'] as const,
  metricsBlocks: (project_id: string, time_window: MetricsWindow) =>
    ['projects', project_id, 'metrics', 'blocks', time_window] as const,
  // Fixed trailing 30 days, so no window in the key. The zone is in it because the payload carries
  // a bucketed cost series, and the same agent read from two zones is two different series.
  metricsAgent: (project_id: string, agent_id: string, time_zone: string) =>
    ['projects', project_id, 'metrics', 'agents', agent_id, time_zone] as const,
  metricsTimeseries: (project_id: string, time_window: MetricsWindow, time_zone: string) =>
    ['projects', project_id, 'metrics', 'timeseries', time_window, time_zone] as const,
  metricsDistribution: (
    project_id: string,
    metric: DistributionMetric,
    time_window: MetricsWindow,
    buckets: number
  ) => ['projects', project_id, 'metrics', 'distribution', metric, time_window, buckets] as const,
  // Every filter the listing sends has to appear here, or narrowing one of them serves the page
  // fetched under the previous set.
  requests: (project_id: string, page: RequestsPage, filters: RequestListFilters) =>
    [
      'projects',
      project_id,
      'requests',
      page.limit,
      page.offset,
      page.sort,
      page.order,
      filters.time_window,
      filters.selection?.metric ?? null,
      filters.selection?.time_window ?? null,
      filters.selection?.min ?? null,
      filters.selection?.max ?? null,
      filters.status ?? null,
      filters.day?.created_from ?? null,
      filters.day?.created_to ?? null,
    ] as const,
  requestTrace: (project_id: string, session_id: string) =>
    ['projects', project_id, 'requests', session_id, 'trace'] as const,
};

export async function retryProjectDetailLoader(
  query_client: QueryClient,
  project_id: string,
  invalidate_route: () => Promise<void>,
  reset: () => void
): Promise<void> {
  query_client.removeQueries({
    queryKey: projectQueryKeys.detail(project_id),
    exact: true,
  });
  await invalidate_route();
  reset();
}

function isWorkflowDetailKey(query_key: QueryKey, project_id: string): boolean {
  return (
    query_key.length === 4 &&
    query_key[0] === 'projects' &&
    query_key[1] === project_id &&
    query_key[2] === 'workflows'
  );
}

function isWorkflowDesignKey(query_key: QueryKey, project_id: string): boolean {
  return (
    query_key.length === 5 &&
    query_key[0] === 'projects' &&
    query_key[1] === project_id &&
    query_key[2] === 'workflows' &&
    query_key[4] === 'design'
  );
}

// Everything under a deleted project (workflows, files, status, stats, deploy) is removed from the
// cache so nothing refetches a gone project, and the top-level project list is invalidated so the
// sidebar and any list views drop it.
export async function refreshAfterProjectDelete(
  query_client: QueryClient,
  project_id: string
): Promise<void> {
  query_client.removeQueries({ queryKey: projectQueryKeys.detail(project_id) });
  await query_client.invalidateQueries({ queryKey: projectQueryKeys.all, exact: true });
}

// The metrics sections, the context strip, and the query listing — not `requestTrace`: the drawer
// isn't live and a refresh must not refetch behind it.
export function isProjectDashboardQuery(query_key: QueryKey, project_id: string): boolean {
  if (query_key[0] !== 'projects' || query_key[1] !== project_id) return false;
  if (query_key[2] === 'requests' && query_key.at(-1) === 'trace') return false;
  return query_key[2] === 'metrics' || query_key[2] === 'requests' || query_key[2] === 'stats';
}

export const DASHBOARD_POLL_INTERVAL_MS = 5_000;

/**
 * The background re-read a dashboard section carries, as `refetchInterval`.
 *
 * A section that already has data keeps it while the tick runs, so the numbers change with no
 * skeleton and no disabled control — provided nothing renders off `isFetching`.
 *
 * A section whose last read failed drops out of the interval. None of these queries retry, so a
 * broken endpoint would otherwise be asked again every few seconds for as long as the tab is open.
 *
 * The parameter is the part of a `Query` this reads rather than `Query` itself, and its `error` is
 * the real type: either shortcut makes `useQuery` infer the section's data and error as `unknown`.
 */
export const dashboardPollInterval = (section: { state: { error: Error | null } }) =>
  section.state.error ? false : DASHBOARD_POLL_INTERVAL_MS;

// Invalidating rather than removing keeps cached data on screen while it re-reads; only active
// queries refetch, so other visited windows/pages are marked stale instead of refetched immediately.
export async function refreshProjectDashboard(
  query_client: QueryClient,
  project_id: string
): Promise<void> {
  await query_client.invalidateQueries({
    predicate: (query) => isProjectDashboardQuery(query.queryKey, project_id),
  });
}

export async function refreshProjectAfterFileSave(
  query_client: QueryClient,
  project_id: string,
  updated_file: FileContent
): Promise<void> {
  query_client.setQueryData(projectQueryKeys.file(project_id, updated_file.id), updated_file);

  await query_client.invalidateQueries({
    queryKey: projectQueryKeys.status(project_id),
    exact: true,
  });
  await query_client.cancelQueries({
    predicate: (query) => isWorkflowDesignKey(query.queryKey, project_id),
  });
  query_client.removeQueries({
    predicate: (query) => isWorkflowDesignKey(query.queryKey, project_id),
  });

  await Promise.all([
    query_client.invalidateQueries({ queryKey: projectQueryKeys.all, exact: true }),
    query_client.invalidateQueries({
      queryKey: projectQueryKeys.detail(project_id),
      exact: true,
    }),
    query_client.invalidateQueries({
      queryKey: projectQueryKeys.stats(project_id),
      exact: true,
    }),
    query_client.invalidateQueries({
      queryKey: projectQueryKeys.workflows(project_id),
      exact: true,
    }),
    query_client.invalidateQueries({
      predicate: (query) => isWorkflowDetailKey(query.queryKey, project_id),
    }),
    query_client.invalidateQueries({ queryKey: projectQueryKeys.files(project_id) }),
  ]);
}
