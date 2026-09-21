// Pure view-model builders for the resources overview screen. All share/percent/$ math lives here;
// components stay dumb and render precomputed display strings. Mirrors resources.selectors.ts — a
// future API could return these preformatted, at which point this layer collapses.

import type {
  FleetKpi,
  FleetOverview,
  FleetProject,
  FleetResource,
  ResourceId,
} from '@canyonos/api/resources';

import type { DonutDatum } from '@repo/ui/components/charts/donut-chart';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { formatMoney } from '@/modules/resources/resources.selectors';

export interface BreakdownStat {
  readonly label: string;
  readonly value: string;
}

export interface BreakdownBar {
  readonly resourceId: ResourceId;
  readonly label: string;
  readonly color: string;
  readonly widthPct: number;
  readonly pctLabel: string;
  readonly valueLabel: string;
}

export interface ProjectBreakdownModel {
  readonly projectId: string;
  readonly projectName: string;
  readonly color: string;
  readonly tint: string;
  readonly stats: readonly BreakdownStat[];
  readonly bars: readonly BreakdownBar[];
}

export interface ProjectChipModel {
  readonly id: string | null;
  readonly label: string;
  readonly color: string | null;
  readonly selected: boolean;
}

export interface KpiCardModel {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly subLabel: string;
  readonly subToneClass: string;
}

export interface ResourceDonutModel {
  readonly id: ResourceId;
  readonly label: string;
  readonly color: string;
  readonly poolLabel: string;
  readonly centerValue: string;
  readonly centerLabel: string;
  readonly segments: readonly DonutDatum[];
  readonly config: ChartConfig;
  readonly activeKey: string | null;
  readonly captionText: string;
  readonly captionColor: string;
  // Resources with no data source yet: the card renders a not-tracked placeholder, not a donut.
  readonly empty: boolean;
}

// Projects keep one categorical color everywhere (donut segments, chips, panel dot). Colors cycle
// through the six chart tokens so the palette matches the design and respects dark mode.
export function projectColorVar(colorIndex: number): string {
  return `var(--chart-${(colorIndex % 6) + 1})`;
}

// Resource bars in the detail panel are colored by RESOURCE, not by project. The design maps
// GPU/CPU/Memory/Storage/Tokens to chart-1..5 in that fixed order.
const RESOURCE_COLOR_INDEX: Record<ResourceId, number> = {
  gpu: 0,
  cpu: 1,
  mem: 2,
  storage: 3,
  tokens: 4,
};

function resourceColorVar(resourceId: ResourceId): string {
  return `var(--chart-${RESOURCE_COLOR_INDEX[resourceId] + 1})`;
}

function usageOf(project: FleetProject, resourceId: ResourceId): number {
  return project.resource_usage.find((entry) => entry.resource_id === resourceId)?.usage ?? 0;
}

function totalUsage(projects: readonly FleetProject[], resourceId: ResourceId): number {
  return projects.reduce((sum, project) => sum + usageOf(project, resourceId), 0);
}

function shareOf(project: FleetProject, resourceId: ResourceId, total: number): number {
  return total > 0 ? usageOf(project, resourceId) / total : 0;
}

function pctLabel(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Token usage sums fractionally (4.4 + 5.7 + …); every other resource is whole units.
function formatUsage(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1);
}

// Resource amounts carry their own unit (e.g. tokens → `1.2M`); only project cost is money.
function formatResourceAmount(value: number, resource: FleetResource): string {
  return `${formatUsage(value)}${resource.unit}`;
}

function formatResourcePool(resource: FleetResource): string {
  return resource.available ? formatResourceAmount(resource.pool, resource) : '—';
}

// Sidebar Resources section totals, sharing this payload's per-project math. Untracked resources
// emit no label, so the sidebar shows no fabricated number.
export function buildResourceUsageLabels(overview: FleetOverview): ReadonlyMap<ResourceId, string> {
  return new Map(
    overview.resources
      .filter((resource) => resource.available)
      .map((resource) => [
        resource.id,
        `${formatUsage(totalUsage(overview.projects, resource.id))} ${resource.unit}`,
      ])
  );
}

export function buildKpiCards(kpis: readonly FleetKpi[]): readonly KpiCardModel[] {
  return kpis.map((kpi) => ({
    id: kpi.id,
    label: kpi.label,
    value: kpi.value,
    subLabel: kpi.sub_label,
    subToneClass: kpi.tone === 'positive' ? 'text-primary' : 'text-muted-foreground',
  }));
}

export function buildProjectChips(
  projects: readonly FleetProject[],
  selectedId: string | null
): readonly ProjectChipModel[] {
  const allChip: ProjectChipModel = {
    id: null,
    label: 'All projects',
    color: null,
    selected: selectedId == null,
  };

  return [
    allChip,
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      color: projectColorVar(project.color_index),
      selected: selectedId === project.id,
    })),
  ];
}

export function buildResourceDonuts(
  resources: readonly FleetResource[],
  projects: readonly FleetProject[],
  selectedId: string | null
): readonly ResourceDonutModel[] {
  return resources.map((resource) => {
    const config: ChartConfig = Object.fromEntries(
      projects.map((project) => [
        project.id,
        { label: project.name, color: projectColorVar(project.color_index) },
      ])
    );

    if (!resource.available) {
      return {
        id: resource.id,
        label: resource.label,
        color: resourceColorVar(resource.id),
        poolLabel: '—',
        centerValue: '—',
        centerLabel: resource.label,
        segments: [],
        config,
        activeKey: null,
        captionText: 'Not tracked yet',
        captionColor: 'var(--muted-foreground)',
        empty: true,
      };
    }

    const total = totalUsage(projects, resource.id);
    const poolLabel = formatResourcePool(resource);

    const selected = selectedId != null ? projects.find((p) => p.id === selectedId) : undefined;
    let captionText: string;
    let captionColor: string;

    if (selected) {
      const share = shareOf(selected, resource.id, total);
      captionText = `${selected.name} · ${formatResourceAmount(share * resource.pool, resource)} · ${pctLabel(share)}`;
      captionColor = projectColorVar(selected.color_index);
    } else {
      const leader = [...projects].sort(
        (a, b) => usageOf(b, resource.id) - usageOf(a, resource.id)
      )[0];
      const leaderShare = leader ? shareOf(leader, resource.id, total) : 0;
      captionText = leader ? `${leader.name} leads · ${pctLabel(leaderShare)}` : 'No usage yet';
      captionColor = leader ? projectColorVar(leader.color_index) : 'var(--muted-foreground)';
    }

    return {
      id: resource.id,
      label: resource.label,
      color: resourceColorVar(resource.id),
      poolLabel,
      centerValue: poolLabel,
      centerLabel: resource.label,
      segments: projects.map((project) => ({
        key: project.id,
        value: usageOf(project, resource.id),
      })),
      config,
      activeKey: selectedId,
      captionText,
      captionColor,
      empty: false,
    };
  });
}

export function buildBreakdownPanel(
  projects: readonly FleetProject[],
  resources: readonly FleetResource[],
  selectedId: string | null
): ProjectBreakdownModel | null {
  if (selectedId == null) return null;
  const project = projects.find((p) => p.id === selectedId);
  if (!project) return null;

  const color = projectColorVar(project.color_index);

  const bars: BreakdownBar[] = resources.map((resource) => {
    if (!resource.available) {
      return {
        resourceId: resource.id,
        label: resource.label,
        color: resourceColorVar(resource.id),
        widthPct: 0,
        pctLabel: '—',
        valueLabel: '—',
      };
    }
    const share = shareOf(project, resource.id, totalUsage(projects, resource.id));
    return {
      resourceId: resource.id,
      label: resource.label,
      color: resourceColorVar(resource.id),
      // A zero share draws no bar; the floor only keeps a small-but-nonzero share visible.
      widthPct: share > 0 ? Math.max(3, Math.round(share * 100)) : 0,
      pctLabel: pctLabel(share),
      valueLabel: formatResourceAmount(share * resource.pool, resource),
    };
  });

  const stats: readonly BreakdownStat[] = [
    { label: 'Total cost', value: formatMoney(project.cost) },
    { label: 'Requests', value: project.requests.toLocaleString() },
    { label: 'Avg latency', value: `${Math.round(project.avg_latency_ms).toLocaleString()}ms` },
    { label: 'Error rate', value: `${project.error_rate_pct.toFixed(1)}%` },
  ];

  return {
    projectId: project.id,
    projectName: project.name,
    color,
    tint: `color-mix(in srgb, ${color} 6%, transparent)`,
    stats,
    bars,
  };
}
