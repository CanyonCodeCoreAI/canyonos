import { createFileRoute } from '@tanstack/react-router';

import { ProjectPromptManagement } from '@/modules/projects/components/project-prompt-management';

export const Route = createFileRoute('/_authenticated/projects/$project_id/prompts')({
  component: ProjectPromptsRoute,
});

function ProjectPromptsRoute() {
  const { project_id } = Route.useParams();
  return (
    <main className="flex min-h-full flex-col gap-7 p-7" data-testid="project-prompts-screen">
      <ProjectPromptManagement project_id={project_id} />
    </main>
  );
}
