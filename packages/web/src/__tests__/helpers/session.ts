// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type { KpiWindow, MetricsWindow } from '@canyonos/api/metrics';
import type { ProjectSummary } from '@canyonos/api/projects';

import { apiBaseUrl, failJson, fulfillJson } from './projects';

const apiOrigin = new URL(apiBaseUrl).origin;

export const PROJECT: ProjectSummary = {
  id: '44444444-4444-4444-8444-444444444401',
  name: 'Local Fraud Screen',
  file_count: 5,
  created_at: '2026-07-01T12:00:00.000Z',
  updated_at: '2026-07-01T12:00:00.000Z',
};

export async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

const isGet = (route: Route) => route.request().method() === 'GET';

async function routePath(
  page: Page,
  pathname: string,
  handler: (route: Route, url: URL) => Promise<void>
): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === pathname,
    (route) => (isGet(route) ? handler(route, new URL(route.request().url())) : route.continue())
  );
}

export async function stubProjectsList(
  page: Page,
  projects: readonly ProjectSummary[]
): Promise<void> {
  await routePath(page, '/projects', (route) => fulfillJson(route, projects));
}

/** The fleet rollup the overview rows read spend from, answered empty. */
export async function stubFleetSpend(page: Page): Promise<void> {
  await routePath(page, '/resources/overview', (route) =>
    fulfillJson(route, { kpis: [], resources: [], projects: [], time_window: '30d' })
  );
}

const EMPTY_KPI_WINDOW: KpiWindow = {
  request_count: 0,
  block_count: 0,
  failed_block_count: 0,
  tokens: 0,
  per_block_tokens: null,
  harness_cost: '0.000000',
  llm_cost: '0.000000',
  total_cost: '0.000000',
  recoverable_cost: '0.000000',
  per_block_cost: null,
  per_block_latency_ms: null,
  costed_block_count: 0,
  costed_request_count: 0,
  per_costed_request_cost: null,
};

const requestedWindow = (url: URL): MetricsWindow =>
  (url.searchParams.get('time_window') as MetricsWindow | null) ?? '30d';

export interface ProjectDashboardOptions {
  /** Fail the KPI read, which is what the cost ribbon's error state is drawn from. */
  readonly kpis_fail?: boolean;
}

/** A project dashboard that ran nothing: every metrics endpoint answers, and answers empty. */
export async function stubProjectDashboard(
  page: Page,
  project: ProjectSummary,
  { kpis_fail = false }: ProjectDashboardOptions = {}
): Promise<void> {
  const base = `/projects/${project.id}`;

  await routePath(page, base, (route) => fulfillJson(route, project));
  await routePath(page, `${base}/metrics/kpis`, (route) =>
    kpis_fail
      ? failJson(route, 'Could not read cost totals')
      : fulfillJson(route, {
          project_id: project.id,
          generated_at: '2026-07-29T12:00:00.000Z',
          windows: {
            '1d': EMPTY_KPI_WINDOW,
            '7d': EMPTY_KPI_WINDOW,
            '30d': EMPTY_KPI_WINDOW,
            '1q': EMPTY_KPI_WINDOW,
          },
        })
  );
  await routePath(page, `${base}/metrics/timeseries`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      time_window: requestedWindow(url),
      bucket_seconds: 86_400,
      points: [],
    })
  );
  await routePath(page, `${base}/metrics/blocks`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      time_window: requestedWindow(url),
      total_cost: '0.000000',
      blocks: [],
    })
  );
  await routePath(page, `${base}/metrics/distribution`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      metric: url.searchParams.get('metric') ?? 'cost_per_request',
      time_window: requestedWindow(url),
      request_count: 0,
      mean: null,
      std: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      buckets: [],
    })
  );
  await routePath(page, `${base}/requests`, (route) => fulfillJson(route, { total: 0, items: [] }));
}
