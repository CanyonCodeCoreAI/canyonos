// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { hashKey, useQuery } from '@tanstack/react-query';
import { useReducer, useState } from 'react';

import type { DistributionMetric } from '@canyonos/api/metrics';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectCostDistribution } from '@/modules/projects/components/project-cost-distribution';
import { ProjectCostFlow } from '@/modules/projects/components/project-cost-flow';
import { ProjectCostRibbon } from '@/modules/projects/components/project-cost-ribbon';
import {
  INITIAL_REQUESTS_TABLE,
  ProjectRequestsTable,
  requestsTableReducer,
} from '@/modules/projects/components/project-requests-table';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import { projectDetailQueryOptions } from '@/modules/projects/projects.queries';
import type { RangeSelection } from '@/modules/core/time-range';
import type { SpendTab } from '@/modules/projects/components/project-cost-flow';
import type { DistributionSelection } from '@/modules/projects/projects.metrics';

interface ProjectScreenProps {
  readonly project_id: string;
  readonly range: RangeSelection;
}

export function ProjectScreen({ project_id, range }: ProjectScreenProps) {
  // Held here rather than in the URL: picking a metric or a bucket is exploration, and routing every
  // click re-renders the whole app shell, which the sidebar and the header both subscribe to.
  const [metric, setMetric] = useState<DistributionMetric>('cost_per_request');
  // Which cut of the spend is showing. Held here because the sections below the flow card are only
  // meaningful against the overview: the per-agent and per-query lists carry their own totals.
  const [spend_tab, setSpendTab] = useState<SpendTab>('overview');

  const project_query = useQuery(projectDetailQueryOptions(project_id));

  if (project_query.error) {
    return (
      <QueryError
        message="Could not load the project summary."
        onRetry={() => void project_query.refetch()}
        className="m-7"
        test_id="project-summary-error"
      />
    );
  }

  return (
    <main className="flex min-h-full flex-col gap-7 p-7" data-testid="project-screen">
      <header
        className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3"
        data-testid="project-hero"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          {project_query.isPending ? (
            <Skeleton className="h-7 w-64 rounded-lg" />
          ) : (
            <h1 className="text-foreground min-w-0 truncate text-[1.5rem] leading-tight font-bold tracking-tight">
              {project_query.data.name}
            </h1>
          )}
        </div>
        <ProjectWindowControl />
      </header>

      <ProjectCostRibbon project_id={project_id} range={range} />
      <ProjectCostFlow
        project_id={project_id}
        range={range}
        tab={spend_tab}
        onTabChange={setSpendTab}
        // The Per-Query cut is the histogram and the queries in the bucket picked from it, read side
        // by side. Everything picked in it was read under one range, so it starts over on another.
        query_panel={
          <QueryPanel
            key={hashKey([range])}
            project_id={project_id}
            range={range}
            metric={metric}
            onMetricChange={setMetric}
          />
        }
      />
    </main>
  );
}

function QueryPanel({
  project_id,
  range,
  metric,
  onMetricChange,
}: {
  readonly project_id: string;
  readonly range: RangeSelection;
  readonly metric: DistributionMetric;
  readonly onMetricChange: (metric: DistributionMetric) => void;
}) {
  const [selection, setSelection] = useState<DistributionSelection | null>(null);
  const [table, dispatchTable] = useReducer(requestsTableReducer, INITIAL_REQUESTS_TABLE);
  // A bucket only means something against the metric it was read from, and the page the listing
  // was on described the previous bucket.
  const select = (next: DistributionSelection | null) => {
    setSelection(next);
    dispatchTable({ type: 'page-offset', offset: 0 });
  };

  return (
    <div className="grid min-w-0 shrink-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <ProjectCostDistribution
        project_id={project_id}
        range={range}
        metric={metric}
        selection={selection}
        onMetricChange={(next) => {
          onMetricChange(next);
          select(null);
        }}
        onSelect={select}
      />
      <ProjectRequestsTable
        project_id={project_id}
        range={range}
        selection={selection}
        state={table}
        dispatch={dispatchTable}
      />
    </div>
  );
}
