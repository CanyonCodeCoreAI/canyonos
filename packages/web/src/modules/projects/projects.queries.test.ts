import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { DEFAULT_REQUESTS_ORDER } from './projects.metrics';
import {
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardPollInterval,
  projectQueryKeys,
  refreshProjectDashboard,
  retryProjectDetailLoader,
} from './projects.query-cache';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000005';
const AGENT_ID = '00000000-0000-4000-8000-000000000006';

const FIRST_PAGE = { limit: 20, offset: 0, ...DEFAULT_REQUESTS_ORDER };
const SECOND_PAGE = { limit: 20, offset: 20, ...DEFAULT_REQUESTS_ORDER };
const NO_FILTERS = { status: undefined, selection: null, day: null };
const FAILED_FILTER = { status: 'failed' as const, selection: null, day: null };

function isInvalidated(query_client: QueryClient, query_key: readonly unknown[]): boolean {
  return query_client.getQueryState(query_key)?.isInvalidated ?? false;
}

describe('refreshProjectDashboard', () => {
  test('invalidates every section the dashboard reads, under any window, page or filter', async () => {
    const query_client = new QueryClient();

    const in_scope = [
      projectQueryKeys.metricsKpis(PROJECT_ID),
      projectQueryKeys.metricsTimeseries(PROJECT_ID, '7d', 'UTC'),
      projectQueryKeys.metricsDistribution(PROJECT_ID, 'cost_per_request', '7d', 20),
      projectQueryKeys.metricsBlocks(PROJECT_ID, '30d'),
      projectQueryKeys.metricsAgent(PROJECT_ID, AGENT_ID, 'UTC'),
      // Different page and different filters: the listing key inlines both, so a refresh that only
      // reached the entry currently on screen would leave these two behind.
      projectQueryKeys.requests(PROJECT_ID, FIRST_PAGE, NO_FILTERS),
      projectQueryKeys.requests(PROJECT_ID, SECOND_PAGE, FAILED_FILTER),
    ];
    const out_of_scope = [
      projectQueryKeys.detail(PROJECT_ID),
      projectQueryKeys.metricsKpis(OTHER_PROJECT_ID),
      projectQueryKeys.requests(OTHER_PROJECT_ID, FIRST_PAGE, NO_FILTERS),
      projectQueryKeys.requestTrace(PROJECT_ID, SESSION_ID),
    ];
    for (const key of [...in_scope, ...out_of_scope]) query_client.setQueryData(key, 'cached');

    await refreshProjectDashboard(query_client, PROJECT_ID);

    for (const key of in_scope) expect(isInvalidated(query_client, key)).toBe(true);
    for (const key of out_of_scope) expect(isInvalidated(query_client, key)).toBe(false);
  });

  test('keeps the cached data, so no section falls back to a skeleton while it re-reads', async () => {
    const query_client = new QueryClient();
    query_client.setQueryData(projectQueryKeys.metricsKpis(PROJECT_ID), 'kpis');
    query_client.setQueryData(
      projectQueryKeys.requests(PROJECT_ID, FIRST_PAGE, NO_FILTERS),
      'listing'
    );

    await refreshProjectDashboard(query_client, PROJECT_ID);

    expect(query_client.getQueryData<string>(projectQueryKeys.metricsKpis(PROJECT_ID))).toBe(
      'kpis'
    );
    expect(
      query_client.getQueryData<string>(
        projectQueryKeys.requests(PROJECT_ID, FIRST_PAGE, NO_FILTERS)
      )
    ).toBe('listing');
  });
});

describe('dashboardPollInterval', () => {
  const cachedQuery = (query_client: QueryClient) =>
    query_client.getQueryCache().find({ queryKey: projectQueryKeys.metricsKpis(PROJECT_ID) })!;

  test('keeps a section that answered on the interval', () => {
    const query_client = new QueryClient();
    query_client.setQueryData(projectQueryKeys.metricsKpis(PROJECT_ID), 'kpis');

    expect(dashboardPollInterval(cachedQuery(query_client))).toBe(DASHBOARD_POLL_INTERVAL_MS);
  });

  test('drops a section whose read failed, so a broken endpoint is not asked every tick', async () => {
    const query_client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await query_client
      .fetchQuery({
        queryKey: projectQueryKeys.metricsKpis(PROJECT_ID),
        queryFn: () => Promise.reject(new Error('metrics are down')),
      })
      .catch(() => undefined);

    expect(dashboardPollInterval(cachedQuery(query_client))).toBe(false);
  });
});

describe('retryProjectDetailLoader', () => {
  test('removes the failed detail query before invalidating and then resets the route', async () => {
    const query_client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await query_client
      .fetchQuery({
        queryKey: projectQueryKeys.detail(PROJECT_ID),
        queryFn: () => Promise.reject(new Error('Controlled loader failure')),
      })
      .catch(() => undefined);
    expect(query_client.getQueryState(projectQueryKeys.detail(PROJECT_ID))?.status).toBe('error');

    const calls: string[] = [];
    await retryProjectDetailLoader(
      query_client,
      PROJECT_ID,
      () => {
        calls.push('invalidate');
        expect(query_client.getQueryState(projectQueryKeys.detail(PROJECT_ID))).toBeUndefined();
        return Promise.resolve();
      },
      () => calls.push('reset')
    );

    expect(calls).toEqual(['invalidate', 'reset']);
  });
});
