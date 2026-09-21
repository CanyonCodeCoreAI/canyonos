import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { FleetOverview } from '@cc-forge/api/resources';

import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { DefaultTimeRange } from '@repo/ui/components/time-range-toggle';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectBreakdownPanel } from '@/modules/resources/components/overview/ProjectBreakdownPanel';
import { ProjectChipRow } from '@/modules/resources/components/overview/ProjectChipRow';
import { ResourceDonutCard } from '@/modules/resources/components/overview/ResourceDonutCard';
import { ResourcesOverviewKpisContainer } from '@/modules/resources/components/overview/ResourcesOverviewKpisContainer';
import {
  buildBreakdownPanel,
  buildKpiCards,
  buildProjectChips,
  buildResourceDonuts,
} from '@/modules/resources/overview.selectors';

type ApiTimeWindow = FleetOverview['time_window'];

// The toggle speaks product ranges; the fleet endpoint speaks metrics time windows.
const UI_TO_API_TIME_WINDOW: Record<DefaultTimeRange, ApiTimeWindow> = {
  '24h': '1d',
  '7d': '7d',
  '30d': '30d',
};

const RANGE_LABEL: Record<DefaultTimeRange, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

const DONUT_SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;
const KPI_SKELETON_KEYS = ['a', 'b', 'c', 'd'] as const;

function OverviewHero({ subtitle, toggle }: { subtitle: string; toggle?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5" data-testid="overview-hero">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-[1.75rem] leading-none font-bold tracking-tight">
          Resource Overview
        </h1>
        <p className="text-muted-foreground max-w-[35rem] text-sm leading-relaxed">{subtitle}</p>
      </div>
      {toggle}
    </div>
  );
}

export function ResourceOverviewScreen() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [range, setRange] = useState<DefaultTimeRange>('24h');
  const apiTimeWindow = UI_TO_API_TIME_WINDOW[range];

  const query = useQuery({
    queryKey: ['resources', 'overview', apiTimeWindow],
    queryFn: () =>
      apiCall<FleetOverview>(() =>
        forgeAuthApi.resources.overview.get({ $query: { time_window: apiTimeWindow } })
      ),
    retry: false,
  });

  const rangeToggle = (
    <TimeRangeToggle
      value={range}
      onValueChange={(next) => setRange(next as DefaultTimeRange)}
      data-testid="overview-range-toggle"
      aria-label="Resource time range"
    />
  );

  if (query.isPending) {
    return (
      <main
        className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-7 pb-16"
        data-testid="overview-loading"
        aria-busy
      >
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-4 w-80" />
          </div>
          <Skeleton className="h-8 w-44 rounded-full" />
        </div>
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))] gap-3.5">
          {KPI_SKELETON_KEYS.map((key) => (
            <Skeleton key={key} className="h-24 rounded-2xl" />
          ))}
        </div>
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(13.5rem,1fr))] gap-4">
          {DONUT_SKELETON_KEYS.map((key) => (
            <Skeleton key={key} className="h-56 rounded-[1.125rem]" />
          ))}
        </div>
      </main>
    );
  }

  if (query.isError) {
    return (
      <main
        className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-7 pb-16"
        data-testid="resources-overview"
      >
        <OverviewHero subtitle="How your projects are using the fleet." toggle={rangeToggle} />
        <QueryError
          test_id="overview-error"
          retry_test_id="overview-retry"
          message="We couldn't load your fleet overview."
          onRetry={() => void query.refetch()}
        />
      </main>
    );
  }

  const data = query.data;

  if (data.projects.length === 0) {
    return (
      <main
        className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-7 pb-16"
        data-testid="resources-overview"
      >
        <OverviewHero subtitle="No projects are using the fleet yet." toggle={rangeToggle} />
        <EmptyState test_id="overview-empty">
          <p>No projects are using the fleet yet. Deploy a project to see usage here.</p>
        </EmptyState>
      </main>
    );
  }

  const selectProject = (id: string | null) => {
    if (id == null) {
      setSelectedProjectId(null);
      return;
    }

    setSelectedProjectId((current) => (current === id ? null : id));
  };

  const projectCount = data.projects.length;
  const kpis = buildKpiCards(data.kpis);
  const chips = buildProjectChips(data.projects, selectedProjectId);
  const donuts = buildResourceDonuts(data.resources, data.projects, selectedProjectId);
  const breakdown = buildBreakdownPanel(data.projects, data.resources, selectedProjectId);

  return (
    <main
      className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-7 pb-16"
      data-testid="resources-overview"
    >
      <OverviewHero
        subtitle={`How your ${projectCount} ${projectCount === 1 ? 'project' : 'projects'} are using the fleet — by requests, cost, and token usage over the ${RANGE_LABEL[range]}.`}
        toggle={rangeToggle}
      />

      <ResourcesOverviewKpisContainer kpis={kpis} />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-foreground text-base font-bold tracking-tight">
              Breakdown by project
            </h2>
            <p className="text-muted-foreground text-xs">
              Each ring splits a resource across projects — tap a project to highlight it
              everywhere.
            </p>
          </div>
          <ProjectChipRow chips={chips} onSelect={selectProject} />
        </div>

        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(13.5rem,1fr))] gap-4">
          {donuts.map((donut, index) => (
            <ResourceDonutCard
              key={donut.id}
              model={donut}
              index={index}
              onSegmentSelect={selectProject}
            />
          ))}
        </div>

        <ProjectBreakdownPanel model={breakdown} onClose={() => setSelectedProjectId(null)} />
      </div>
    </main>
  );
}
