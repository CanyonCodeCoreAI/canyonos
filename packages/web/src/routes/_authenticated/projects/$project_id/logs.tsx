import { createFileRoute } from '@tanstack/react-router';

import { LogsScreen } from '@/modules/monitoring/screens/logs.screen';
import { ProjectLogsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';

function LogsRoute() {
  const { project_id } = Route.useParams();
  const { time_window } = Route.useSearch();
  return <LogsScreen project_id={project_id} time_window={time_window} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/logs')({
  validateSearch: metricsWindowSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectLogsBreadcrumbs,
  },
  component: LogsRoute,
});
