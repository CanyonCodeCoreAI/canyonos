import { createFileRoute } from '@tanstack/react-router';

import { MonitoringScreen } from '@/modules/monitoring/screens/monitoring.screen';
import { ProjectMonitoringBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function MonitoringRoute() {
  const { project_id } = Route.useParams();
  return <MonitoringScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/monitoring')({
  staticData: {
    breadcrumbSlot: ProjectMonitoringBreadcrumbs,
  },
  component: MonitoringRoute,
});
