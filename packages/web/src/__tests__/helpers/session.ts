// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type {
  DistributionMetric,
  MetricsBlocks,
  MetricsDistribution,
  MetricsKpi,
  MetricsKpis,
  MetricsTimeseries,
  RunRatePer,
} from '@canyonos/api/metrics';
import type { RequestList } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';
import type { WorkflowSummary } from '@canyonos/api/workflows';

import { apiBaseUrl, failJson, fulfillJson } from './workflows';

const apiOrigin = new URL(apiBaseUrl).origin;

export const WORKFLOW: WorkflowSummary = {
  id: '44444444-4444-4444-8444-444444444401',
  name: 'Local Fraud Screen',
  workflow_group_id: '55555555-5555-4555-8555-555555555501',
  created_at: '2026-07-01T12:00:00.000Z',
  updated_at: '2026-07-01T12:00:00.000Z',
};

/** Where the API serves WORKFLOW's requests, metrics, monitoring, prompts, scaling and governance. */
export const WORKFLOW_API = `/v1/workflow-groups/${WORKFLOW.workflow_group_id}/workflows/${WORKFLOW.id}`;

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

export async function stubWorkflowsList(
  page: Page,
  workflows: readonly WorkflowSummary[]
): Promise<void> {
  await routePath(page, '/v1/workflows', (route) => fulfillJson(route, workflows));
}

/** The range the dashboard asked for, as the API echoes it. */
const requestedRange = (url: URL) => ({
  from: url.searchParams.get('from') ?? '',
  to: url.searchParams.get('to') ?? '',
});

/** As the API picks it: per hour for a range of a day or less, per day beyond. */
function runRatePer(url: URL): RunRatePer {
  const { from, to } = requestedRange(url);
  return Date.parse(to) - Date.parse(from) <= 86_400_000 ? 'hour' : 'day';
}

/** The fleet rollup the overview rows read spend from, answered empty. */
export async function stubFleetSpend(page: Page): Promise<void> {
  await routePath(page, '/v1/resources/overview', (route, url) =>
    fulfillJson(route, {
      kpis: [],
      resources: [],
      workflows: [],
      ...requestedRange(url),
    } satisfies FleetOverview)
  );
}

const EMPTY_KPI: MetricsKpi = {
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

export interface WorkflowDashboardOptions {
  /** Fail the KPI read, which is what the cost ribbon's error state is drawn from. */
  readonly kpis_fail?: boolean;
}

/** A workflow dashboard that ran nothing: every metrics endpoint answers, and answers empty. */
export async function stubWorkflowDashboard(
  page: Page,
  workflow: WorkflowSummary,
  { kpis_fail = false }: WorkflowDashboardOptions = {}
): Promise<void> {
  const api = `/v1/workflow-groups/${workflow.workflow_group_id}/workflows/${workflow.id}`;

  await routePath(page, `/v1/workflows/${workflow.id}`, (route) => fulfillJson(route, workflow));
  await routePath(page, `${api}/metrics/kpis`, (route, url) =>
    kpis_fail
      ? failJson(route, 'Could not read cost totals')
      : fulfillJson(route, {
          workflow_id: workflow.id,
          generated_at: '2026-07-29T12:00:00.000Z',
          ...requestedRange(url),
          ...EMPTY_KPI,
          run_rate: '0.0000000000',
          run_rate_per: runRatePer(url),
        } satisfies MetricsKpis)
  );
  await routePath(page, `${api}/metrics/timeseries`, (route, url) =>
    fulfillJson(route, {
      workflow_id: workflow.id,
      ...requestedRange(url),
      bucket_seconds: 86_400,
      points: [],
    } satisfies MetricsTimeseries)
  );
  await routePath(page, `${api}/metrics/blocks`, (route, url) =>
    fulfillJson(route, {
      workflow_id: workflow.id,
      ...requestedRange(url),
      total_cost: '0.000000',
      blocks: [],
    } satisfies MetricsBlocks)
  );
  await routePath(page, `${api}/metrics/distribution`, (route, url) =>
    fulfillJson(route, {
      workflow_id: workflow.id,
      metric: (url.searchParams.get('metric') as DistributionMetric | null) ?? 'cost_per_request',
      ...requestedRange(url),
      request_count: 0,
      mean: null,
      std: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      buckets: [],
    } satisfies MetricsDistribution)
  );
  await routePath(page, `${api}/requests`, (route, url) =>
    fulfillJson(route, { ...requestedRange(url), total: 0, items: [] } satisfies RequestList)
  );
}
