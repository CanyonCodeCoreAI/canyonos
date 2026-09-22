import { getRouteApi } from '@tanstack/react-router';

import { ProjectDeployControls } from '@/modules/deploy/components/deploy-controls';

const route = getRouteApi('/_authenticated/projects/$project_id/workflows/$workflow_id/design');

// The deploy controls are the only header action on a design; going back is the sidebar's job.
export function WorkflowDesignHeaderSlot() {
  const { project_id } = route.useParams();

  return <ProjectDeployControls project_id={project_id} />;
}
