import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringErrorSummaryResponse } from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { ErrorGroupPanel } from '@/modules/monitoring/components/error-group-panel';
import { LogList } from '@/modules/monitoring/components/log-list';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import { DEFAULT_METRICS_WINDOW } from '@/modules/projects/projects.metrics';

interface ErrorsScreenProps {
  readonly project_id: string;
}

export function ErrorsScreen({ project_id }: ErrorsScreenProps) {
  const [time_window, setTimeWindow] = useState<MetricsWindow>(DEFAULT_METRICS_WINDOW);
  const summary = useQuery({
    queryKey: ['projects', project_id, 'monitoring', 'errors', 'summary', time_window],
    queryFn: () =>
      apiCall<MonitoringErrorSummaryResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.errors.summary.get({
          $query: { time_window },
        })
      ),
    retry: false,
  });

  return (
    <main className="flex min-h-full flex-col gap-7 p-7" data-testid="errors-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Errors
        </h1>
        <ProjectWindowControl value={time_window} onChange={setTimeWindow} />
      </header>

      {summary.error ? (
        <QueryError
          message="Could not load the error breakdown."
          onRetry={() => void summary.refetch()}
          test_id="errors-summary-error"
        />
      ) : summary.isPending ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-[1.125rem]" />
          <Skeleton className="h-64 w-full rounded-[1.125rem]" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2" data-testid="errors-summary">
          <ErrorGroupPanel
            title="By error type"
            groups={summary.data.by_type}
            total={summary.data.total}
            test_id="errors-by-type"
          />
          <ErrorGroupPanel
            title="By agent"
            groups={summary.data.by_agent}
            total={summary.data.total}
            test_id="errors-by-agent"
          />
        </div>
      )}

      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-foreground text-sm font-semibold">All errors</h2>
        <LogList
          project_id={project_id}
          time_window={time_window}
          errors_only
          empty_message="No errors recorded in this window."
          error_message="Could not load errors."
          test_id="errors"
        />
      </section>
    </main>
  );
}
