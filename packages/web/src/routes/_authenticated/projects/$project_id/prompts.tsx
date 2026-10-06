import { createFileRoute } from '@tanstack/react-router';

import { PromptsScreen } from '@/modules/prompts/prompts.screen';

export const Route = createFileRoute('/_authenticated/projects/$project_id/prompts')({
  component: ProjectPromptsRoute,
});

function ProjectPromptsRoute() {
  const { project_id } = Route.useParams();
  return <PromptsScreen project_id={project_id} />;
}
