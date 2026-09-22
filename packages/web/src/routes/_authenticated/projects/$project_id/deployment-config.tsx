import { createFileRoute } from '@tanstack/react-router';

import { DeploymentConfigScreen } from '@/modules/deploy/screens/deployment-config.screen';
import { ProjectDeploymentConfigBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function DeploymentConfigRoute() {
  const { project_id } = Route.useParams();
  return <DeploymentConfigScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/deployment-config')({
  staticData: {
    breadcrumbSlot: ProjectDeploymentConfigBreadcrumbs,
  },
  component: DeploymentConfigRoute,
});
