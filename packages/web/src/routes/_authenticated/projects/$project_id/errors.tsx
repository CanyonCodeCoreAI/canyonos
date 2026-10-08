import { createFileRoute } from '@tanstack/react-router';

import { ErrorsScreen } from '@/modules/monitoring/screens/errors.screen';
import { ProjectErrorsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';

function ErrorsRoute() {
  const { project_id } = Route.useParams();
  const { time_window } = Route.useSearch();
  return <ErrorsScreen project_id={project_id} time_window={time_window} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/errors')({
  validateSearch: metricsWindowSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectErrorsBreadcrumbs,
  },
  component: ErrorsRoute,
});
