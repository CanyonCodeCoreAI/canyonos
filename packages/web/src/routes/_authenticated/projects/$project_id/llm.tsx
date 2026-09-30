import { createFileRoute } from '@tanstack/react-router';

import { LlmScreen } from '@/modules/monitoring/screens/llm.screen';
import { ProjectLlmBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function LlmRoute() {
  const { project_id } = Route.useParams();
  return <LlmScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/llm')({
  staticData: {
    breadcrumbSlot: ProjectLlmBreadcrumbs,
  },
  component: LlmRoute,
});
