import { createFileRoute } from '@tanstack/react-router';

import { MonitoringSearchSchema } from '@/modules/monitoring/monitoring.search';
import { MonitoringScreen } from '@/modules/monitoring/screens/monitoring.screen';
import { ProjectMonitoringBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function MonitoringRoute() {
  const { project_id } = Route.useParams();
  return <MonitoringScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/monitoring')({
  validateSearch: MonitoringSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectMonitoringBreadcrumbs,
  },
  component: MonitoringRoute,
});
