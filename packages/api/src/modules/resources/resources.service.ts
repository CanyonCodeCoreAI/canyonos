import { resources_repo } from './resources.repo';
import type { MetricsWindow } from '../metrics/metrics.types';
import type { FleetProjectRow } from './resources.repo';
import type { FleetKpi, FleetOverview, FleetResource } from './resources.types';

const PALETTE_SIZE = 6;
const TOKENS_PER_MILLION = 1_000_000;

// Compute resources have no data source yet, so they ship untracked; only tokens is real.
const RESOURCE_DEFINITIONS = [
  { id: 'gpu', label: 'GPU', unit: 'hrs', available: false },
  { id: 'cpu', label: 'CPU', unit: 'hrs', available: false },
  { id: 'mem', label: 'Memory', unit: 'GB·hr', available: false },
  { id: 'storage', label: 'Storage', unit: 'GB', available: false },
  { id: 'tokens', label: 'Tokens', unit: 'M', available: true },
] as const;

const WINDOW_LABELS: Record<MetricsWindow, string> = {
  '1d': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '1q': 'last 90 days',
};

function format_money(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function format_compact(value: number): string {
  const scaled = (divisor: number, suffix: string): string =>
    `${Number((value / divisor).toFixed(1))}${suffix}`;
  if (value >= TOKENS_PER_MILLION) return scaled(TOKENS_PER_MILLION, 'M');
  if (value >= 1_000) return scaled(1_000, 'K');
  return String(Math.round(value));
}

function format_latency(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function tokens_in_millions(tokens: number): number {
  return Number((tokens / TOKENS_PER_MILLION).toFixed(1));
}

export function build_overview(
  rows: readonly FleetProjectRow[],
  time_window: MetricsWindow
): FleetOverview {
  const total_requests = rows.reduce((sum, row) => sum + row.request_count, 0);
  const total_cost = rows.reduce((sum, row) => sum + Number(row.total_cost), 0);
  const total_tokens = rows.reduce((sum, row) => sum + row.tokens, 0);

  // Block-count-weighted; projects with no completed blocks (null average) drop out entirely.
  const latency_numerator = rows.reduce(
    (sum, row) => (row.avg_latency_ms === null ? sum : sum + row.avg_latency_ms * row.block_count),
    0
  );
  const latency_weight = rows.reduce(
    (sum, row) => (row.avg_latency_ms === null ? sum : sum + row.block_count),
    0
  );
  const fleet_avg_latency_ms = latency_weight > 0 ? latency_numerator / latency_weight : 0;

  const projects = rows.map((row, index) => ({
    id: row.project_id,
    name: row.name,
    color_index: index % PALETTE_SIZE,
    cost: Number(row.total_cost),
    requests: row.request_count,
    avg_latency_ms: row.avg_latency_ms ?? 0,
    error_rate_pct: row.block_count > 0 ? (row.failed_block_count / row.block_count) * 100 : 0,
    resource_usage: RESOURCE_DEFINITIONS.map((resource) => ({
      resource_id: resource.id,
      usage: resource.id === 'tokens' ? tokens_in_millions(row.tokens) : 0,
    })),
  }));

  const resources: FleetResource[] = RESOURCE_DEFINITIONS.map((resource) => ({
    id: resource.id,
    label: resource.label,
    unit: resource.unit,
    pool: resource.id === 'tokens' ? total_tokens / TOKENS_PER_MILLION : 0,
    available: resource.available,
  }));

  const active_projects = rows.filter((row) => row.request_count > 0).length;
  const window_label = WINDOW_LABELS[time_window];

  const kpis: FleetKpi[] = [
    {
      id: 'total_spend',
      label: 'Total spend',
      value: format_money(total_cost),
      sub_label: window_label,
      tone: 'neutral',
    },
    {
      id: 'active_projects',
      label: 'Active projects',
      value: String(active_projects),
      sub_label: `${projects.length} total`,
      tone: active_projects > 0 ? 'positive' : 'neutral',
    },
    {
      id: 'requests',
      label: 'Requests',
      value: format_compact(total_requests),
      sub_label: window_label,
      tone: 'neutral',
    },
    {
      id: 'tokens',
      label: 'Tokens',
      value: format_compact(total_tokens),
      sub_label: window_label,
      tone: 'neutral',
    },
    {
      id: 'avg_latency',
      label: 'Avg latency',
      value: format_latency(fleet_avg_latency_ms),
      sub_label: 'per block',
      tone: 'neutral',
    },
  ];

  return { kpis, resources, projects, time_window };
}

export async function get_fleet_overview(time_window: MetricsWindow): Promise<FleetOverview> {
  const rows = await resources_repo.fleet_projects(time_window);
  return build_overview(rows, time_window);
}
