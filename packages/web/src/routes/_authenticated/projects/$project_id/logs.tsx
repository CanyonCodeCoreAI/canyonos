import { createFileRoute } from '@tanstack/react-router';

import { LogsScreen } from '@/modules/monitoring/screens/logs.screen';
import { ProjectLogsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function LogsRoute() {
  const { project_id } = Route.useParams();
  return <LogsScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/logs')({
  staticData: {
    breadcrumbSlot: ProjectLogsBreadcrumbs,
  },
  component: LogsRoute,
});
