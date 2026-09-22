import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import type { FileContent } from '@canyonos/api/projects';

import { DEFAULT_REQUESTS_ORDER } from './projects.metrics';
import {
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardPollInterval,
  projectQueryKeys,
  refreshProjectAfterFileSave,
  refreshProjectDashboard,
  retryProjectDetailLoader,
} from './projects.query-cache';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000003';
const FILE_ID = '00000000-0000-4000-8000-000000000004';
const SESSION_ID = '00000000-0000-4000-8000-000000000005';
const AGENT_ID = '00000000-0000-4000-8000-000000000006';

const FIRST_PAGE = { limit: 20, offset: 0, ...DEFAULT_REQUESTS_ORDER };
const SECOND_PAGE = { limit: 20, offset: 20, ...DEFAULT_REQUESTS_ORDER };
const NO_FILTERS = { status: undefined, selection: null, day: null };
const FAILED_FILTER = { status: 'failed' as const, selection: null, day: null };

function isInvalidated(query_client: QueryClient, query_key: readonly unknown[]): boolean {
  return query_client.getQueryState(query_key)?.isInvalidated ?? false;
}

describe('refreshProjectAfterFileSave', () => {
  test('refreshes the project aggregate and removes only its cached workflow designs', async () => {
    const query_client = new QueryClient();
    const updated_file: FileContent = {
      id: FILE_ID,
      project_id: PROJECT_ID,
      path: 'workflow.py',
      name: 'workflow.py',
      language: 'python',
      byte_size: 18,
      component_kind: 'workflow',
      content: 'def changed(): pass',
      updated_at: '2026-07-16T00:00:00.000Z',
    };

    query_client.setQueryData(projectQueryKeys.all, ['projects']);
    query_client.setQueryData(projectQueryKeys.detail(PROJECT_ID), 'project');
    query_client.setQueryData(projectQueryKeys.status(PROJECT_ID), 'status');
    query_client.setQueryData(projectQueryKeys.stats(PROJECT_ID), 'stats');
    query_client.setQueryData(projectQueryKeys.workflows(PROJECT_ID), ['workflow']);
    query_client.setQueryData(projectQueryKeys.workflow(PROJECT_ID, WORKFLOW_ID), 'workflow');
    query_client.setQueryData(
      projectQueryKeys.workflowDesign(PROJECT_ID, WORKFLOW_ID),
      'stale design'
    );
    query_client.setQueryData(projectQueryKeys.files(PROJECT_ID), ['file']);
    query_client.setQueryData(projectQueryKeys.file(PROJECT_ID, FILE_ID), 'old file');
    query_client.setQueryData(
      projectQueryKeys.workflowDesign(OTHER_PROJECT_ID, WORKFLOW_ID),
      'other design'
    );

    await refreshProjectAfterFileSave(query_client, PROJECT_ID, updated_file);

    expect(isInvalidated(query_client, projectQueryKeys.all)).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.detail(PROJECT_ID))).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.status(PROJECT_ID))).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.stats(PROJECT_ID))).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.workflows(PROJECT_ID))).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.workflow(PROJECT_ID, WORKFLOW_ID))).toBe(
      true
    );
    expect(isInvalidated(query_client, projectQueryKeys.files(PROJECT_ID))).toBe(true);
    expect(isInvalidated(query_client, projectQueryKeys.file(PROJECT_ID, FILE_ID))).toBe(true);
    expect(
      query_client.getQueryData<FileContent>(projectQueryKeys.file(PROJECT_ID, FILE_ID))
    ).toEqual(updated_file);
    expect(
      query_client.getQueryData<string>(projectQueryKeys.workflowDesign(PROJECT_ID, WORKFLOW_ID))
    ).toBeUndefined();
    expect(
      query_client.getQueryData<string>(
        projectQueryKeys.workflowDesign(OTHER_PROJECT_ID, WORKFLOW_ID)
      )
    ).toBe('other design');
  });
});

describe('refreshProjectDashboard', () => {
  test('invalidates every section the dashboard reads, under any window, page or filter', async () => {
    const query_client = new QueryClient();

    const in_scope = [
      projectQueryKeys.metricsKpis(PROJECT_ID),
      projectQueryKeys.metricsTimeseries(PROJECT_ID, '7d', 'UTC'),
      projectQueryKeys.metricsDistribution(PROJECT_ID, 'cost_per_request', '7d', 20),
      projectQueryKeys.metricsBlocks(PROJECT_ID, '30d'),
      projectQueryKeys.metricsAgent(PROJECT_ID, AGENT_ID, 'UTC'),
      projectQueryKeys.stats(PROJECT_ID),
      // Different page and different filters: the listing key inlines both, so a refresh that only
      // reached the entry currently on screen would leave these two behind.
      projectQueryKeys.requests(PROJECT_ID, FIRST_PAGE, NO_FILTERS),
      projectQueryKeys.requests(PROJECT_ID, SECOND_PAGE, FAILED_FILTER),
    ];
    const out_of_scope = [
      projectQueryKeys.detail(PROJECT_ID),
      projectQueryKeys.files(PROJECT_ID),
      projectQueryKeys.workflows(PROJECT_ID),
      projectQueryKeys.deploySummary(PROJECT_ID),
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
