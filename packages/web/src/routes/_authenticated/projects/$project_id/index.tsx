import { createFileRoute } from '@tanstack/react-router';

import { ProjectHeaderSlot } from '@/modules/projects/components/project-header-slots';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';
import { ProjectScreen } from '@/modules/projects/screens/project.screen';

export const Route = createFileRoute('/_authenticated/projects/$project_id/')({
  validateSearch: metricsWindowSearchSchema,
  staticData: { headerSlot: ProjectHeaderSlot },
  component: ProjectRoute,
});

function ProjectRoute() {
  const { project_id } = Route.useParams();
  const { time_window } = Route.useSearch();
  return <ProjectScreen project_id={project_id} time_window={time_window} />;
}
