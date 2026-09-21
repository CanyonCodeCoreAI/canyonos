import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';

import type { ProjectWorkflowDetail } from '@cc-forge/api/workflows';

import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { parseFileSearch } from '@/modules/core/navigation/search';
import { ProjectWorkflowDesignBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import { WorkflowDesignHeaderSlot } from '@/modules/workflows/components/WorkflowDesignHeaderSlot';
import { ProjectWorkflowDesignScreen } from '@/modules/workflows/screens/project-workflow-design.screen';

export const Route = createFileRoute(
  '/_authenticated/projects/$project_id/workflows/$workflow_id/design'
)({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      queryKey: projectQueryKeys.workflow(params.project_id, params.workflow_id),
      queryFn: () =>
        apiCall<ProjectWorkflowDetail>(() =>
          forgeAuthApi.projects[params.project_id]!.workflows[params.workflow_id]!.get()
        ),
      staleTime: 30_000,
      retry: false,
    }),
  errorComponent: ({ reset }) => <ProjectWorkflowRouteError reset={reset} />,
  staticData: {
    breadcrumbSlot: ProjectWorkflowDesignBreadcrumbs,
    headerSlot: WorkflowDesignHeaderSlot,
    contentWidth: 'wide',
  },
  validateSearch: (search: Record<string, unknown>) => ({
    file_id: parseFileSearch(search.file_id),
  }),
  component: ProjectWorkflowDesignRoute,
});

function ProjectWorkflowRouteError({ reset }: { readonly reset: () => void }) {
  const router = useRouter();
  const query_client = useQueryClient();
  const { project_id, workflow_id } = Route.useParams();

  const retry = async () => {
    query_client.removeQueries({
      queryKey: projectQueryKeys.workflow(project_id, workflow_id),
      exact: true,
    });
    await router.invalidate();
    reset();
  };

  return (
    <QueryError
      message="Could not load this project workflow."
      onRetry={() => void retry()}
      className="m-7"
      test_id="project-workflow-error"
    />
  );
}

function ProjectWorkflowDesignRoute() {
  const { project_id, workflow_id } = Route.useParams();
  const { file_id } = Route.useSearch();
  return (
    <ProjectWorkflowDesignScreen
      project_id={project_id}
      workflow_id={workflow_id}
      selected_file_id={file_id}
    />
  );
}
