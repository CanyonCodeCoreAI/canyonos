// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { edenTreaty } from '@elysiajs/eden';

import type { ForgeApi } from '@canyonos/api/client';
import type {
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsKpis,
  MetricsTimeseries,
} from '@canyonos/api/metrics';
import type { ListRequestsQuery, RequestList, RequestTrace } from '@canyonos/api/requests';

const _client = edenTreaty<ForgeApi>('http://localhost:3000');

// Forces actual type resolution so tree-shaking can't hide a broken bridge.
// If `ForgeApi` doesn't resolve, web typecheck fails here loudly and locally.
export type _HealthzReturn = Awaited<ReturnType<typeof _client.healthz.get>>;

function _project_contract(project_id: string) {
  const project = _client.projects[project_id]!;
  const range = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
  void project.get();
  void project.stats.get();
  void project.requests.get({ $query: { ...range, limit: 20, offset: 0 } });
  void project.requests.get({
    $query: {
      limit: 20,
      offset: 0,
      metric: 'cost_per_request',
      min: 0.9,
      max: 2.4,
      ...range,
    },
  });
  void project.requests['session-1']!.get({ $query: range });
  void project.metrics.kpis.get({ $query: range });
  void project.metrics.distribution.get({
    $query: { metric: 'latency', ...range, buckets: 20 },
  });
  void project.metrics.timeseries.get({ $query: range });
  void project.metrics.blocks.get({ $query: range });
  void project.metrics.agents['agent-1']!.get({ $query: range });
}

void _project_contract;

// The cost dashboard renders straight off these, so the subpath has to keep exporting them.
function _metrics_contract(
  series: MetricsTimeseries,
  blocks: MetricsBlocks,
  agent: MetricsAgentDetails,
  kpis: MetricsKpis
) {
  const point = series.points[0];
  void `${series.bucket_seconds} ${point?.start_at} ${point?.total_cost}`;
  const block = blocks.blocks[0];
  void `${blocks.total_cost} ${block?.agent_id} ${block?.kind} ${block?.recoverable_cost} ${block?.retry_rate}`;
  // The block drawer reads the agent's own range, the project denominators it divides by, and the
  // cost-per-request histogram it plots.
  void `${agent.label} ${agent.from} ${agent.to} ${agent.project.request_count} ${agent.project.total_cost}`;
  void `${agent.agent.cost} ${agent.agent.request_count} ${agent.agent.cache_hit_ratio}`;
  void `${agent.cost_per_request.p95} ${agent.cost_per_request.buckets[0]?.lower}`;
  // The coverage badge divides the costed counts by the range's own, and the cost-per-query cells
  // read the average over the costed queries alone.
  void `${kpis.costed_block_count} ${kpis.block_count}`;
  void `${kpis.costed_request_count} ${kpis.request_count}`;
  void `${kpis.per_costed_request_cost} ${kpis.per_block_cost}`;
}

void _metrics_contract;

// Selecting a histogram bucket filters the query table, so the subpath has to keep exporting the
// metric-range selection alongside the page it returns.
function _requests_contract(query: ListRequestsQuery, page: RequestList) {
  void `${query.metric} ${query.min} ${query.max} ${query.from} ${query.to} ${query.limit}`;
  const request = page.items[0];
  void `${page.from} ${page.to} ${page.total} ${request?.session_id} ${request?.status} ${request?.total_cost}`;
}

void _requests_contract;

// The query trace drawer renders straight off these: the median it compares the query against —
// null when the project billed nothing in the trailing window — and one timeline row per block.
function _trace_contract(trace: RequestTrace) {
  const block = trace.blocks[0];
  void `${trace.status} ${trace.duration_ms} ${trace.total_cost} ${trace.median_cost}`;
  void `${trace.cost_vs_median} ${trace.harness_cost_vs_median} ${trace.token_count_vs_median}`;
  void `${block?.label} ${block?.kind} ${block?.started_offset_ms} ${block?.execution_time_ms}`;
  void `${block?.total_cost} ${block?.failed}`;
}

void _trace_contract;
