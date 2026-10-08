import { createFileRoute } from '@tanstack/react-router';

import { LlmScreen } from '@/modules/monitoring/screens/llm.screen';
import { ProjectLlmBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';

function LlmRoute() {
  const { project_id } = Route.useParams();
  const { time_window } = Route.useSearch();
  return <LlmScreen project_id={project_id} time_window={time_window} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/llm')({
  validateSearch: metricsWindowSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectLlmBreadcrumbs,
  },
  component: LlmRoute,
});
