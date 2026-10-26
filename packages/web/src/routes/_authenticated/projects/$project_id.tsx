// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQueryClient } from '@tanstack/react-query';
import {
  createFileRoute,
  Outlet,
  redirect,
  retainSearchParams,
  useRouter,
} from '@tanstack/react-router';

import { toast } from '@repo/ui/shadcn/sonner';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  hasInvalidCustomRange,
  metricsWindowSearchSchema,
  rangeLabel,
} from '@/modules/core/time-range';
import { ProjectBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { projectDetailQueryOptions } from '@/modules/projects/projects.queries';
import { retryProjectDetailLoader } from '@/modules/projects/projects.query-cache';
import type { MetricsRangeSearch } from '@/modules/core/time-range';

export const Route = createFileRoute('/_authenticated/projects/$project_id')({
  validateSearch: metricsWindowSearchSchema,
  search: { middlewares: [retainSearchParams<MetricsRangeSearch>(['range', 'from', 'to'])] },
  beforeLoad: ({ search }) => {
    if (!hasInvalidCustomRange(search)) return;
    // The id keeps it one toast when a second navigation reaches the same bad link.
    toast.error(
      `There was an error reading this link's time range, so the page shows the last ${rangeLabel({ preset: search.range })}.`,
      { id: 'invalid-time-range', testId: 'app-toast' }
    );
    throw redirect({
      to: '.',
      search: (previous) => ({ ...previous, from: undefined, to: undefined }),
      replace: true,
    });
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(projectDetailQueryOptions(params.project_id)),
  pendingComponent: () => <EmptyState loading>Loading project…</EmptyState>,
  errorComponent: ({ reset }) => <ProjectRouteError reset={reset} />,
  staticData: { breadcrumbSlot: ProjectBreadcrumbs },
  component: Outlet,
});

function ProjectRouteError({ reset }: { readonly reset: () => void }) {
  const router = useRouter();
  const query_client = useQueryClient();
  const { project_id } = Route.useParams();

  return (
    <QueryError
      message="Could not load this project."
      onRetry={() =>
        void retryProjectDetailLoader(query_client, project_id, () => router.invalidate(), reset)
      }
      className="m-7"
      test_id="project-layout-error"
    />
  );
}
