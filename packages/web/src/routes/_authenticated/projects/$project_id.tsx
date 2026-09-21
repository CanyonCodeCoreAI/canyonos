import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';

import type { ProjectSummary } from '@cc-forge/api/projects';

import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import {
  projectQueryKeys,
  retryProjectDetailLoader,
} from '@/modules/projects/projects.query-cache';

export const Route = createFileRoute('/_authenticated/projects/$project_id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      queryKey: projectQueryKeys.detail(params.project_id),
      queryFn: () => apiCall<ProjectSummary>(() => forgeAuthApi.projects[params.project_id]!.get()),
      retry: false,
    }),
  pendingComponent: () => <EmptyState>Loading project…</EmptyState>,
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
