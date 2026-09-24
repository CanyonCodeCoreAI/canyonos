import { useQuery } from '@tanstack/react-query';

import type { ProjectStats } from '@canyonos/api/projects';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';

export function ProjectContext({ project_id }: { readonly project_id: string }) {
  const stats_query = useQuery({
    queryKey: projectQueryKeys.stats(project_id),
    queryFn: () => apiCall<ProjectStats>(() => forgeAuthApi.projects[project_id]!.stats.get()),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

  return (
    <div data-testid="project-context">
      {stats_query.error ? (
        <QueryError
          message="Could not load project statistics."
          onRetry={() => void stats_query.refetch()}
          test_id="project-stats-error"
        />
      ) : null}
      <ProjectFacts
        stats={stats_query.error ? undefined : stats_query.data}
        is_loading={stats_query.isPending}
      />
    </div>
  );
}

function ProjectFacts({
  stats,
  is_loading,
}: {
  readonly stats?: ProjectStats;
  readonly is_loading: boolean;
}) {
  if (!stats) {
    return is_loading ? <Skeleton className="h-7 w-full max-w-[38rem] rounded-lg" /> : null;
  }

  const counts = [
    { label: 'Files', value: stats.file_count },
    { label: 'Workflows', value: stats.workflow_count },
    { label: 'Ready workflows', value: stats.ready_workflow_count },
    { label: 'Agents', value: stats.agent_count },
    { label: 'Tools', value: stats.tool_count },
  ];

  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="project-stats">
      {counts.map((count) => (
        <div key={count.label} className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground">{count.label}</dt>
          <dd className="text-foreground font-mono font-semibold tabular-nums">{count.value}</dd>
        </div>
      ))}
    </dl>
  );
}
