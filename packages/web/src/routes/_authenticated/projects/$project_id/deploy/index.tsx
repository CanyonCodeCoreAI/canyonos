import { createFileRoute } from '@tanstack/react-router';

import { ProjectDeployScreen } from '@/modules/deploy/screens/project-deploy.screen';
import { ProjectDeployBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function ProjectDeployRoute() {
  const { project_id } = Route.useParams();
  return <ProjectDeployScreen project_id={project_id} />;
}

// No headerSlot: the deploy action needs the form's own submit state, so the screen docks it into
// the header itself (see ProjectDeployScreen).
export const Route = createFileRoute('/_authenticated/projects/$project_id/deploy/')({
  staticData: {
    breadcrumbSlot: ProjectDeployBreadcrumbs,
  },
  component: ProjectDeployRoute,
});
