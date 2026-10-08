import { useQuery } from '@tanstack/react-query';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type {
  MonitoringResource,
  MonitoringResourceUtilizationResponse,
} from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { ResourceLegend, ResourceSection } from '@/modules/monitoring/components/resource-section';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';

interface MetricsScreenProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
}

function presentResources(data: MonitoringResourceUtilizationResponse): MonitoringResource[] {
  const seen = new Set<MonitoringResource>();
  for (const entry of [...data.machines, ...data.agents]) {
    for (const series of entry.series) seen.add(series.resource);
  }
  return [...seen];
}

export function MetricsScreen({ project_id, time_window }: MetricsScreenProps) {
  const query = useQuery({
    queryKey: ['projects', project_id, 'monitoring', 'resources', time_window],
    queryFn: () =>
      apiCall<MonitoringResourceUtilizationResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.resources.get({ $query: { time_window } })
      ),
    retry: false,
  });

  return (
    <main
      className="scroll-area flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-7"
      data-testid="metrics-screen"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Metrics
        </h1>
        <ProjectWindowControl />
      </header>

      {query.error ? (
        <QueryError
          message="Could not load resource metrics."
          onRetry={() => void query.refetch()}
          test_id="metrics-error"
        />
      ) : query.isPending ? (
        <div className="flex flex-col gap-5">
          <Skeleton className="h-64 w-full rounded-[1.125rem]" />
          <Skeleton className="h-64 w-full rounded-[1.125rem]" />
        </div>
      ) : (
        <MetricsSections data={query.data} />
      )}
    </main>
  );
}

function MetricsSections({ data }: { readonly data: MonitoringResourceUtilizationResponse }) {
  return (
    <div className="flex flex-col">
      <ResourceLegend resources={presentResources(data)} />
      <hr className="border-border/70 my-6" />
      <ResourceSection
        title="Machines"
        caption="Host utilization, sampled on a timer."
        entries={data.machines}
        bucket_start_ats={data.bucket_start_ats}
        bucket_seconds={data.bucket_seconds}
        empty_message="No machine samples in this window."
        test_id="metrics-machines"
      />
      <hr className="border-border/70 my-7" />
      <ResourceSection
        title="Agents"
        caption="Share of each block's wall time the agent spent on CPU."
        entries={data.agents}
        bucket_start_ats={data.bucket_start_ats}
        bucket_seconds={data.bucket_seconds}
        empty_message="No agent readings in this window."
        test_id="metrics-agents"
      />
    </div>
  );
}
