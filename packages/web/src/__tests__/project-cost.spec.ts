// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type {
  DistributionStats,
  MetricsAgentDetails,
  MetricsBlock,
  MetricsBlocks,
  MetricsDistribution,
  MetricsKpi,
  MetricsKpis,
  MetricsTimeseries,
} from '@canyonos/api/metrics';
import type { RequestList, RequestTrace } from '@canyonos/api/requests';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, failJson, fulfillJson } from './helpers/projects';

const apiOrigin = new URL(apiBaseUrl).origin;
const PROJECT_ID = '33333333-3333-4333-8333-333333333301';

// The dashboard is mocked at the network layer rather than seeded: the shared Docker database
// accumulates runtime rows across e2e runs, so asserting on ambient totals would be flaky.
function kpiRange(overrides: Partial<MetricsKpi> = {}) {
  const range = {
    request_count: 95,
    block_count: 681,
    tokens: 11_625_047,
    per_block_tokens: 17_070.55,
    harness_cost: '0.050492',
    llm_cost: '16.942207',
    total_cost: '84.948823',
    per_block_cost: '0.124741',
    per_block_latency_ms: 39_916.31,
    recoverable_cost: '17.779157',
    failed_block_count: 31,
    per_costed_request_cost: '0.894198',
    ...overrides,
  };
  // Fully priced unless a test says otherwise, so overriding a count cannot leave the costed
  // counterpart describing a different window.
  return {
    ...range,
    costed_request_count: overrides.costed_request_count ?? range.request_count,
    costed_block_count: overrides.costed_block_count ?? range.block_count,
  };
}

const KPIS: MetricsKpis = {
  project_id: PROJECT_ID,
  generated_at: '2026-07-29T12:00:00.000Z',
  from: '2026-06-29T12:00:00.000Z',
  to: '2026-07-29T12:00:00.000Z',
  run_rate: '2.831627',
  run_rate_per: 'day',
  ...kpiRange(),
};

/** The run rate the API reports for a window: spend over its length, null when nothing priced. */
function runRateFor(kpi: MetricsKpi, { from, to }: { from: string; to: string }) {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const run_rate_per = days <= 1 ? ('hour' as const) : ('day' as const);
  const unpriced = kpi.block_count > 0 && kpi.costed_block_count === 0;
  const run_rate = unpriced
    ? null
    : (Number(kpi.total_cost) / (run_rate_per === 'hour' ? days * 24 : days)).toFixed(6);
  return { run_rate, run_rate_per };
}

const KPI_RANGES = {
  '1d': kpiRange({
    request_count: 1,
    block_count: 12,
    llm_cost: '1.080000',
    harness_cost: '0.013220',
    total_cost: '1.093220',
  }),
  '7d': kpiRange({
    request_count: 73,
    tokens: 28_852_000,
    llm_cost: '60.520000',
    harness_cost: '4.122104',
    total_cost: '64.642104',
  }),
  '30d': kpiRange(),
  '1q': kpiRange(),
} as const;

// The agent tabs and drawer use this same spend breakdown. Rows sum to `total_cost`.
const BLOCKS: MetricsBlocks = {
  project_id: PROJECT_ID,
  from: KPIS.from,
  to: KPIS.to,
  total_cost: '84.948823',
  blocks: [
    {
      agent_id: 'writer',
      model: 'claude-opus-5',
      label: 'Report Writer',
      kind: 'model',
      cost: '68.706719',
      llm_cost: '68.400000',
      harness_cost: '0.306719',
      recoverable_cost: '16.144947',
      block_count: 128,
      token_count: 27_392_000,
      retry_rate: 0.1785,
      failed_rate: 0.0357,
      p95_latency_ms: 87_239.2,
      cache_hit_ratio: 0.42,
    },
    {
      agent_id: 'router',
      model: 'claude-haiku-4',
      label: 'router',
      kind: 'model',
      cost: '12.120000',
      llm_cost: '12.000000',
      harness_cost: '0.120000',
      recoverable_cost: '0.400000',
      block_count: 95,
      token_count: 1_900_000,
      retry_rate: 0.041,
      failed_rate: 0,
      p95_latency_ms: 5120.5,
      cache_hit_ratio: 0.71,
    },
    {
      agent_id: 'toolchain',
      model: null,
      label: 'toolchain',
      kind: 'harness',
      cost: '4.122104',
      llm_cost: '0.000000',
      harness_cost: '4.122104',
      recoverable_cost: '0.001984',
      block_count: 480,
      token_count: 0,
      retry_rate: 0.0776,
      failed_rate: 0,
      p95_latency_ms: 7699.9,
      cache_hit_ratio: null,
    },
  ],
};

// A fixed 12-bin equal-width histogram over `[min, max]`, as the agent route ships it.
// `request_count` is the sum of the bins rather than a second number to keep in step.
function distributionStats(input: {
  readonly min: number;
  readonly width: number;
  readonly counts: readonly number[];
  readonly mean: number;
  readonly std: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}): DistributionStats {
  const edge = (index: number) => Number((input.min + index * input.width).toFixed(6));
  return {
    request_count: input.counts.reduce((total, count) => total + count, 0),
    mean: input.mean,
    std: input.std,
    min: input.min,
    max: edge(input.counts.length),
    p50: input.p50,
    p95: input.p95,
    p99: input.p99,
    buckets: input.counts.map((count, index) => ({
      lower: edge(index),
      upper: edge(index + 1),
      count,
    })),
  };
}

type AgentDistributions = Pick<
  MetricsAgentDetails,
  'cost_per_request' | 'tokens_per_request' | 'latency'
>;

// The three distributions the agent route ships for one block, over the same 30 days. Cost and
// tokens bin every query the block ran in; latency bins the ones that finished, so it can add up to
// fewer. Each metric is centred somewhere of its own, so a chart drawn from the wrong field shows.
const AGENT_DISTRIBUTIONS: Record<string, AgentDistributions> = {
  writer: {
    // 68.706719 over 88 queries.
    cost_per_request: distributionStats({
      min: 0.12,
      width: 0.19,
      counts: [8, 14, 18, 18, 11, 7, 4, 3, 2, 1, 1, 1],
      mean: 0.780758,
      std: 0.481,
      p50: 0.77431,
      p95: 1.742,
      p99: 2.31,
    }),
    // 27.392M tokens over those same 88 queries.
    tokens_per_request: distributionStats({
      min: 120_000,
      width: 40_000,
      counts: [5, 11, 16, 19, 14, 9, 6, 4, 2, 1, 0, 1],
      mean: 311_272.7,
      std: 96_400,
      p50: 300_000,
      p95: 470_000,
      p99: 560_000,
    }),
    // 85 of the 88 finished, which is why this one bins fewer queries than the two above.
    latency: distributionStats({
      min: 20_000,
      width: 12_000,
      counts: [4, 9, 15, 17, 13, 10, 7, 4, 3, 2, 0, 1],
      mean: 62_400.5,
      std: 24_100,
      p50: 58_000,
      // Deliberately distinct from the overview card's per-block p95 (87_239.2): per-query wall
      // clock and per-block execution time are different statistics.
      p95: 79_800,
      p99: 128_000,
    }),
  },
  router: {
    // 12.12 over the 95 queries the router ran in — every one of them, since it opens the path.
    cost_per_request: distributionStats({
      min: 0.04,
      width: 0.02,
      counts: [3, 9, 17, 22, 18, 12, 6, 4, 2, 1, 0, 1],
      mean: 0.127579,
      std: 0.045,
      p50: 0.112,
      p95: 0.194,
      p99: 0.27,
    }),
    // 1.9M tokens over those 95 queries.
    tokens_per_request: distributionStats({
      min: 8000,
      width: 3000,
      counts: [4, 10, 16, 21, 17, 11, 7, 4, 3, 1, 0, 1],
      mean: 20_000,
      std: 5600,
      p50: 19_200,
      p95: 31_400,
      p99: 38_000,
    }),
    latency: distributionStats({
      min: 1200,
      width: 900,
      counts: [5, 12, 19, 21, 16, 10, 6, 3, 2, 1, 0, 0],
      mean: 3820.4,
      std: 1150,
      p50: 3500,
      p95: 5120.5,
      p99: 7400,
    }),
  },
  toolchain: {
    // 4.122104 over 73 queries.
    cost_per_request: distributionStats({
      min: 0.01,
      width: 0.01,
      counts: [4, 8, 13, 15, 12, 8, 5, 3, 2, 1, 1, 1],
      mean: 0.056467,
      std: 0.03,
      p50: 0.045,
      p95: 0.105,
      p99: 0.125,
    }),
    // A harness block bills no model tokens, so every query lands on the same zero bin.
    tokens_per_request: {
      request_count: 73,
      mean: 0,
      std: 0,
      min: 0,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      buckets: [{ lower: 0, upper: 0, count: 73 }],
    },
    latency: distributionStats({
      min: 400,
      width: 700,
      counts: [5, 10, 14, 15, 11, 7, 5, 3, 1, 1, 1, 0],
      mean: 2450.6,
      std: 1480,
      p50: 1800,
      p95: 7699.9,
      p99: 8400,
    }),
  },
};

// What the route ships for a metric none of the block's queries has produced a value for yet.
const NOTHING_COMPLETED: DistributionStats = {
  request_count: 0,
  mean: null,
  std: null,
  min: null,
  max: null,
  p50: null,
  p95: null,
  p99: null,
  buckets: [],
};

function agentDetails(blocks: MetricsBlocks, block: MetricsBlock): MetricsAgentDetails {
  const agent_id = block.agent_id;
  const distributions = AGENT_DISTRIBUTIONS[agent_id]!;
  const { agent_id: _agent_id, model: _model, label: _label, kind: _kind, ...summary } = block;

  return {
    project_id: PROJECT_ID,
    agent_id,
    label: block.label,
    from: KPIS.from,
    to: KPIS.to,
    project: { request_count: KPIS.request_count, total_cost: blocks.total_cost },
    agent: {
      ...summary,
      request_count: distributions.cost_per_request.request_count,
      replica_count: 1,
    },
    timeseries: agentTimeseries(block),
    ...distributions,
  };
}

function agentTimeseries(block: MetricsBlock): MetricsAgentDetails['timeseries'] {
  const day_seconds = 86_400;
  const start = Date.parse('2026-01-01T00:00:00.000Z');

  return {
    bucket_seconds: day_seconds,
    points: Array.from({ length: 30 }, (_point, index) => {
      const last = index === 29;
      return {
        start_at: new Date(start + index * day_seconds * 1000).toISOString(),
        llm_cost: last ? block.llm_cost : '0.000000',
        harness_cost: last ? block.harness_cost : '0.000000',
        total_cost: last ? block.cost : '0.000000',
        request_count: last ? 1 : 0,
        block_count: last ? block.block_count : 0,
        tokens: last ? block.token_count : 0,
      };
    }),
  };
}

function agentTable(blocks: MetricsBlocks): Record<string, MetricsAgentDetails> {
  return Object.fromEntries(
    blocks.blocks.map((block) => [block.agent_id, agentDetails(blocks, block)])
  );
}

const AGENT_DETAILS = agentTable(BLOCKS);

type FixtureRange = '1d' | '7d' | '30d' | '1q';

const RANGE_SECONDS: Record<FixtureRange, number> = {
  '1d': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '1q': 7_776_000,
};

const RANGE_BUCKETS: Record<FixtureRange, number> = {
  '1d': 24,
  '7d': 28,
  '30d': 30,
  '1q': 30,
};

// Midnight in the test fixture's display calendar.
const BUCKET_ANCHOR = new Date(2026, 5, 29).getTime();

function timeseriesFor(range: FixtureRange): MetricsTimeseries {
  const buckets = RANGE_BUCKETS[range];
  const bucket_seconds = RANGE_SECONDS[range] / buckets;
  return {
    project_id: PROJECT_ID,
    from: new Date(BUCKET_ANCHOR).toISOString(),
    to: new Date(BUCKET_ANCHOR + RANGE_SECONDS[range] * 1000).toISOString(),
    bucket_seconds,
    points: Array.from({ length: buckets }, (_item, index) => ({
      start_at: new Date(BUCKET_ANCHOR + index * bucket_seconds * 1000).toISOString(),
      llm_cost: (16 - (index % 7)).toFixed(6),
      harness_cost: '0.250000',
      total_cost: (16.25 - (index % 7)).toFixed(6),
      request_count: 15 - (index % 7),
      block_count: 120 - index,
      tokens: 1_500_000 - index * 10_000,
    })),
  };
}

const EXPENSIVE_TIMESERIES: MetricsTimeseries = {
  ...timeseriesFor('1q'),
  points: timeseriesFor('1q').points.map((point, index) => ({
    ...point,
    llm_cost: (300 + (index % 5) * 37.5).toFixed(6),
    harness_cost: '12.500000',
    total_cost: (312.5 + (index % 5) * 37.5).toFixed(6),
  })),
};

const DISTRIBUTION: MetricsDistribution = {
  project_id: PROJECT_ID,
  metric: 'cost_per_request',
  from: KPIS.from,
  to: KPIS.to,
  request_count: 95,
  mean: 0.894198,
  std: 0.612,
  min: 0.021,
  max: 2.727845,
  p50: 0.771312,
  p95: 2.018636,
  p99: 2.6,
  buckets: Array.from({ length: 5 }, (_, index) => ({
    lower: index * 0.55,
    upper: (index + 1) * 0.55,
    count: [12, 34, 26, 15, 8][index]!,
  })),
};

const REQUESTS: RequestList = {
  from: KPIS.from,
  to: KPIS.to,
  total: 95,
  items: [
    {
      session_id: '6215f346-e000-4000-8000-000000000001',
      status: 'completed',
      created_at: '2026-07-29T10:00:00.000Z',
      started_at: '2026-07-29T10:00:00.000Z',
      finished_at: '2026-07-29T10:03:06.000Z',
      duration_ms: 186_172,
      block_count: 12,
      failed_block_count: 0,
      error_count: 1,
      token_count: 194_669,
      llm_cost: '1.080000',
      harness_cost: '0.013220',
      total_cost: '1.093220',
    },
  ],
};

const REQUEST_TRACE: RequestTrace = {
  project_id: PROJECT_ID,
  session_id: REQUESTS.items[0]!.session_id,
  status: 'completed',
  created_at: '2026-07-29T10:00:00.000Z',
  input: {
    prompt: 'Review the attached invoice',
    context: { source: 'mock-runtime', priority: 'high' },
  },
  output: { result: 'Invoice reviewed' },
  started_at: '2026-07-29T10:00:00.000Z',
  finished_at: '2026-07-29T10:00:33.000Z',
  duration_ms: 33_000,
  total_cost: '2.0460000000',
  median_cost: '0.0120500000',
  cost_vs_median: 169.79,
  harness_cost: '0.0460000000',
  median_harness_cost: '0.0020500000',
  harness_cost_vs_median: 22.44,
  error_count: 4,
  token_count: 385_100,
  median_token_count: 192_550,
  token_count_vs_median: 2,
  blocks: [
    {
      future_id: 'trace-ingest',
      label: 'ingest',
      kind: 'harness',
      model: null,
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 0,
      execution_time_ms: 125,
      input_token_count: 0,
      output_token_count: 0,
      total_cost: '0.000110',
      errors: 0,
      failed: false,
    },
    {
      future_id: 'trace-classify',
      label: 'classify',
      kind: 'model',
      model: 'claude-haiku-4',
      prompt_name: 'Classifier.classify',
      prompt_version: 'Classifier-classify-0a1b2c3d-v3',
      started_offset_ms: 120,
      execution_time_ms: 438,
      input_token_count: 1100,
      output_token_count: 100,
      total_cost: '0.000980',
      errors: 0,
      failed: false,
    },
    {
      future_id: 'trace-retrieve',
      label: 'retrieve',
      kind: 'harness',
      model: null,
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 540,
      execution_time_ms: 1500,
      input_token_count: 0,
      output_token_count: 0,
      total_cost: '0.002300',
      errors: 0,
      failed: false,
    },
    {
      future_id: 'trace-extract',
      label: 'extract',
      kind: 'model',
      model: 'claude-sonnet-4-5',
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 1980,
      execution_time_ms: 7600,
      input_token_count: 214_000,
      output_token_count: 1200,
      total_cost: '0.998000',
      errors: 0,
      failed: false,
    },
    {
      future_id: 'trace-validate',
      label: 'validate',
      kind: 'model',
      model: 'claude-haiku-4',
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 9240,
      execution_time_ms: 688,
      input_token_count: 900,
      output_token_count: 120,
      total_cost: '0.003400',
      errors: 0,
      failed: false,
    },
    {
      future_id: 'trace-review',
      label: 'review-escalation ×5',
      kind: 'model',
      model: 'claude-opus-5',
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 9900,
      execution_time_ms: 22_000,
      input_token_count: 165_000,
      output_token_count: 2100,
      total_cost: '1.026000',
      errors: 4,
      failed: false,
    },
    {
      future_id: 'trace-emit',
      label: 'emit',
      kind: 'harness',
      model: null,
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 31_400,
      execution_time_ms: 125,
      input_token_count: 0,
      output_token_count: 0,
      total_cost: '0.000110',
      errors: 0,
      failed: false,
    },
  ],
};

// A query still in flight: no finish time, no duration, and its last block has not reported one
// either. The timeline has to lay out from the offsets alone.
const RUNNING_TRACE: RequestTrace = {
  ...REQUEST_TRACE,
  status: 'running',
  finished_at: null,
  duration_ms: null,
  blocks: [
    ...REQUEST_TRACE.blocks.slice(0, 2),
    { ...REQUEST_TRACE.blocks[2]!, execution_time_ms: null, total_cost: '0.000000' },
  ],
};

// The listing behind that trace, so the row and the drawer describe the same in-flight query.
const RUNNING_REQUESTS: RequestList = {
  from: REQUESTS.from,
  to: REQUESTS.to,
  total: 1,
  items: [{ ...REQUESTS.items[0]!, status: 'running', finished_at: null, duration_ms: null }],
};

const PROJECT = {
  id: PROJECT_ID,
  name: 'Request Router',
  file_count: 5,
  created_at: '2026-07-01T12:00:00.000Z',
  updated_at: '2026-07-01T12:00:00.000Z',
};

function requestedRange(url: URL) {
  return { from: url.searchParams.get('from')!, to: url.searchParams.get('to')! };
}

function requestedFixtureRange(url: URL): FixtureRange {
  const { from, to } = requestedRange(url);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days <= 1.1) return '1d';
  if (days <= 7.1) return '7d';
  if (days <= 30.1) return '30d';
  return '1q';
}

interface MetricsMocks {
  readonly kpis?: MetricsKpis;
  readonly kpisFails?: boolean;
  readonly agentFails?: boolean;
  readonly blocks?: MetricsBlocks;
  readonly timeseries?: MetricsTimeseries;
  readonly requests?: RequestList;
  readonly traceFails?: boolean;
  /** `null` answers `404 requests.not_found`, as a session the API no longer holds does. */
  readonly trace?: RequestTrace | null;
  /** Drawer payloads by `agent_id`. An agent that is not here answers `404 metrics.agent_not_found`. */
  readonly agents?: Record<string, MetricsAgentDetails>;
}

const AGENTS_PATH = `/projects/${PROJECT_ID}/metrics/agents/`;
const BLOCKS_PATH = `/projects/${PROJECT_ID}/metrics/blocks`;
const TIMESERIES_PATH = `/projects/${PROJECT_ID}/metrics/timeseries`;
const KPIS_PATH = `/projects/${PROJECT_ID}/metrics/kpis`;
const DISTRIBUTION_PATH = `/projects/${PROJECT_ID}/metrics/distribution`;

// The sections the dashboard shows above and beside the listing. Refresh has to move all of them, or
// the screen still reports two different reads.
const OVERVIEW_PATHS = [KPIS_PATH, TIMESERIES_PATH] as const;

// StrictMode lets a query fetch more than once, so the assertion is that the count grew — never what
// it grew to.
const countCalls = (calls: readonly string[], path: string) =>
  calls.filter((call) => call.startsWith(path)).length;

/**
 * Mocks the screen and returns every metrics request it made, as `pathname + search`.
 *
 * The drawer is asserted on through that list as well as through what it renders: it is fixed to
 * the trailing 30 days whatever range the dashboard shows, and the only proof of that is the URLs
 * it asks for.
 */
async function mockProjectCost(page: Page, options: MetricsMocks = {}): Promise<string[]> {
  const calls: string[] = [];
  const routes: readonly [string, (url: URL) => unknown, boolean][] = [
    [`/projects/${PROJECT_ID}`, () => PROJECT, false],
    [
      KPIS_PATH,
      (url) => {
        const kpis = options.kpis ?? { ...KPIS, ...KPI_RANGES[requestedFixtureRange(url)] };
        return { ...kpis, ...requestedRange(url), ...runRateFor(kpis, requestedRange(url)) };
      },
      options.kpisFails === true,
    ],
    [BLOCKS_PATH, (url) => ({ ...(options.blocks ?? BLOCKS), ...requestedRange(url) }), false],
    [
      TIMESERIES_PATH,
      (url) => ({
        ...(options.timeseries ?? timeseriesFor(requestedFixtureRange(url))),
        ...requestedRange(url),
      }),
      false,
    ],
    [DISTRIBUTION_PATH, (url) => ({ ...DISTRIBUTION, ...requestedRange(url) }), false],
    [
      `/projects/${PROJECT_ID}/requests`,
      (url) => ({ ...(options.requests ?? REQUESTS), ...requestedRange(url) }),
      false,
    ],
  ];

  for (const [pathname, body, fails] of routes) {
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === pathname,
      (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const url = new URL(route.request().url());
        calls.push(`${url.pathname}${url.search}`);
        return fails ? failJson(route) : fulfillJson(route, body(url));
      }
    );
  }

  await page.route(
    (url) =>
      url.origin === apiOrigin &&
      url.pathname === `/projects/${PROJECT_ID}/requests/${REQUEST_TRACE.session_id}`,
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      calls.push(`${url.pathname}${url.search}`);
      if (options.traceFails === true) return failJson(route);
      const trace = options.trace === undefined ? REQUEST_TRACE : options.trace;
      return trace
        ? fulfillJson(route, trace)
        : fulfillJson(
            route,
            {
              error: 'requests.not_found',
              message: `Request "${REQUEST_TRACE.session_id}" was not found`,
            },
            404
          );
    }
  );

  // One route for every agent, since the drawer addresses this endpoint by `agent_id`. A block the
  // runtime never ran in the last 30 days is a 404 carrying the route's own error code, which the
  // drawer reads as "nothing to show" rather than as a failure.
  const agents = options.agents ?? AGENT_DETAILS;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname.startsWith(AGENTS_PATH),
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      calls.push(`${url.pathname}${url.search}`);
      if (options.agentFails === true) return failJson(route);
      const details = agents[url.pathname.slice(AGENTS_PATH.length)];
      return details
        ? fulfillJson(route, details)
        : fulfillJson(
            route,
            {
              error: 'metrics.agent_not_found',
              message: 'No execution for this agent in the last 30 days',
            },
            404
          );
    }
  );

  return calls;
}

// The window never scrolls: the shell is a fixed-height column and this inset is the scroll port.
async function openQueryView(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Per-Query view' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Per-Query view' })).toBeVisible();
}

async function scrollShellTo(page: Page, top: number): Promise<void> {
  await page.evaluate((next) => {
    const scroll = document.querySelector('[data-testid="app-content-scroll"]');
    if (scroll) scroll.scrollTop = next;
  }, top);
}

const timeseriesTicks = (chart: Locator): Locator =>
  chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value');

async function boundingBoxes(ticks: Locator) {
  const boxes = await Promise.all((await ticks.all()).map((tick) => tick.boundingBox()));
  return boxes.map((box) => box!);
}

const AXIS_SHAPES: readonly [string, FixtureRange, RegExp][] = [
  ['24 hours', '1d', /^\d{1,2}:\d{2} (AM|PM)$/],
  ['7 days', '7d', /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/],
  ['30 days', '30d', /^[A-Z][a-z]{2} \d{1,2}$/],
  ['90 days', '1q', /^[A-Z][a-z]{2} \d{1,2}$/],
];

test.describe('project cost dashboard', () => {
  test('the timeseries and distribution read their own window and percentiles', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);

    // 7d spend spread over the window's own length, not per hour.
    await expect(page.getByTestId('project-timeseries-run-rate')).toContainText('/ day');
    await expect(page.getByTestId('project-timeseries-queries')).toContainText('73');

    // Every bucket is drawn as its own column (one rectangle per series) — not as an area
    // interpolating a path between the days that were actually measured.
    const timeseries = page.getByTestId('project-timeseries-chart');
    await expect(timeseries.locator('.recharts-bar-rectangle')).toHaveCount(
      timeseriesFor('7d').points.length * 2
    );
    await expect(timeseries.locator('.recharts-area-area')).toHaveCount(0);
    await expect(timeseriesTicks(timeseries)).toHaveCount(timeseriesFor('7d').points.length);

    // Percentiles are marked on the histogram itself rather than listed beside it.
    await page.getByRole('tab', { name: 'Per-Query view' }).click();
    const distribution = page.getByTestId('project-distribution-chart');
    await expect(distribution).toContainText('p50 $0.77');
    await expect(distribution).toContainText('p95 $2.02');

    await page.getByRole('tab', { name: 'Overview' }).click();

    await page
      .getByTestId('project-window-toggle')
      .getByRole('radio', { name: '24 hours' })
      .click();

    await expect(page.getByTestId('project-timeseries-run-rate')).toContainText('/ hour');
  });

  test('every bar is labelled with the span it covers, whichever window is showing', async ({
    page,
  }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);

    const chart = page.getByTestId('project-timeseries-chart');
    const ticks = timeseriesTicks(chart);

    for (const [control, range, shape] of AXIS_SHAPES) {
      await page.getByTestId('project-window-toggle').getByRole('radio', { name: control }).click();
      const { points } = timeseriesFor(range);
      await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(points.length * 2);
      await expect(ticks).toHaveCount(points.length);

      await expect(ticks.first()).toHaveText(shape);
      const labels = await ticks.allTextContents();
      expect(labels.filter((label) => !shape.test(label))).toEqual([]);
      expect(labels.filter((label, index) => labels.indexOf(label) !== index)).toEqual([]);
    }

    const seven_day_call = calls.find((call) => call.startsWith(`${TIMESERIES_PATH}?`));
    expect(requestedFixtureRange(new URL(seven_day_call!, 'http://localhost'))).toBe('7d');
  });

  test('tilted labels and money ticks stay inside the plotting surface', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { timeseries: EXPENSIVE_TIMESERIES });
    await page.goto(`/projects/${PROJECT_ID}`);

    const chart = page.getByTestId('project-timeseries-chart');
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(
      EXPENSIVE_TIMESERIES.points.length * 2
    );

    const surface = (await chart.locator('.recharts-surface').boundingBox())!;
    const right = surface.x + surface.width;
    const bottom = surface.y + surface.height;

    const dates = await boundingBoxes(timeseriesTicks(chart));
    for (const box of dates) {
      expect(box.x).toBeGreaterThanOrEqual(surface.x);
      expect(box.y + box.height).toBeLessThanOrEqual(bottom);
    }

    const money = chart.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value');
    expect(await money.allTextContents()).toContain('$462.50');
    for (const box of await boundingBoxes(money)) {
      expect(box.x).toBeGreaterThanOrEqual(surface.x);
      expect(box.x + box.width).toBeLessThanOrEqual(right);
    }
  });

  test('the window toggle rescopes the window-bound sections', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);

    const requested_ranges: FixtureRange[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.endsWith('/metrics/timeseries'),
      (route) => {
        const url = new URL(route.request().url());
        requested_ranges.push(requestedFixtureRange(url));
        return fulfillJson(route, {
          ...timeseriesFor(requestedFixtureRange(url)),
          ...requestedRange(url),
        });
      }
    );

    await page.goto(`/projects/${PROJECT_ID}`);
    await expect(page.getByTestId('project-cost-flow')).toBeVisible();

    await page.getByTestId('project-window-toggle').getByRole('radio', { name: '30 days' }).click();

    await expect.poll(() => requested_ranges.at(-1)).toBe('30d');
    await expect(page.getByTestId('project-cost-total')).toContainText('84.9');
    await expect(
      page.getByTestId('project-window-toggle').getByRole('radio', { name: '30 days' })
    ).toHaveAttribute('data-state', 'on');
  });

  test('the window toggle stays in the app header while the page scrolls', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);

    const requested_ranges: FixtureRange[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.endsWith('/metrics/timeseries'),
      (route) => {
        const url = new URL(route.request().url());
        requested_ranges.push(requestedFixtureRange(url));
        return fulfillJson(route, {
          ...timeseriesFor(requestedFixtureRange(url)),
          ...requestedRange(url),
        });
      }
    );

    await page.goto(`/projects/${PROJECT_ID}`);

    const toggle = page.getByTestId('app-header').getByTestId('project-window-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('project-hero').getByTestId('project-window-toggle')).toHaveCount(
      0
    );

    await scrollShellTo(page, 600);
    await expect(toggle).toBeVisible();

    await toggle.getByRole('radio', { name: '30 days' }).click();
    await expect.poll(() => requested_ranges.at(-1)).toBe('30d');
    await expect(page.getByTestId('project-cost-total')).toContainText('84.9');
  });

  test('the window is read from and written to the address', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}?range=30d`);

    const toggle = page.getByTestId('app-header').getByTestId('project-window-toggle');
    await expect(toggle.getByRole('radio', { name: '30 days' })).toHaveAttribute(
      'data-state',
      'on'
    );

    await toggle.getByRole('radio', { name: '24 hours' }).click();
    await expect(page).toHaveURL(/[?&]range=24h\b/);
  });

  test('a section that fails shows its own error without blanking the others', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { kpisFails: true });
    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(page.getByTestId('project-cost-ribbon-error')).toBeVisible();
    await expect(page.getByTestId('project-cost-flow')).toBeVisible();
    await expect(page.getByTestId('project-timeseries-chart')).toBeVisible();
    await expect(page.getByTestId('project-timeseries-stats-error')).toBeVisible();
    await expect(page.getByTestId('project-spend-highlights-error')).toBeVisible();

    await openQueryView(page);
    await expect(page.getByTestId('project-queries')).toBeVisible();
  });

  test('the stats rail shows its own error and retries independently of the chart', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    let failing = true;
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === KPIS_PATH,
      (route) => (failing ? failJson(route) : fulfillJson(route, KPIS))
    );

    await page.goto(`/projects/${PROJECT_ID}`);

    const error = page.getByTestId('project-timeseries-stats-error');
    await expect(error).toBeVisible();
    await expect(page.getByTestId('project-timeseries-chart')).toBeVisible();

    failing = false;
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('project-timeseries-stats')).toBeVisible();
  });

  test('a request that straddles the range still shows its in-range spend', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      kpis: {
        ...KPIS,
        ...kpiRange({
          request_count: 0,
          block_count: 2,
          llm_cost: '2.000000',
          harness_cost: '0.250000',
          total_cost: '2.250000',
          per_block_cost: '1.125000',
          per_costed_request_cost: null,
        }),
      },
    });

    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(page.getByTestId('project-cost-total')).toContainText('$2.25');
    await expect(page.getByTestId('project-cost-per-query')).toContainText('—');
  });
});

const kpisForRange = (range_overrides: Partial<MetricsKpi>): MetricsKpis => ({
  ...KPIS,
  ...kpiRange(range_overrides),
});

const coverageBadge = (page: Page, cell: string) => page.getByTestId(`${cell}-coverage`);

// Every cell denominated in money, and so qualified by how much of the window priced itself.
const MONEY_CELLS = [
  'project-cost-total',
  'project-cost-model',
  'project-cost-harness',
  'project-cost-per-query',
  'project-timeseries-run-rate',
  'project-timeseries-cost-per-query',
  'project-timeseries-recoverable',
];

// Counts, not money: coverage says nothing about them.
const COUNT_CELLS = [
  'project-cost-queries',
  'project-timeseries-queries',
  'project-timeseries-tokens',
];

test.describe('cost coverage', () => {
  test('a fully priced window carries no coverage badge', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(page.getByTestId('project-cost-total')).toContainText('$64.64');
    await expect(page.getByTestId('project-cost-model')).toContainText('$60.52');
    await expect(page.getByTestId('project-cost-harness')).toContainText('$4.12');
    for (const cell of [...MONEY_CELLS, ...COUNT_CELLS]) {
      await expect(coverageBadge(page, cell)).toHaveCount(0);
    }
  });

  test('a partly priced window says how much of it reported a cost', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      kpis: kpisForRange({
        request_count: 95,
        block_count: 681,
        costed_request_count: 40,
        costed_block_count: 300,
        total_cost: '84.948823',
        per_costed_request_cost: '2.123456',
      }),
    });
    await page.goto(`/projects/${PROJECT_ID}`);

    // The average covers the priced queries alone: 84.948823 / 95 would read $0.89.
    await expect(page.getByTestId('project-cost-per-query')).toContainText('$2.12');
    await expect(page.getByTestId('project-timeseries-cost-per-query')).toContainText('$2.12');

    await expect(page.getByTestId('project-cost-total')).toContainText('$84.95');
    await expect(page.getByTestId('project-cost-model')).toContainText('$16.94');
    await expect(page.getByTestId('project-cost-harness')).toContainText('$0.05');

    const badge = coverageBadge(page, 'project-cost-total');
    await expect(badge).toHaveText('Partial');
    await expect(badge).toHaveAttribute('data-coverage', 'partial');
    await expect(badge).toHaveAccessibleName('Cost data partial');

    await expect(badge).toHaveAccessibleDescription(/300 of 681 blocks across 40 of 95 queries/);
    await badge.focus();
    await expect(page.getByRole('tooltip')).toContainText('300 of 681 blocks');

    for (const cell of MONEY_CELLS) {
      await expect(coverageBadge(page, cell)).toHaveAttribute('data-coverage', 'partial');
    }
    for (const cell of COUNT_CELLS) {
      await expect(coverageBadge(page, cell)).toHaveCount(0);
    }
  });

  test('a window nothing priced reads as unavailable rather than as free', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      kpis: kpisForRange({
        request_count: 95,
        block_count: 681,
        costed_request_count: 0,
        costed_block_count: 0,
        llm_cost: '0.000000',
        harness_cost: '0.000000',
        total_cost: '0.000000',
        recoverable_cost: '0.000000',
        per_block_cost: null,
        per_costed_request_cost: null,
      }),
    });
    await page.goto(`/projects/${PROJECT_ID}`);

    const badge = coverageBadge(page, 'project-cost-total');
    await expect(badge).toHaveText('Unavailable');
    await expect(badge).toHaveAttribute('data-coverage', 'unavailable');
    await expect(badge).toHaveAccessibleName('Cost data unavailable');

    // The window ran 681 blocks and priced none, so the average has nothing to report.
    await expect(page.getByTestId('project-cost-per-query')).toContainText('—');
    await expect(page.getByTestId('project-timeseries-cost-per-query')).toContainText('—');
    await expect(coverageBadge(page, 'project-cost-per-query')).toHaveAttribute(
      'data-coverage',
      'unavailable'
    );

    for (const cell of ['project-cost-total', 'project-cost-model', 'project-cost-harness']) {
      await expect(page.getByTestId(cell)).toContainText('—');
      await expect(page.getByTestId(cell)).not.toContainText('$0.00');
    }
    await expect(page.getByTestId('project-timeseries-run-rate')).toContainText('—');
    await expect(page.getByTestId('project-timeseries-run-rate')).not.toContainText('$0.00');
    await expect(page.getByTestId('project-timeseries-recoverable')).toContainText('—');
    await expect(page.getByTestId('project-timeseries-recoverable')).not.toContainText('$0.00');

    await expect(page.getByTestId('project-cost-queries')).toContainText('95');
    await expect(coverageBadge(page, 'project-cost-queries')).toHaveCount(0);

    await expect(page.getByTestId('project-timeseries-empty')).toHaveCount(0);
    await expect(page.getByTestId('project-timeseries-unpriced')).toBeVisible();
  });

  test('a window that ran nothing is quiet rather than unavailable', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      kpis: kpisForRange({
        request_count: 0,
        block_count: 0,
        costed_request_count: 0,
        costed_block_count: 0,
        tokens: 0,
        llm_cost: '0.000000',
        harness_cost: '0.000000',
        total_cost: '0.000000',
        recoverable_cost: '0.000000',
        per_block_cost: null,
        per_block_tokens: null,
        per_costed_request_cost: null,
      }),
    });
    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(page.getByTestId('project-cost-total')).toContainText('$0.00');
    await expect(page.getByTestId('project-cost-model')).toContainText('$0.00');
    await expect(page.getByTestId('project-cost-harness')).toContainText('$0.00');
    for (const cell of MONEY_CELLS) {
      await expect(coverageBadge(page, cell)).toHaveCount(0);
    }
    await expect(page.getByTestId('project-timeseries-unpriced')).toHaveCount(0);
  });
});

test.describe('spend tabs', () => {
  test('keyboard navigation reaches both spend views and Pie agrees with List', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);

    const tabs = page.getByTestId('project-spend-tabs');
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('End');
    await expect(tabs.getByRole('tab', { name: 'Per-Query view' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toBeFocused();

    await page.getByRole('tab', { name: 'Per-Agent view' }).click();
    await expect(page.getByTestId('project-agent-share-row-writer').locator('..')).toContainText(
      '$68.71'
    );

    await page.getByRole('tab', { name: 'List' }).click();
    await expect(page.getByTestId('project-agent-row-writer').locator('..')).toContainText(
      '$68.71'
    );
  });

  test('every query window scopes the listing request', async ({ page }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    for (const [label, window] of [
      ['24 hours', '1d'],
      ['7 days', '7d'],
      ['30 days', '30d'],
      ['90 days', '1q'],
    ] as const) {
      await page.getByTestId('project-window-toggle').getByRole('radio', { name: label }).click();
      await expect
        .poll(() => {
          const call = calls
            .filter((item) => item.startsWith(`/projects/${PROJECT_ID}/requests?`))
            .at(-1);
          return call ? requestedFixtureRange(new URL(call, 'http://localhost')) : null;
        })
        .toBe(window);
    }
  });

  test('highlights show loading before their window data arrives', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === BLOCKS_PATH,
      async (route) => {
        await blocked;
        return fulfillJson(route, BLOCKS);
      }
    );

    await page.goto(`/projects/${PROJECT_ID}`);
    await expect(page.getByTestId('project-spend-highlights-loading')).toBeVisible();

    release();
    await expect(page.getByTestId('project-spend-highlights')).toBeVisible();
  });

  test('highlights use empty wording only for valid empty data', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      blocks: { ...BLOCKS, total_cost: '0.000000', blocks: [] },
      requests: { from: REQUESTS.from, to: REQUESTS.to, total: 0, items: [] },
    });

    await page.goto(`/projects/${PROJECT_ID}`);

    const highlights = page.getByTestId('project-spend-highlights');
    await expect(highlights).toContainText('Nothing has billed in this range.');
    await expect(highlights).toContainText('No queries have billed yet.');
  });

  test('highlights read as unavailable rather than free when nothing in the window priced', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      kpis: kpisForRange({
        request_count: 95,
        block_count: 681,
        costed_request_count: 0,
        costed_block_count: 0,
        total_cost: '0.000000',
      }),
      blocks: {
        ...BLOCKS,
        total_cost: '0.000000',
        blocks: BLOCKS.blocks.map((block) => ({
          ...block,
          cost: '0.000000',
          llm_cost: '0.000000',
          harness_cost: '0.000000',
        })),
      },
      requests: {
        ...REQUESTS,
        items: REQUESTS.items.map((item) => ({
          ...item,
          llm_cost: '0.000000',
          harness_cost: '0.000000',
          total_cost: '0.000000',
        })),
      },
    });

    await page.goto(`/projects/${PROJECT_ID}`);

    const highlights = page.getByTestId('project-spend-highlights');
    await expect(page.getByTestId('project-highlight-agent')).toHaveAccessibleName(
      /Most expensive agent: —/
    );
    await expect(page.getByTestId('project-highlight-query')).toHaveAccessibleName(
      /Most expensive query: —/
    );
    await expect(highlights).not.toContainText('$0.00');
    await expect(highlights).not.toContainText('Report Writer');
    await expect(highlights).toContainText('Cost data is unavailable for this range.');
  });

  test('empty data is visible in both Per-Agent and Per-Query views', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      blocks: { ...BLOCKS, total_cost: '0.000000', blocks: [] },
      requests: { from: REQUESTS.from, to: REQUESTS.to, total: 0, items: [] },
    });
    await page.goto(`/projects/${PROJECT_ID}`);

    await page.getByRole('tab', { name: 'Per-Agent view' }).click();
    await expect(page.getByTestId('project-agents-empty')).toBeVisible();

    await openQueryView(page);
    await expect(page.getByTestId('project-queries-empty')).toBeVisible();
  });

  test('highlights show an error and retry its failed request', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    let failing = true;
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === BLOCKS_PATH,
      (route) => (failing ? failJson(route) : fulfillJson(route, BLOCKS))
    );

    await page.goto(`/projects/${PROJECT_ID}`);

    const error = page.getByTestId('project-spend-highlights-error');
    await expect(error).toBeVisible();
    await expect(error).not.toContainText('Nothing has billed');

    failing = false;
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('project-spend-highlights')).toBeVisible();
  });
});

const SHELL_TOLERANCE = 2;

const MIN_CARD_SLACK = 48;

const SPEND_CUTS: readonly [string, RegExp][] = [
  ['Overview', /^Cost trends$/],
  ['Per-Agent view', /^Per-agent breakdown$/],
  ['Per-Query view', /^Per-query distribution/],
];

async function boxOf(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function openSpendTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tabpanel', { name })).toBeVisible();
  await scrollShellTo(page, 0);
}

function manyBlocks(count: number): MetricsBlocks {
  const blocks: MetricsBlock[] = Array.from({ length: count }, (_, index) => {
    const cost = (count - index) * 1.25;
    return {
      agent_id: `agent-${String(index).padStart(2, '0')}`,
      model: 'claude-opus-5',
      label: `Agent ${String(index).padStart(2, '0')}`,
      kind: 'model',
      cost: cost.toFixed(6),
      llm_cost: (cost - 0.01).toFixed(6),
      harness_cost: '0.010000',
      recoverable_cost: '0.000000',
      block_count: 12 + index,
      token_count: 250_000 + index,
      retry_rate: 0.02,
      failed_rate: 0,
      p95_latency_ms: 4200 + index,
      cache_hit_ratio: 0.5,
    };
  });

  return {
    project_id: PROJECT_ID,
    from: KPIS.from,
    to: KPIS.to,
    total_cost: blocks.reduce((sum, block) => sum + Number(block.cost), 0).toFixed(6),
    blocks,
  };
}

const shellMetrics = (page: Page) =>
  page.evaluate(() => {
    const port = document.querySelector('[data-testid="app-content-scroll"]');
    if (port === null) return null;
    return { top: port.scrollTop, content: port.scrollHeight, visible: port.clientHeight };
  });

const cardFit = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid="project-cost-flow"]')!;
    const panel = card.querySelector('[role="tabpanel"]:not([hidden])')!;
    const port = document.querySelector('[data-testid="app-content-scroll"]')!;
    const card_box = card.getBoundingClientRect();
    return {
      content_gap:
        card_box.bottom -
        Number.parseFloat(getComputedStyle(card).paddingBottom) -
        panel.getBoundingClientRect().bottom,
      port_gap: port.getBoundingClientRect().bottom - card_box.bottom,
    };
  });

test.describe('spend shell', () => {
  test('the header and strip hold while each cut heads its own content', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);

    const flow = page.getByTestId('project-cost-flow');
    const heading = flow.getByRole('heading', { name: 'Where the money sits' });
    const strip = page.getByTestId('project-spend-tabs');

    await expect(page.getByTestId('project-timeseries-run-rate')).toBeVisible();
    await scrollShellTo(page, 0);

    const first_heading = await boxOf(heading);
    const first_strip = await boxOf(strip);

    for (const [tab, content_heading] of SPEND_CUTS) {
      await openSpendTab(page, tab);

      await expect(heading).toBeVisible();
      await expect(flow).toContainText('read three ways');

      const moved_heading = await boxOf(heading);
      const moved_strip = await boxOf(strip);
      expect(Math.abs(moved_heading.y - first_heading.y)).toBeLessThanOrEqual(SHELL_TOLERANCE);
      expect(Math.abs(moved_strip.y - first_strip.y)).toBeLessThanOrEqual(SHELL_TOLERANCE);

      const named = await boxOf(
        page
          .getByRole('tabpanel', { name: tab })
          .getByRole('heading', { name: content_heading })
          .first()
      );
      expect(named.y).toBeGreaterThan(moved_strip.y + moved_strip.height - SHELL_TOLERANCE);
    }
  });

  test.describe('short content on a tall desktop', () => {
    test.use({ viewport: { width: 1440, height: 1200 } });

    test('the card stops at its content and leaves the port below it free', async ({ page }) => {
      await authenticate(page);
      await mockProjectCost(page);
      await page.goto(`/projects/${PROJECT_ID}`);
      await expect(page.getByTestId('project-timeseries-run-rate')).toBeVisible();
      await scrollShellTo(page, 0);

      const overview = await cardFit(page);
      expect(Math.abs(overview.content_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);
      expect(overview.port_gap).toBeGreaterThanOrEqual(MIN_CARD_SLACK);

      const shell = (await shellMetrics(page))!;
      expect(shell.content).toBeLessThanOrEqual(shell.visible + SHELL_TOLERANCE);

      await openSpendTab(page, 'Per-Agent view');
      await page.getByRole('tab', { name: 'List' }).click();

      const agent_list = page.getByRole('region', { name: 'Agent spend list' });
      await expect(agent_list.getByRole('listitem')).toHaveCount(3);

      const listed = await cardFit(page);
      expect(Math.abs(listed.content_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);
      expect(listed.port_gap).toBeGreaterThanOrEqual(MIN_CARD_SLACK);

      const bounds = await agent_list.evaluate((node) => ({
        client: node.clientHeight,
        content: node.scrollHeight,
      }));
      expect(bounds.content).toBeLessThanOrEqual(bounds.client + SHELL_TOLERANCE);
    });
  });

  test.describe('tall content on a short desktop', () => {
    test.use({ viewport: { width: 1280, height: 600 } });

    test('the card grows to hold the views that do not scroll', async ({ page }) => {
      await authenticate(page);
      await mockProjectCost(page);
      await page.goto(`/projects/${PROJECT_ID}`);
      await expect(page.getByTestId('project-timeseries-run-rate')).toBeVisible();

      expect(Math.abs((await cardFit(page)).content_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);

      await openSpendTab(page, 'Per-Agent view');
      await expect(page.getByTestId('project-agent-share')).toBeVisible();
      expect(Math.abs((await cardFit(page)).content_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);
    });
  });

  test.describe('a long agent list on a tall desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the List takes only the viewport space left below it', async ({ page }) => {
      await authenticate(page);
      await mockProjectCost(page, { blocks: manyBlocks(24) });
      await page.goto(`/projects/${PROJECT_ID}`);
      await expect(page.getByTestId('project-timeseries-run-rate')).toBeVisible();

      await openSpendTab(page, 'Per-Agent view');
      await expect(page.getByTestId('project-agent-share')).toBeVisible();

      const before = (await shellMetrics(page))!;

      await page.getByRole('tab', { name: 'List' }).click();
      const agent_list = page.getByRole('region', { name: 'Agent spend list' });
      await expect(agent_list.getByRole('listitem')).toHaveCount(24);

      const after = (await shellMetrics(page))!;
      expect(after.top).toBe(before.top);
      expect(after.content).toBeLessThanOrEqual(before.content);
      expect(after.content).toBeLessThanOrEqual(after.visible + SHELL_TOLERANCE);

      const fit = await page.evaluate(() => {
        const screen = document.querySelector('[data-testid="project-screen"]')!;
        const card = document.querySelector('[data-testid="project-cost-flow"]')!;
        const port = document.querySelector('[data-testid="app-content-scroll"]')!;
        const bounds = screen.getBoundingClientRect();
        const padding = Number.parseFloat(getComputedStyle(screen).paddingBottom);
        return {
          card_gap: bounds.bottom - padding - card.getBoundingClientRect().bottom,
          screen_gap: port.getBoundingClientRect().bottom - bounds.bottom,
        };
      });
      expect(Math.abs(fit.card_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);
      expect(Math.abs(fit.screen_gap)).toBeLessThanOrEqual(SHELL_TOLERANCE);

      const bounds = await agent_list.evaluate((node) => ({
        client: node.clientHeight,
        content: node.scrollHeight,
      }));
      expect(bounds.content).toBeGreaterThan(bounds.client);

      const columns = agent_list.getByText('Agent', { exact: true });
      const columns_before = await boxOf(columns);
      await agent_list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const columns_after = await boxOf(columns);
      expect(Math.abs(columns_after.y - columns_before.y)).toBeLessThanOrEqual(SHELL_TOLERANCE);

      const summary = page.getByTestId('project-agents').getByText('24 agents', { exact: false });
      const summary_box = await boxOf(summary);
      const list_box = await boxOf(agent_list);
      expect(summary_box.y).toBeGreaterThanOrEqual(list_box.y + list_box.height - SHELL_TOLERANCE);

      await agent_list.evaluate((node) => {
        node.scrollTop = 0;
      });
      await expect.poll(() => agent_list.evaluate((node) => node.scrollTop)).toBe(0);

      await agent_list.getByRole('button', { name: 'Open metrics for Agent 23' }).focus();
      await expect.poll(() => agent_list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      expect((await shellMetrics(page))!.top).toBe(before.top);
    });
  });
});

test.describe('distribution selection', () => {
  test('picking a histogram bar lists that bucket, and picking it again clears', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);

    const ranges: string[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.endsWith('/requests'),
      (route) => {
        const url = new URL(route.request().url());
        const metric = url.searchParams.get('metric');
        ranges.push(
          metric ? `${metric}:${url.searchParams.get('min')}-${url.searchParams.get('max')}` : 'all'
        );
        return fulfillJson(route, REQUESTS);
      }
    );

    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);
    await expect(page.getByTestId('project-queries').getByRole('heading', { level: 2 })).toHaveText(
      'Queries · 7 days'
    );
    // The unfiltered listing must not send a half-specified range, which the API rejects.
    await expect.poll(() => ranges.at(-1)).toBe('all');

    // recharts draws each bar as a path beneath the tooltip surface, so a plain click lands on the
    // overlay; clicking the bar's centre is what a reader actually does.
    await page.getByTestId('project-distribution-chart').scrollIntoViewIfNeeded();
    // Dispatched rather than pointer-clicked: an svg <path> carries no layout box for Playwright to
    // aim at, and the chart swaps its path nodes on every re-render. Re-queried per click for the
    // same reason.
    const clickBar = async () => {
      const bar = page
        .locator('[data-testid="project-distribution-chart"] .recharts-bar-rectangle')
        .first();
      await expect(bar).toBeAttached();
      await bar.dispatchEvent('click');
    };
    await clickBar();

    await expect(
      page.getByTestId('project-queries').getByRole('heading', { level: 2 })
    ).toContainText('Queries · 7 days ·');
    await expect.poll(() => ranges.at(-1)).toMatch(/^cost_per_request:/);

    await clickBar();
    await expect(page.getByTestId('project-queries').getByRole('heading', { level: 2 })).toHaveText(
      'Queries · 7 days'
    );
    await expect.poll(() => ranges.at(-1)).toBe('all');
  });

  test('changing the range clears the selected bucket', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);

    const asks: { selected: boolean; days: number }[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.endsWith('/requests'),
      (route) => {
        const url = new URL(route.request().url());
        const span_ms =
          Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!);
        asks.push({
          selected: url.searchParams.has('metric'),
          days: Math.round(span_ms / 86_400_000),
        });
        return fulfillJson(route, REQUESTS);
      }
    );

    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);
    const bar = page
      .locator('[data-testid="project-distribution-chart"] .recharts-bar-rectangle')
      .first();
    await expect(bar).toBeAttached();
    await bar.dispatchEvent('click');
    await expect.poll(() => asks.at(-1)?.selected).toBe(true);

    await page.getByTestId('project-window-toggle').getByRole('radio', { name: '30 days' }).click();

    // The bucket lives in the screen, not the URL, so the cleared bucket shows up in what the table
    // asks for rather than in the address bar.
    await expect.poll(() => asks.at(-1)).toEqual({ selected: false, days: 30 });
    // Dropped in the same render as the range change: the old bucket is never asked for under 30 days.
    expect(asks.filter((ask) => ask.selected && ask.days === 30)).toHaveLength(0);
    await expect(page.getByTestId('project-queries').getByRole('heading', { level: 2 })).toHaveText(
      'Queries · 30 days'
    );
  });
});

test.describe('queries table ordering and paging', () => {
  // A full page, so "1–5 of 95" and the Next button both have something to describe.
  const FULL_PAGE: RequestList = {
    from: REQUESTS.from,
    to: REQUESTS.to,
    total: 95,
    items: Array.from({ length: 5 }, (_item, index) => ({
      ...REQUESTS.items[0]!,
      session_id: `6215f346-e000-4000-8000-00000000000${index}`,
    })),
  };

  /** Records the query string of every listing request, and always answers with a full page. */
  async function trackListing(page: Page): Promise<URLSearchParams[]> {
    const asked: URLSearchParams[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === `/projects/${PROJECT_ID}/requests`,
      (route) => {
        asked.push(new URL(route.request().url()).searchParams);
        return fulfillJson(route, FULL_PAGE);
      }
    );
    return asked;
  }

  const lastAsk = (asked: URLSearchParams[], key: string): string | null =>
    asked.at(-1)?.get(key) ?? null;

  /**
   * Holds the listing's next background re-read open, so the screen can be asserted on while a poll
   * is genuinely in flight. Armed from the test, because the initial load has to land first.
   */
  async function holdNextListingRead(page: Page) {
    let armed = false;
    let arrived!: () => void;
    let release!: () => void;
    const in_flight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route(
      (url) =>
        url.origin === apiOrigin &&
        url.pathname === `/projects/${PROJECT_ID}/requests` &&
        // The table's page, not the single dearest query the highlights read from the same route.
        url.searchParams.get('limit') === '5',
      async (route) => {
        if (!armed) return route.fallback();
        armed = false;
        arrived();
        await released;
        return route.fallback();
      }
    );

    return {
      arm: () => {
        armed = true;
      },
      in_flight,
      release: () => release(),
    };
  }

  test('@smoke the listing opens newest-first and reverses the column it is sorted by', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    await expect(page.getByTestId('project-queries-table')).toBeVisible();
    await expect.poll(() => lastAsk(asked, 'sort')).toBe('created_at');
    expect(lastAsk(asked, 'order')).toBe('desc');

    const dataColumnWidths = await Promise.all(
      ['query', 'created_at', 'total_cost', 'duration_ms'].map((column) =>
        page
          .getByTestId(`project-queries-column-${column}`)
          .evaluate((element) => element.getBoundingClientRect().width)
      )
    );
    expect(Math.max(...dataColumnWidths) - Math.min(...dataColumnWidths)).toBeLessThanOrEqual(1);

    // A fresh column opens on its most interesting end: the most expensive queries, not the cheapest.
    const cost = page.getByTestId('project-queries-column-total_cost');
    await cost.getByRole('button').click();
    await expect.poll(() => lastAsk(asked, 'sort')).toBe('total_cost');
    expect(lastAsk(asked, 'order')).toBe('desc');
    await expect(cost).toHaveAttribute('aria-sort', 'descending');
    // The column it moved off no longer claims a direction.
    await expect(page.getByTestId('project-queries-column-created_at')).toHaveAttribute(
      'aria-sort',
      'none'
    );

    await cost.getByRole('button').click();
    await expect.poll(() => lastAsk(asked, 'order')).toBe('asc');
    await expect(cost).toHaveAttribute('aria-sort', 'ascending');
  });

  test('status filters the listing without becoming a sort control', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    // Status offers a filter, Query is an identifier, and only the three data columns are sortable.
    const headers = page.getByTestId('project-queries-table').getByRole('columnheader');
    await expect(headers.getByRole('button')).toHaveCount(3);

    const filter = page.getByTestId('project-queries-status-filter');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveAccessibleName('Filter queries by status');
    await filter.click();
    await page.getByRole('option', { name: 'Running', exact: true }).click();

    await expect.poll(() => lastAsk(asked, 'status')).toBe('running');
    expect(lastAsk(asked, 'offset')).toBe('0');
    await expect(filter).toHaveAccessibleName('Filter queries by status: Running');
    await expect(page.getByTestId('project-queries').getByRole('heading', { level: 2 })).toHaveText(
      'Queries · 7 days · Running'
    );

    await filter.click();
    await page.getByRole('option', { name: 'All statuses', exact: true }).click();
    await expect.poll(() => lastAsk(asked, 'status')).toBeNull();
    await expect(page.getByTestId('project-queries').getByRole('heading', { level: 2 })).toHaveText(
      'Queries · 7 days'
    );
  });

  test('paging walks the offset and reports the range it is showing', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    const count = page.getByTestId('project-queries-count');
    await expect(count).toHaveText('1–5 of 95 queries');
    await expect(page.getByTestId('project-queries-previous')).toBeDisabled();

    // A page turn must not resize the listing under the reader, so the section is measured either
    // side of one.
    const section = page.getByTestId('project-queries');
    const before = (await section.boundingBox())!.height;

    await page.getByTestId('project-queries-next').click();
    await expect.poll(() => lastAsk(asked, 'offset')).toBe('5');
    await expect(count).toHaveText('6–10 of 95 queries');
    await expect(page.getByTestId('project-queries-previous')).toBeEnabled();
    expect((await section.boundingBox())!.height).toBe(before);

    await page.getByTestId('project-queries-previous').click();
    await expect.poll(() => lastAsk(asked, 'offset')).toBe('0');
    await expect(count).toHaveText('1–5 of 95 queries');
  });

  test('re-sorting returns to the first page, since the rows on this one have moved', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    await page.getByTestId('project-queries-next').click();
    await expect.poll(() => lastAsk(asked, 'offset')).toBe('5');

    await page.getByTestId('project-queries-column-duration_ms').getByRole('button').click();
    await expect.poll(() => lastAsk(asked, 'sort')).toBe('duration_ms');
    expect(lastAsk(asked, 'offset')).toBe('0');
    await expect(page.getByTestId('project-queries-count')).toHaveText('1–5 of 95 queries');
  });

  test('re-reads what is on screen on its own, with no click', async ({ page }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    const asked = await trackListing(page);
    // The table's own page. The spend highlights read one dearest query off the same route.
    const listingReads = () => asked.filter((params) => params.get('limit') === '5').length;
    await page.goto(`/projects/${PROJECT_ID}`);
    await expect(page.getByTestId('project-timeseries-chart')).toBeVisible();

    // Room for several turns of the interval: the assertion is that the dashboard re-reads at all,
    // not how promptly a loaded CI machine gets round to the timer.
    const waits = { timeout: 20_000 };
    const metrics_before = OVERVIEW_PATHS.map((path) => countCalls(calls, path));
    for (const [index, path] of OVERVIEW_PATHS.entries()) {
      await expect
        .poll(() => countCalls(calls, path), { message: `re-read ${path}`, ...waits })
        .toBeGreaterThan(metrics_before[index]!);
    }

    // Only a section on screen re-reads, so the listing has to be opened before it counts — and the
    // timeseries just asserted on stops being asked the moment this leaves the Overview view.
    await openQueryView(page);
    await expect.poll(() => listingReads()).toBeGreaterThan(0);
    const listed = listingReads();
    await expect.poll(() => listingReads(), waits).toBeGreaterThan(listed);
  });

  test('a re-read in flight leaves paging alone', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const listing = await holdNextListingRead(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    const next = page.getByTestId('project-queries-next');
    await expect(next).toBeEnabled();

    listing.arm();
    await listing.in_flight;

    // Asserted while the read is held open, so this is the screen mid-poll rather than after it.
    // The tick is the dashboard's own work, so it never disables the control that pages the listing.
    await expect(next).toBeEnabled();

    listing.release();
  });

  test('a re-read keeps the listing on its page and filter, and asks the metrics for neither', async ({
    page,
  }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    await page.getByTestId('project-queries-next').click();
    await expect.poll(() => lastAsk(asked, 'offset')).toBe('5');
    await page.getByTestId('project-queries-status-filter').click();
    await page.getByRole('option', { name: 'Failed', exact: true }).click();
    await expect.poll(() => lastAsk(asked, 'status')).toBe('failed');

    // The dashboard re-reads on its own interval; room for several turns of it on a loaded machine.
    const kpis_before = countCalls(calls, KPIS_PATH);
    await expect
      .poll(() => countCalls(calls, KPIS_PATH), { timeout: 20_000 })
      .toBeGreaterThan(kpis_before);

    // The status filter narrows the listing only. The metrics endpoints take a range and nothing
    // else, so a table filter must never reach them.
    expect(lastAsk(asked, 'status')).toBe('failed');
    for (const call of calls.filter((item) => item.startsWith(KPIS_PATH))) {
      expect(call).not.toContain('status');
    }
  });
});

const DRAWER = 'project-block-drawer';
const WRITER_CARD = 'project-agent-share-row-writer';

const isAgentCall = (call: string) => call.startsWith(AGENTS_PATH);
const isBlocksCall = (call: string) => call.startsWith(BLOCKS_PATH);

// React runs the dashboard under StrictMode, so a query can legitimately be fetched more than once.
// What the drawer asked for is the behaviour under test, not how many times it asked.
const unique = (calls: readonly string[]) => [...new Set(calls)];

async function openAgentView(page: Page): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}`);
  await page.getByRole('tab', { name: 'Per-Agent view' }).click();
  await expect(page.getByTestId('project-agent-share')).toBeVisible();
}

// The section heading is what names the metric the histogram is showing. Matched
// case-insensitively, since the label is uppercased in CSS.
function drawerHeading(page: Page, name: string) {
  return page.getByTestId(DRAWER).getByRole('heading', { level: 3, name });
}

// The shares of queries the curve climbs through — the x axis, since the CDF switched the axes.
function shareTicks(chart: Locator): Promise<string[]> {
  return chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value').allTextContents();
}

// The metric the curve is denominated in, which the axis switch moved to the y axis.
function valueTicks(chart: Locator): Promise<string[]> {
  return chart.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value').allTextContents();
}

// The overview tiles carry no testid of their own, so a figure is read as the tile whose label says
// which figure it is.
function overviewStat(page: Page, label: string) {
  return page
    .getByTestId(`${DRAWER}-overview`)
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(label, { exact: true }) });
}

test.describe('block metrics drawer', () => {
  test('@smoke picking an agent slice opens its 30-day metrics', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    await expect(page.getByTestId(DRAWER)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Report Writer' })).toBeVisible();
    await expect(page.getByTestId(`${DRAWER}-kind`)).toHaveText('Model · claude-opus-5');
    await expect(page.getByTestId(DRAWER)).toContainText('Overview · 30 days');

    for (const [label, value, hint] of [
      ['Cost', '$68.71', '128 blocks'],
      ['Share of spend', '80.9%', 'of $84.95'],
      ['Tokens', '27.4M', '214K / block'],
      // 68.706719 / 95 * 1000.
      ['Per 1K project queries', '$723.23', 'over 95 queries'],
      ['p95 latency', '1.5 min', 'per block'],
      ['Retry rate', '17.9%', '3.6% failed'],
      ['Cache hit', '42%', null],
      ['Recoverable', '$16.14', '23.5% of this block'],
    ] as const) {
      const stat = overviewStat(page, label);
      await expect(stat).toContainText(value);
      if (hint) await expect(stat).toContainText(hint);
    }

    await expect(page.getByTestId(DRAWER)).toContainText(
      "Ran in 88 of the project's 95 queries (92.6%)"
    );
  });

  test('the drawer stays on 30 days whatever window the dashboard shows', async ({ page }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    await openAgentView(page);

    await page
      .getByTestId('project-window-toggle')
      .getByRole('radio', { name: '24 hours' })
      .click();
    await expect
      .poll(() => {
        const call = calls.filter(isBlocksCall).at(-1);
        return call ? requestedFixtureRange(new URL(call, 'http://localhost')) : null;
      })
      .toBe('1d');

    await page.getByTestId(WRITER_CARD).click();
    await expect(page.getByTestId(`${DRAWER}-overview`)).toBeVisible();

    // Per-Agent follows the selected day while the drawer reads its fixed 30-day comparison.
    expect(
      unique(calls.filter(isAgentCall)).map((call) => new URL(call, 'http://localhost').pathname)
    ).toEqual([`${AGENTS_PATH}writer`]);
    expect(
      unique(
        calls
          .filter(isBlocksCall)
          .map((call) => requestedFixtureRange(new URL(call, 'http://localhost')))
      )
    ).toEqual(['7d', '1d', '30d']);
  });

  test('the cost-per-query curve climbs through cost against the share of queries', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    const chart = page.getByTestId(`${DRAWER}-histogram`);
    await expect(chart).toBeVisible();
    // One stepped curve over the whole distribution — not a rectangle per bucket.
    await expect(chart.locator('.recharts-area-curve')).toHaveCount(1);
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(0);

    // Axes switched from the histogram this replaced: share of queries on x, cost on y.
    const shares = await shareTicks(chart);
    expect(shares).toContain('50%');
    expect(shares.every((tick) => tick.endsWith('%'))).toBe(true);
    const values = await valueTicks(chart);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((tick) => tick.startsWith('$'))).toBe(true);

    // Percentiles sit on the curve at their own share of queries.
    await expect(chart).toContainText('p50 $0.77');
    await expect(chart).toContainText('p95 $1.74');
    await expect(page.getByTestId(DRAWER)).toContainText('95% cost ≤ $1.74');
    await expect(page.getByTestId(DRAWER)).toContainText('88 queries');
  });

  test('the curve switches metric on the payload it already has', async ({ page }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    const drawer = page.getByTestId(DRAWER);
    const chart = page.getByTestId(`${DRAWER}-histogram`);
    const toggle = page.getByTestId(`${DRAWER}-metric`);
    await expect(toggle).toHaveAttribute('aria-label', 'Per-query distribution metric');
    // The section opens on cost, the question the dashboard behind it asks.
    await expect(toggle.getByRole('radio', { name: 'Cost' })).toHaveAttribute('data-state', 'on');
    await expect(drawerHeading(page, 'cost per query inside this block')).toBeVisible();

    const before = calls.filter(isAgentCall).length;

    await toggle.getByRole('radio', { name: 'Tokens' }).click();

    await expect(drawerHeading(page, 'tokens per query inside this block')).toBeVisible();
    // The y axis, percentiles and the mean are all denominated in the metric on show.
    await expect.poll(() => valueTicks(chart)).toContain('200K');
    await expect(chart).toContainText('p50 300K');
    await expect(chart).toContainText('p95 470K');
    await expect(drawer).toContainText('Mean 311.3K per query');
    await expect(drawer).toContainText('95% use ≤ 470K');

    await toggle.getByRole('radio', { name: 'Latency' }).click();

    await expect(drawerHeading(page, 'latency per query inside this block')).toBeVisible();
    await expect(chart).toContainText('p50 58.0 s');
    await expect(chart).toContainText('p95 1.3 min');
    await expect(drawer).toContainText('Mean 1.0 min per query');
    // Latency bins the queries that finished, which is fewer than the 88 cost bins.
    await expect(drawer).toContainText('85 queries');
    await expect(drawer).toContainText('95% finish in ≤ 1.3 min');

    // All three arrived in the one payload the drawer already read.
    expect(calls.filter(isAgentCall).length).toBe(before);
  });

  test('the metric toggle switches on the keyboard', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    const toggle = page.getByTestId(`${DRAWER}-metric`);
    const tokens = toggle.getByRole('radio', { name: 'Tokens' });
    await toggle.getByRole('radio', { name: 'Cost' }).focus();

    // Roving focus: the arrow moves the focus, and it takes an activation to change the chart.
    await page.keyboard.press('ArrowRight');
    await expect(tokens).toBeFocused();
    await expect(drawerHeading(page, 'cost per query inside this block')).toBeVisible();

    await page.keyboard.press('Enter');

    await expect(tokens).toHaveAttribute('data-state', 'on');
    await expect(drawerHeading(page, 'tokens per query inside this block')).toBeVisible();
  });

  test('a metric with nothing to bin keeps the switcher, so the reader can leave it', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      agents: {
        ...AGENT_DETAILS,
        // A block whose queries are all still running: it has cost and tokens, and nothing timed.
        writer: { ...AGENT_DETAILS.writer!, latency: NOTHING_COMPLETED },
      },
    });
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();
    const toggle = page.getByTestId(`${DRAWER}-metric`);

    await toggle.getByRole('radio', { name: 'Latency' }).click();

    const chart = page.getByTestId(`${DRAWER}-histogram`);
    await expect(chart).toHaveText(
      'No queries finished in this block yet, so there is nothing to time.'
    );
    await expect(chart.locator('.recharts-area-curve')).toHaveCount(0);
    await expect(toggle).toBeVisible();

    await toggle.getByRole('radio', { name: 'Cost' }).click();
    await expect(chart.locator('.recharts-area-curve')).toHaveCount(1);
  });

  test('an agent slice opens on Enter, closes on Escape, and restores focus', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await openAgentView(page);

    const card = page.getByTestId(WRITER_CARD);
    await card.focus();
    await expect(card).toBeFocused();

    await card.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Report Writer' })).toBeVisible();
    // Not on a control inside it: the Enter that opened the drawer would activate that.
    await expect(page.getByTestId(DRAWER)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId(DRAWER)).toHaveCount(0);
    await expect(card).toBeFocused();

    // The same slice remains openable after focus returns.
    await card.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Report Writer' })).toBeVisible();
  });

  test('a block the runtime never ran reads as empty, not as a failure', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { agents: {} });
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    await expect(page.getByTestId(`${DRAWER}-empty`)).toBeVisible();
    await expect(page.getByTestId(`${DRAWER}-error`)).toHaveCount(0);
    // With no payload to name the block, the header falls back to the id it was opened by.
    await expect(page.getByRole('dialog', { name: 'writer' })).toBeVisible();
  });

  test('a failing block endpoint shows an error with a working retry', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);

    // Flipped by the test rather than counted per request: StrictMode may mount the drawer twice,
    // and the retry has to be the thing that recovers it, not the second mount.
    let failing = true;
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.startsWith(AGENTS_PATH),
      (route) => (failing ? failJson(route) : fulfillJson(route, AGENT_DETAILS.writer!))
    );
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();
    const error = page.getByTestId(`${DRAWER}-error`);
    await expect(error).toBeVisible();
    await expect(page.getByTestId(`${DRAWER}-empty`)).toHaveCount(0);

    failing = false;
    await error.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByTestId(`${DRAWER}-overview`)).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test('the drawer stays inside a phone-width viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page);
    await mockProjectCost(page);
    await openAgentView(page);

    await page.getByTestId(WRITER_CARD).click();

    const panel = page.getByTestId(DRAWER);
    await expect(panel).toBeVisible();
    // Polled rather than measured once: the sheet slides in from the right edge, so the first
    // frames legitimately sit outside the viewport it is settling into.
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        return Math.round(box.x + box.width);
      })
      .toBeLessThanOrEqual(390);

    const panel_box = (await panel.boundingBox())!;
    expect(panel_box.x).toBeGreaterThanOrEqual(0);

    await expect(overviewStat(page, 'Cost')).toContainText('$68.71');
  });
});

const TRACE_DRAWER = 'project-query-drawer';
const PROSE_OUTPUT = 'The invoice totals $1,240.\n\nTwo line items need a second look.';
const SESSION_ID = REQUEST_TRACE.session_id;
const TRACE_PATH = `/projects/${PROJECT_ID}/requests/${SESSION_ID}`;
// The row is the cell block; the button inside it is what opens the drawer and what focus returns
// to, so the two are addressed separately.
const QUERY_ROW = `project-query-${SESSION_ID}`;
const QUERY_OPEN = `project-query-open-${SESSION_ID}`;

function ribbonCell(page: Page, name: 'cost' | 'tokens' | 'harness') {
  return page.getByTestId(`${TRACE_DRAWER}-ribbon-${name}`);
}

// The trace tiles carry no testid of their own, so a figure is read as the tile whose label says
// which figure it is.
function traceStat(page: Page, label: string) {
  return page
    .getByTestId(`${TRACE_DRAWER}-overview`)
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function openTrace(page: Page): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}`);
  await openQueryView(page);
  await page.getByTestId(QUERY_OPEN).click();
  await expect(page.getByTestId(TRACE_DRAWER)).toBeVisible();
}

test.describe('query trace drawer', () => {
  test('@smoke clicking a query row opens its trace drawer', async ({ page }) => {
    await authenticate(page);
    const calls = await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    // Anywhere on the row, not only on the id: the button stretches an overlay across it.
    await page.getByTestId(QUERY_ROW).click();

    await expect(page.getByTestId(TRACE_DRAWER)).toBeVisible();
    await expect(page.getByRole('dialog', { name: '6215f346…0001' })).toBeVisible();
    const overview = page.getByTestId(`${TRACE_DRAWER}-overview`);
    await expect(overview).toContainText('$2.046');
    await expect(overview).toContainText('170×');
    // The multiple names the figure it is a multiple of.
    await expect(overview).toContainText('median $0.012');
    await expect(overview).toContainText('385.1K');
    await expect(overview).toContainText('33.0 s');
    await expect(traceStat(page, 'Retries')).toContainText('4');
    // Payloads open on demand, so the cost breakdown is not buried behind them.
    await expect(page.getByTestId(`${TRACE_DRAWER}-input`).getByRole('textbox')).toHaveCount(0);
    await page.getByTestId(`${TRACE_DRAWER}-input-toggle`).click();
    // The input pane shows the prompt alone in a read-only field — not the envelope carrying it.
    const input_field = page.getByTestId(`${TRACE_DRAWER}-input`).getByRole('textbox');
    await expect(input_field).toHaveValue('Review the attached invoice');
    await expect(input_field).not.toBeEditable();
    await page.getByTestId(`${TRACE_DRAWER}-output-toggle`).click();
    await expect(page.getByTestId(`${TRACE_DRAWER}-output`)).toContainText('Invoice reviewed');
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toBeVisible();
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toContainText('99.80¢');
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toContainText('Cost (¢)');
    // Every block carries the slot; only the block that made an LLM call shows a version in it.
    await expect(
      page.getByTestId('trace-block-prompt-version').filter({ visible: true })
    ).toHaveText('Classifier-classify-0a1b2c3d-v3');
    await expect(page.getByTestId(TRACE_DRAWER)).toContainText('review-escalation ×5');
    // The medians compare against the range the listing answered for, so the trace asks for it.
    const rangeOf = (call: string) => {
      const params = new URL(call, 'http://localhost').searchParams;
      return `${params.get('from')}/${params.get('to')}`;
    };
    const trace_path = `/projects/${PROJECT_ID}/requests/${SESSION_ID}?`;
    await expect.poll(() => calls.some((call) => call.startsWith(trace_path))).toBe(true);
    const listed = calls
      .filter((call) => call.startsWith(`/projects/${PROJECT_ID}/requests?`))
      .map(rangeOf);
    expect(listed).toContain(rangeOf(calls.find((call) => call.startsWith(trace_path))!));

    await page.keyboard.press('Escape');
    await expect(page.getByTestId(TRACE_DRAWER)).toHaveCount(0);

    const open = page.getByTestId(QUERY_OPEN);
    await open.focus();
    await open.press('Enter');
    await expect(page.getByTestId(TRACE_DRAWER)).toBeVisible();
  });

  test('the drawer opens on the panel and gives the row back on Escape', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    const open = page.getByTestId(QUERY_OPEN);
    await open.focus();
    await open.press('Enter');

    await expect(page.getByTestId(TRACE_DRAWER)).toBeVisible();
    // Not on a control inside it: the Enter that opened the drawer would activate that.
    await expect(page.getByTestId(TRACE_DRAWER)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId(TRACE_DRAWER)).toHaveCount(0);
    // Re-queried at close rather than captured at open, so a refetched listing cannot drop focus
    // onto the document body.
    await expect(open).toBeFocused();
  });

  test('a failing trace shows an error with a working retry', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { traceFails: true });
    await openTrace(page);

    const error = page.getByTestId(`${TRACE_DRAWER}-error`);
    await expect(error).toBeVisible();
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toHaveCount(0);
    await expect(page.getByTestId(`${TRACE_DRAWER}-overview`)).toHaveCount(0);

    // Registered after the failing mock, so it answers from here on and the retry is what recovers
    // the drawer rather than a second StrictMode mount.
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === TRACE_PATH,
      (route) => fulfillJson(route, REQUEST_TRACE)
    );
    await error.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByTestId(`${TRACE_DRAWER}-overview`)).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test('a trace the API no longer holds reads as an error, not a blank panel', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { trace: null });
    await openTrace(page);

    // Unlike a block that never ran, a listed query whose trace is gone is a real failure: the row
    // that opened this drawer came from the same API.
    await expect(page.getByTestId(`${TRACE_DRAWER}-error`)).toBeVisible();
    await expect(page.getByTestId(`${TRACE_DRAWER}-error`)).toContainText(
      "Could not load this query's trace."
    );
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toHaveCount(0);
    // The panel still names the query it was opened for.
    await expect(page.getByRole('dialog', { name: '6215f346…0001' })).toBeVisible();
  });

  test('a query that reported no blocks says so instead of drawing an empty timeline', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page, { trace: { ...REQUEST_TRACE, blocks: [] } });
    await openTrace(page);

    await expect(page.getByTestId(`${TRACE_DRAWER}-empty`)).toBeVisible();
    await expect(page.getByTestId(`${TRACE_DRAWER}-timeline`)).toHaveCount(0);
    // The query's own totals are known even when its blocks are not.
    await expect(ribbonCell(page, 'cost')).toContainText('$2.046');
  });

  test('a prose answer reads as prose, and a blank payload as missing', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      trace: { ...REQUEST_TRACE, input: '   ', output: PROSE_OUTPUT },
    });
    await openTrace(page);

    await page.getByTestId(`${TRACE_DRAWER}-input-toggle`).click();
    await expect(page.getByTestId(`${TRACE_DRAWER}-input`).getByRole('textbox')).toHaveValue('—');

    await page.getByTestId(`${TRACE_DRAWER}-output-toggle`).click();
    const output = page.getByTestId(`${TRACE_DRAWER}-output`).locator('pre');
    await expect(output).toBeVisible();
    await expect.poll(async () => output.textContent()).toBe(PROSE_OUTPUT);
  });

  test('a running query lays out its timeline without a duration to scale by', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, { requests: RUNNING_REQUESTS, trace: RUNNING_TRACE });
    await openTrace(page);

    await expect(traceStat(page, 'Latency')).toContainText('—');
    const timeline = page.getByTestId(`${TRACE_DRAWER}-timeline`);
    await expect(timeline).toBeVisible();
    await expect(timeline).toContainText('ingest');
    // The block still running has no execution time of its own to print.
    await expect(timeline).toContainText('retrieve');
    await expect(ribbonCell(page, 'cost')).toContainText('$2.046');
  });

  test('the ribbon reads cost, tokens and harness spend against the project median', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await openTrace(page);

    await expect(ribbonCell(page, 'cost')).toContainText('$2.046');
    await expect(ribbonCell(page, 'cost')).toContainText('median $0.012');
    await expect(ribbonCell(page, 'tokens')).toContainText('385.1K');
    // 385,100 against a 192,550 median.
    await expect(ribbonCell(page, 'tokens')).toContainText('2.0×');
    await expect(ribbonCell(page, 'harness')).toContainText('$0.046');
    await expect(ribbonCell(page, 'harness')).toContainText('median $0.002');
  });

  test('a query just above the median reads as a fraction, not a rounded 1×', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      trace: {
        ...REQUEST_TRACE,
        total_cost: '1.4000000000',
        median_cost: '1.0000000000',
        cost_vs_median: 1.4,
      },
    });
    await openTrace(page);

    await expect(ribbonCell(page, 'cost')).toContainText('1.4×');
    await expect(ribbonCell(page, 'cost')).toContainText('median $1.000');
  });

  test('a measure with no project median has no multiple to show', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page, {
      trace: {
        ...REQUEST_TRACE,
        median_cost: null,
        median_token_count: null,
        median_harness_cost: null,
        cost_vs_median: null,
        token_count_vs_median: null,
        harness_cost_vs_median: null,
      },
    });
    await openTrace(page);

    for (const name of ['cost', 'tokens', 'harness'] as const) {
      await expect(ribbonCell(page, name)).toContainText('No median in the last 30 days');
    }
    // The figures themselves are still readable without a comparison.
    await expect(ribbonCell(page, 'cost')).toContainText('$2.046');
    await expect(ribbonCell(page, 'tokens')).toContainText('385.1K');
  });
});

test.describe('queries day filter', () => {
  const QUERIES_HEADING = { level: 2 } as const;
  // Answers a filtered ask with a smaller total than the unfiltered one, as the API does, so the
  // heading and the count line have something to move to.
  const DAY_TOTAL = 12;

  function queriesHeading(page: Page) {
    return page.getByTestId('project-queries').getByRole('heading', QUERIES_HEADING);
  }

  const lastAsk = (asked: URLSearchParams[], key: string): string | null =>
    asked.at(-1)?.get(key) ?? null;

  /** Records every listing ask and answers a full page, emptied for a day when asked to. */
  async function trackListing(page: Page, empty_day = false): Promise<URLSearchParams[]> {
    const asked: URLSearchParams[] = [];
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === `/projects/${PROJECT_ID}/requests`,
      (route) => {
        const params = new URL(route.request().url()).searchParams;
        asked.push(params);
        const from = params.get('from')!;
        const to = params.get('to')!;
        const filtered = params.has('created_from');
        if (filtered && empty_day) {
          return fulfillJson(route, { from, to, total: 0, items: [] });
        }
        // Paged like the endpoint is, so the last page of a filtered day is short and the count
        // line under the table has a real range to print.
        const total = filtered ? DAY_TOTAL : 95;
        const offset = Number(params.get('offset') ?? 0);
        const shown = Math.max(0, Math.min(Number(params.get('limit') ?? 5), total - offset));
        return fulfillJson(route, {
          from,
          to,
          total,
          items: Array.from({ length: shown }, (_item, index) => ({
            ...REQUESTS.items[0]!,
            session_id: `6215f346-e000-4000-8000-0000000000${String(offset + index).padStart(2, '0')}`,
          })),
        });
      }
    );
    return asked;
  }

  /**
   * A day as the picker itself sees it, resolved in the page: the grid is keyed by local ISO day,
   * the trigger prints a local label, and the bounds are local midnights sent as UTC instants —
   * all of which depend on the browser's own clock and timezone rather than the runner's.
   */
  function browserDay(page: Page, days_back: number) {
    return page.evaluate((back) => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - back);
      const next = new Date(day);
      next.setDate(day.getDate() + 1);
      const pad = (value: number) => String(value).padStart(2, '0');
      return {
        key: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
        label: new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).format(day),
        created_from: day.toISOString(),
        created_to: next.toISOString(),
      };
    }, days_back);
  }

  /**
   * Sorts every rendered day by whether the trailing window reaches it, so the assertion holds on
   * any date rather than on days that happen to fall inside the month on show.
   */
  function auditRenderedDays(page: Page, window_days: number) {
    return page.evaluate((days) => {
      const pad = (value: number) => String(value).padStart(2, '0');
      const key = (date: Date) =>
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const in_window = new Set<string>();
      for (let back = 0; back <= days; back += 1) {
        const day = new Date(today);
        day.setDate(today.getDate() - back);
        in_window.add(key(day));
      }

      const cells = [...document.querySelectorAll('[role="gridcell"][data-day]')];
      const dayKey = (cell: Element) => cell.getAttribute('data-day') ?? '';
      const outside = cells.filter((cell) => !in_window.has(dayKey(cell)));
      return {
        enabled_outside: outside.filter((cell) => !cell.hasAttribute('data-disabled')).map(dayKey),
        disabled_inside: cells
          .filter((cell) => in_window.has(dayKey(cell)) && cell.hasAttribute('data-disabled'))
          .map(dayKey),
        outside_rendered: outside.length,
      };
    }, window_days);
  }

  const dayCell = (page: Page, key: string) => page.locator(`[role="gridcell"][data-day="${key}"]`);

  test('@smoke the picker opens on the keyboard and offers only the window it is scoped to', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);

    const trigger = page.getByTestId('project-queries-calendar');
    // Unfiltered, the trigger names the window the listing already spans rather than "any day".
    await expect(trigger).toHaveAccessibleName('Filter queries by day, showing 7 days');
    await expect(trigger).toHaveText('7 days');
    // Nothing to reset until a day is picked.
    await expect(page.getByTestId('project-queries-calendar-reset')).toHaveCount(0);

    await trigger.focus();
    await page.keyboard.press('Enter');
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();

    // The screen opens on 7d, so the window reaches back through the day holding its start.
    const audit = await auditRenderedDays(page, 7);
    expect(audit.enabled_outside).toEqual([]);
    expect(audit.disabled_inside).toEqual([]);
    // A month grid always shows days a week-long window cannot reach, so the two lists above are
    // empty because the picker disabled them, not because there was nothing to disable.
    expect(audit.outside_rendered).toBeGreaterThan(0);

    const today = await browserDay(page, 0);
    await expect(dayCell(page, today.key)).toHaveAttribute('data-today', 'true');

    await page.keyboard.press('Escape');
    await expect(grid).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('picking a day bounds the listing to it and pages inside it', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);
    await expect(page.getByTestId('project-queries-table')).toBeVisible();

    const today = await browserDay(page, 0);
    await page.getByTestId('project-queries-calendar').click();
    await dayCell(page, today.key).getByRole('button').click();

    // Half-open local midnights, sent as instants beside the range they narrow.
    await expect.poll(() => lastAsk(asked, 'created_from')).toBe(today.created_from);
    expect(lastAsk(asked, 'created_to')).toBe(today.created_to);
    expect(requestedFixtureRange(new URL(`?${asked.at(-1)}`, 'http://localhost'))).toBe('7d');
    expect(lastAsk(asked, 'offset')).toBe('0');

    await expect(queriesHeading(page)).toHaveText(`Queries · 7 days · ${today.label}`);
    await expect(page.getByTestId('project-queries-count')).toHaveText(
      `1–5 of ${DAY_TOTAL} queries on ${today.label}`
    );
    await expect(page.getByTestId('project-queries-calendar')).toHaveAccessibleName(
      `Filter queries by day: ${today.label}`
    );

    // Paging stays inside the day rather than falling back to the whole project.
    await page.getByTestId('project-queries-next').click();
    await expect.poll(() => lastAsk(asked, 'offset')).toBe('5');
    expect(lastAsk(asked, 'created_from')).toBe(today.created_from);
    expect(lastAsk(asked, 'created_to')).toBe(today.created_to);
    await expect(page.getByTestId('project-queries-count')).toHaveText(
      `6–10 of ${DAY_TOTAL} queries on ${today.label}`
    );

    // The last page of the day is short, and a short page must not shrink the section either.
    const section = page.getByTestId('project-queries');
    const full_height = (await section.boundingBox())!.height;
    await page.getByTestId('project-queries-next').click();
    await expect(page.getByTestId('project-queries-count')).toHaveText(
      `11–12 of ${DAY_TOTAL} queries on ${today.label}`
    );
    expect((await section.boundingBox())!.height).toBe(full_height);

    await page.getByTestId('project-queries-calendar-reset').click();
    await expect.poll(() => lastAsk(asked, 'created_from')).toBeNull();
    expect(lastAsk(asked, 'created_to')).toBeNull();
    // A reset is not a refresh: the page it left off on described a day that is no longer filtered.
    expect(lastAsk(asked, 'offset')).toBe('0');
    await expect(queriesHeading(page)).toHaveText('Queries · 7 days');
    await expect(page.getByTestId('project-queries-count')).toHaveText('1–5 of 95 queries');
  });

  test('a day the project served nothing on says so, rather than reading as a dead project', async ({
    page,
  }) => {
    await authenticate(page);
    await mockProjectCost(page);
    await trackListing(page, true);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);
    await expect(page.getByTestId('project-queries-table')).toBeVisible();

    // Picking a day adds a line of description to the heading, so the listing is what is measured
    // here rather than the whole section.
    const body = page.getByTestId('project-queries-body');
    const full_height = (await body.boundingBox())!.height;

    const yesterday = await browserDay(page, 1);
    await page.getByTestId('project-queries-calendar').click();
    await dayCell(page, yesterday.key).getByRole('button').click();

    const empty = page.getByTestId('project-queries-empty');
    await expect(empty).toHaveText(`No queries on ${yesterday.label}.`);
    // Losing every row leaves the listing exactly as tall as a full page of them.
    expect((await body.boundingBox())!.height).toBe(full_height);

    await page.getByTestId('project-queries-calendar-reset').click();
    await expect(page.getByTestId('project-queries-table')).toBeVisible();
    await expect(empty).toHaveCount(0);
  });

  test('changing the metrics range clears the picked day', async ({ page }) => {
    await authenticate(page);
    await mockProjectCost(page);
    const asked = await trackListing(page);
    await page.goto(`/projects/${PROJECT_ID}`);
    await openQueryView(page);
    await expect(page.getByTestId('project-queries-table')).toBeVisible();

    const today = await browserDay(page, 0);
    await page.getByTestId('project-queries-calendar').click();
    await dayCell(page, today.key).getByRole('button').click();
    await expect.poll(() => lastAsk(asked, 'created_from')).toBe(today.created_from);

    await page
      .getByTestId('project-window-toggle')
      .getByRole('radio', { name: '24 hours' })
      .click();

    // A day picked under a wider window may sit outside the new one, so the filter goes with it.
    await expect
      .poll(() => requestedFixtureRange(new URL(`?${asked.at(-1)}`, 'http://localhost')))
      .toBe('1d');
    await expect(queriesHeading(page)).toHaveText('Queries · 24 hours');
    // Back to naming the window, which is now the narrower one that cleared the day.
    await expect(page.getByTestId('project-queries-calendar')).toHaveText('24 hours');
    await expect(page.getByTestId('project-queries-calendar-reset')).toHaveCount(0);

    // The narrower window now offers only the two calendar days a trailing 24 hours touches.
    await page.getByTestId('project-queries-calendar').click();
    const audit = await auditRenderedDays(page, 1);
    expect(audit.enabled_outside).toEqual([]);
    expect(audit.disabled_inside).toEqual([]);
    expect(audit.outside_rendered).toBeGreaterThan(0);
  });
});
