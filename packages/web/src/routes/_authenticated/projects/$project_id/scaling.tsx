import { createFileRoute } from '@tanstack/react-router';

import { ScalingScreen } from '@/modules/scaling/scaling.screen';

export const Route = createFileRoute('/_authenticated/projects/$project_id/scaling')({
  component: ScalingRoute,
});

function ScalingRoute() {
  const { project_id } = Route.useParams();
  return <ScalingScreen project_id={project_id} />;
}
