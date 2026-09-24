import { createFileRoute } from '@tanstack/react-router';

import { ProjectHeaderSlot } from '@/modules/projects/components/project-header-slots';
import { ProjectScreen } from '@/modules/projects/screens/project.screen';

export const Route = createFileRoute('/_authenticated/projects/$project_id/')({
  staticData: { headerSlot: ProjectHeaderSlot },
  component: ProjectRoute,
});

function ProjectRoute() {
  const { project_id } = Route.useParams();
  return <ProjectScreen project_id={project_id} />;
}
