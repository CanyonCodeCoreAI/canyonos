import { createFileRoute } from '@tanstack/react-router';

import { MonitoringSearchSchema } from '@/modules/monitoring/monitoring.search';
import { MonitoringScreen } from '@/modules/monitoring/screens/monitoring.screen';
import { ProjectMonitoringBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';

function MonitoringRoute() {
  const { project_id } = Route.useParams();
  const { time_window, view } = Route.useSearch();
  return <MonitoringScreen project_id={project_id} time_window={time_window} view={view} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/monitoring')({
  validateSearch: metricsWindowSearchSchema.extend(MonitoringSearchSchema.shape),
  staticData: {
    breadcrumbSlot: ProjectMonitoringBreadcrumbs,
  },
  component: MonitoringRoute,
});
