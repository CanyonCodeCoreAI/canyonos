// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import {
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardPollInterval,
  projectQueryKeys,
  rangeParams,
  retryProjectDetailLoader,
} from './projects.query-cache';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const KPIS_KEY = ['projects', PROJECT_ID, 'kpis', { range: { preset: '7d' } }] as const;

describe('dashboardPollInterval', () => {
  const cachedQuery = (query_client: QueryClient) =>
    query_client.getQueryCache().find({ queryKey: KPIS_KEY })!;

  test('keeps a section that answered on the interval', () => {
    const query_client = new QueryClient();
    query_client.setQueryData(KPIS_KEY, 'kpis');

    expect(dashboardPollInterval(cachedQuery(query_client))).toBe(DASHBOARD_POLL_INTERVAL_MS);
  });

  test('drops a section whose read failed, so a broken endpoint is not asked every tick', async () => {
    const query_client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await query_client
      .fetchQuery({
        queryKey: KPIS_KEY,
        queryFn: () => Promise.reject(new Error('metrics are down')),
      })
      .catch(() => undefined);

    expect(dashboardPollInterval(cachedQuery(query_client))).toBe(false);
  });
});

describe('rangeParams', () => {
  test('ends a preset on the poll tick, so sections read on one tick ask for the same instants', () => {
    const tick = Date.parse('2026-10-26T12:00:00.000Z');

    expect(rangeParams({ preset: '15m' }, tick + 1)).toEqual(
      rangeParams({ preset: '15m' }, tick + DASHBOARD_POLL_INTERVAL_MS - 1)
    );
    expect(rangeParams({ preset: '15m' }, tick + 1)).toEqual({
      from: '2026-10-26T11:45:00.000Z',
      to: '2026-10-26T12:00:00.000Z',
    });
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
