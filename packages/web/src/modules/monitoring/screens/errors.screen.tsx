// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MonitoringErrorSummaryResponse } from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { QueryError } from '@/modules/core/components/QueryError';
import { ErrorGroupPanel } from '@/modules/monitoring/components/error-group-panel';
import { LogList } from '@/modules/monitoring/components/log-list';
import { errorSummaryQueryOptions } from '@/modules/monitoring/monitoring.queries';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import type { RangeSelection } from '@/modules/core/time-range';

interface ErrorsScreenProps {
  readonly project_id: string;
  readonly range: RangeSelection;
}

export function ErrorsScreen({ project_id, range }: ErrorsScreenProps) {
  const summary = useQuery(errorSummaryQueryOptions(project_id, { range }));

  return (
    <main className="flex min-h-full shrink-0 flex-col gap-7 p-7" data-testid="errors-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Errors
        </h1>
        <ProjectWindowControl />
      </header>

      <ErrorSummary summary={summary} />

      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-foreground text-sm font-semibold">All errors</h2>
        <LogList
          project_id={project_id}
          range={range}
          errors_only
          empty_message="No errors recorded in this window."
          error_message="Could not load errors."
          test_id="errors"
        />
      </section>
    </main>
  );
}

function ErrorSummary({
  summary,
}: {
  readonly summary: UseQueryResult<MonitoringErrorSummaryResponse>;
}) {
  if (summary.error) {
    return (
      <QueryError
        message="Could not load the error breakdown."
        onRetry={() => void summary.refetch()}
        test_id="errors-summary-error"
      />
    );
  }
  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }
  return (
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
  );
}
