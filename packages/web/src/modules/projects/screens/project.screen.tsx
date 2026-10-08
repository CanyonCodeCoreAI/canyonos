import { useQuery } from '@tanstack/react-query';
import { useReducer, useState } from 'react';

import type { DistributionMetric, MetricsWindow } from '@canyonos/api/metrics';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectContext } from '@/modules/projects/components/project-context';
import { ProjectCostDistribution } from '@/modules/projects/components/project-cost-distribution';
import { ProjectCostFlow } from '@/modules/projects/components/project-cost-flow';
import { ProjectCostRibbon } from '@/modules/projects/components/project-cost-ribbon';
import { ProjectRequestsTable } from '@/modules/projects/components/project-requests-table';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import { DEFAULT_METRICS_WINDOW } from '@/modules/projects/projects.metrics';
import { projectDetailQueryOptions } from '@/modules/projects/projects.queries';
import type { SpendTab } from '@/modules/projects/components/project-cost-flow';
import type { DistributionSelection } from '@/modules/projects/projects.metrics';

interface DashboardState {
  readonly time_window: MetricsWindow;
  readonly metric: DistributionMetric;
  readonly selection: DistributionSelection | null;
}

type DashboardAction =
  | { readonly type: 'time_window'; readonly time_window: MetricsWindow }
  | { readonly type: 'metric'; readonly metric: DistributionMetric }
  | { readonly type: 'select'; readonly selection: DistributionSelection | null };

const INITIAL_DASHBOARD: DashboardState = {
  time_window: DEFAULT_METRICS_WINDOW,
  metric: 'cost_per_request',
  selection: null,
};

/**
 * The three controls the dashboard reads itself through: the range every section is scoped to, the
 * metric the histogram plots, and the bucket of it the query table lists.
 *
 * A selected bucket only means something against the range and metric it was read from, so moving
 * either drops it — stated once here rather than at each call site that used to repeat it.
 * Unchanged actions return the same state, so re-picking what is already selected costs no render.
 */
function reduceDashboard(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'time_window':
      return state.time_window === action.time_window
        ? state
        : { ...state, time_window: action.time_window, selection: null };
    case 'metric':
      return state.metric === action.metric
        ? state
        : { ...state, metric: action.metric, selection: null };
    case 'select':
      return { ...state, selection: action.selection };
  }
}

interface ProjectScreenProps {
  readonly project_id: string;
}

export function ProjectScreen({ project_id }: ProjectScreenProps) {
  // Held here rather than in the URL: reading this dashboard is exploration, and routing every
  // range, metric and bucket click re-renders the whole app shell, which the sidebar and the
  // header both subscribe to. Nothing here is worth linking someone to.
  const [dashboard, dispatch] = useReducer(reduceDashboard, INITIAL_DASHBOARD);
  // Which cut of the spend is showing. Held here because the sections below the flow card are only
  // meaningful against the overview: the per-agent and per-query lists carry their own totals.
  const [spend_tab, setSpendTab] = useState<SpendTab>('overview');
  const { time_window } = dashboard;

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
            <h1 className="text-foreground min-w-0 truncate text-[1.5rem] leading-none font-bold tracking-tight">
              {project_query.data.name}
            </h1>
          )}
        </div>
        <ProjectWindowControl
          value={time_window}
          onChange={(time_window) => dispatch({ type: 'time_window', time_window })}
        />
      </header>

      <ProjectContext project_id={project_id} />

      <ProjectCostRibbon project_id={project_id} time_window={time_window} />
      <ProjectCostFlow
        project_id={project_id}
        time_window={time_window}
        tab={spend_tab}
        onTabChange={setSpendTab}
        // The Per-Query cut is the histogram and the queries in the bucket picked from it, read
        // side by side. Composed here because it needs the dashboard's metric and selection; passed
        // into the tab card so the panel holds its own content instead of trailing below it.
        query_panel={
          <div className="grid min-w-0 shrink-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <ProjectCostDistribution
              project_id={project_id}
              time_window={time_window}
              metric={dashboard.metric}
              selection={dashboard.selection}
              onMetricChange={(metric) => dispatch({ type: 'metric', metric })}
              onSelect={(selection) => dispatch({ type: 'select', selection })}
            />
            <ProjectRequestsTable
              project_id={project_id}
              time_window={time_window}
              selection={dashboard.selection}
            />
          </div>
        }
      />
    </main>
  );
}
