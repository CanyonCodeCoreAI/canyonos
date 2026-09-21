import { edenTreaty } from '@elysiajs/eden';

import type { ForgeApi } from '@canyonos/api/client';
import type {
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsFlow,
  MetricsKpis,
  MetricsTimeseries,
} from '@canyonos/api/metrics';
import type { ListRequestsQuery, RequestList, RequestTrace } from '@canyonos/api/requests';

const _client = edenTreaty<ForgeApi>('http://localhost:3000');

// Forces actual type resolution so tree-shaking can't hide a broken bridge.
// If `ForgeApi` doesn't resolve, web typecheck fails here loudly and locally.
export type _HealthzReturn = Awaited<ReturnType<typeof _client.healthz.get>>;

function _project_contract(project_id: string, workflow_id: string) {
  const project = _client.projects[project_id]!;
  void project.status.get();
  void project.stats.get();
  void project.workflows.get();
  void project.workflows[workflow_id]!.get();
  void project.workflows[workflow_id]!.design.get();
  void project.deploy.config.get();
  void project.deploy.post({});
  void project.requests.get({ $query: { limit: 20, offset: 0 } });
  void project.requests.get({
    $query: {
      limit: 20,
      offset: 0,
      metric: 'cost_per_request',
      min: 0.9,
      max: 2.4,
      time_window: '30d',
    },
  });
  void project.requests['session-1']!.get();
  void project.metrics.kpis.get();
  void project.metrics.distribution.get({
    $query: { metric: 'latency', time_window: '30d', buckets: 20 },
  });
  void project.metrics.timeseries.get({ $query: { time_window: '30d', buckets: 30 } });
  void project.metrics.blocks.get({ $query: { time_window: '30d' } });
  void project.metrics.agents['agent-1']!.get({ $query: { time_zone: 'UTC' } });
  void project.metrics.flow.get({ $query: { time_window: '30d' } });
}

void _project_contract;

// The cost dashboard renders straight off these, so the subpath has to keep exporting them.
function _metrics_contract(
  series: MetricsTimeseries,
  blocks: MetricsBlocks,
  flow: MetricsFlow,
  agent: MetricsAgentDetails,
  kpis: MetricsKpis
) {
  const point = series.points[0];
  void `${series.bucket_seconds} ${point?.start_at} ${point?.total_cost}`;
  const block = blocks.blocks[0];
  void `${blocks.total_cost} ${block?.agent_id} ${block?.kind} ${block?.recoverable_cost} ${block?.retry_rate}`;
  const node = flow.nodes[0];
  const edge = flow.edges[0];
  void `${flow.total_cost} ${node?.id} ${node?.agent_id} ${node?.kind} ${node?.label} ${node?.depth} ${node?.cost}`;
  void `${edge?.id} ${edge?.source} ${edge?.target} ${edge?.call_count} ${edge?.cost}`;
  // The block drawer reads the agent's own window, the project denominators it divides by, and the
  // cost-per-request histogram it plots.
  void `${agent.label} ${agent.time_window} ${agent.project.request_count} ${agent.project.total_cost}`;
  void `${agent.agent.cost} ${agent.agent.request_count} ${agent.agent.cache_hit_ratio}`;
  void `${agent.cost_per_request.p95} ${agent.cost_per_request.buckets[0]?.lower}`;
  // The coverage badge divides the costed counts by the window's own, and the cost-per-query cells
  // read the average over the costed queries alone.
  const window = kpis.windows['30d'];
  void `${window.costed_block_count} ${window.block_count}`;
  void `${window.costed_request_count} ${window.request_count}`;
  void `${window.per_costed_request_cost} ${window.per_block_cost}`;
}

void _metrics_contract;

// Selecting a histogram bucket filters the query table, so the subpath has to keep exporting the
// metric-range selection alongside the page it returns.
function _requests_contract(query: ListRequestsQuery, page: RequestList) {
  void `${query.metric} ${query.min} ${query.max} ${query.time_window} ${query.limit}`;
  const request = page.items[0];
  void `${page.total} ${request?.session_id} ${request?.status} ${request?.total_cost}`;
}

void _requests_contract;

// The query trace drawer renders straight off these: the median it compares the query against —
// null when the project billed nothing in the trailing window — and one timeline row per block.
function _trace_contract(trace: RequestTrace) {
  const block = trace.blocks[0];
  void `${trace.status} ${trace.duration_ms} ${trace.total_cost} ${trace.median_cost}`;
  void `${block?.label} ${block?.kind} ${block?.started_offset_ms} ${block?.execution_time_ms}`;
  void `${block?.total_cost} ${block?.failed}`;
}

void _trace_contract;
