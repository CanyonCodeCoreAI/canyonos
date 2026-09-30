import { createFileRoute } from '@tanstack/react-router';

import { ErrorsScreen } from '@/modules/monitoring/screens/errors.screen';
import { ProjectErrorsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function ErrorsRoute() {
  const { project_id } = Route.useParams();
  return <ErrorsScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/errors')({
  staticData: {
    breadcrumbSlot: ProjectErrorsBreadcrumbs,
  },
  component: ErrorsRoute,
});
