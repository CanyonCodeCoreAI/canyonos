// This file exists as a "helper" but the best way of this data, is that API handle all formating, like money alreayd comes on the way to show on the UI, as heat does map, so a future api endpoint that return the cpu response, would return the data as UI needs; check again on the future

import type {
  ResourceHeader,
  ResourceOverview,
  ResourceProject,
  ResourceRequest,
} from '@cc-forge/api/resources';

import type { BarDatum } from '@repo/ui/components/charts/bar-chart';
import type { DonutDatum } from '@repo/ui/components/charts/donut-chart';
import type { ChartConfig } from '@repo/ui/shadcn/chart';

// Severity ramp for ranked views: heaviest consumer reads warm/at-risk, lightest reads healthy
// green. Shared by the allocation donut, idle bars, and top-workflows list so rank stays legible.
const HEAT_HEALTHY = 'var(--heat-6)';
const RANK_HEAT: readonly string[] = [
  'var(--heat-1)',
  'var(--heat-2)',
  'var(--heat-3)',
  'var(--heat-4)',
  'var(--heat-5)',
  HEAT_HEALTHY,
];

function heatAt(index: number): string {
  return RANK_HEAT[Math.min(index, RANK_HEAT.length - 1)] ?? HEAT_HEALTHY;
}

export function formatMoney(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function niceCeil(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface CostChartModel {
  readonly totalLabel: string;
  readonly deltaLabel: string;
  readonly deltaUp: boolean;
  readonly points: readonly { readonly index: number; readonly value: number }[];
  readonly maxValue: number;
}

export function buildCostChart(focus: ResourceHeader): CostChartModel {
  const maxValue = niceCeil(Math.max(...focus.cost_series, 1), 160);
  const deltaUp = focus.spend_delta.direction === 'increase';
  return {
    totalLabel: formatMoney(focus.spend),
    deltaLabel: `${deltaUp ? '↗' : '↘'} ${focus.spend_delta.value}%`,
    deltaUp,
    points: focus.cost_series.map((value, index) => ({ index, value })),
    maxValue,
  };
}

export interface IdleChartModel {
  readonly totalLabel: string;
  readonly bars: readonly BarDatum[];
  readonly config: ChartConfig;
}

export function buildIdleChart(projects: readonly ResourceProject[]): IdleChartModel {
  const ranked = [...projects].sort((a, b) => b.idle_minutes - a.idle_minutes);
  const totalMinutes = ranked.reduce((sum, project) => sum + project.idle_minutes, 0);

  return {
    totalLabel: totalMinutes.toLocaleString(),
    bars: ranked.map((project, index) => ({
      key: project.id,
      label: project.name,
      value: project.idle_minutes,
      color: heatAt(index),
    })),
    config: Object.fromEntries(ranked.map((project) => [project.id, { label: project.name }])),
  };
}

export interface AllocationLegendItem {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly valueLabel: string;
  readonly pctLabel: string;
}

export interface AllocationModel {
  readonly segments: readonly DonutDatum[];
  readonly config: ChartConfig;
  readonly centerValue: string;
  readonly centerLabel: string;
  readonly legend: readonly AllocationLegendItem[];
  readonly note: string;
}

export function buildAllocation(
  focus: ResourceHeader,
  projects: readonly ResourceProject[]
): AllocationModel {
  const ranked = [...projects].sort((a, b) => b.allocation - a.allocation);
  const total = ranked.reduce((sum, project) => sum + project.allocation, 0) || 1;
  const leader = ranked[0];

  return {
    segments: ranked.map((project) => ({ key: project.id, value: project.allocation })),
    config: Object.fromEntries(
      ranked.map((project, index) => [project.id, { label: project.name, color: heatAt(index) }])
    ),
    centerValue: String(total),
    centerLabel: focus.allocation_unit,
    legend: ranked.map((project, index) => ({
      id: project.id,
      name: project.name,
      color: heatAt(index),
      valueLabel: `${project.allocation} ${focus.allocation_unit}`,
      pctLabel: `${Math.round((project.allocation / total) * 100)}%`,
    })),
    note: leader
      ? `${total} ${focus.allocation_unit} allocated across ${ranked.length} ${ranked.length === 1 ? 'project' : 'projects'}. ${leader.name} leads at ${leader.allocation} ${focus.allocation_unit} (${Math.round((leader.allocation / total) * 100)}% of the pool).`
      : '',
  };
}

export interface TopWorkflowItem {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly color: string;
  readonly costLabel: string;
  readonly allocationLabel: string;
  readonly utilizationLabel: string;
  readonly utilizationColor: string;
  readonly barPct: number;
}

function utilizationColor(pct: number): string {
  if (pct >= 70) return 'var(--primary)';
  if (pct >= 45) return 'var(--chart-3)';
  return 'var(--chart-4)';
}

export function buildTopWorkflows(
  focus: ResourceHeader,
  projects: readonly ResourceProject[]
): TopWorkflowItem[] {
  const ranked = [...projects].sort((a, b) => b.usage - a.usage);
  const maxUsage = Math.max(...ranked.map((project) => project.usage), 1);

  return ranked.map((project, index) => ({
    id: project.id,
    rank: index + 1,
    name: project.name,
    color: heatAt(index),
    costLabel: formatMoney(project.cost_share),
    allocationLabel: `${project.allocation} ${focus.allocation_unit}`,
    utilizationLabel: `${project.utilization_pct}% util`,
    utilizationColor: utilizationColor(project.utilization_pct),
    barPct: Math.max(6, Math.round((project.usage / maxUsage) * 100)),
  }));
}

export interface TopRequestRow {
  readonly id: string;
  readonly projectName: string;
  readonly usageLabel: string;
  readonly runTimeLabel: string;
  readonly latencyLabel: string;
  readonly status: ResourceRequest['status'];
  readonly timeLabel: string;
}

export function buildTopRequests(overview: ResourceOverview): TopRequestRow[] {
  return [...overview.requests]
    .sort((a, b) => b.usage - a.usage)
    .map((request) => ({
      id: request.id,
      projectName: request.project_name,
      usageLabel: `${request.usage.toFixed(1)} ${overview.focus.usage_unit}`,
      runTimeLabel: formatDuration(request.run_time_ms),
      latencyLabel: `${request.latency_ms} ms`,
      status: request.status,
      timeLabel: request.time_label,
    }));
}
