import { createFileRoute } from '@tanstack/react-router';

import { DeployStatusScreen } from '@/modules/deploy/screens/deploy-status.screen';
import { ProjectDeployBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function DeployStatusRoute() {
  const { project_id, deploy_id } = Route.useParams();
  // Key on the deploy id so retriggering to a new id remounts a fresh machine rather than reusing the
  // finished run's context.
  return <DeployStatusScreen key={deploy_id} project_id={project_id} deploy_id={deploy_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/deploy/$deploy_id')({
  // No headerSlot: whether a way back is offered depends on the deploy machine's state, which only
  // the screen can see.
  staticData: {
    breadcrumbSlot: ProjectDeployBreadcrumbs,
  },
  component: DeployStatusRoute,
});
