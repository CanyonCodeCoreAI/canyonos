import { createFileRoute } from '@tanstack/react-router';

import { MetricsScreen } from '@/modules/monitoring/screens/metrics.screen';
import { ProjectMetricsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';
import { metricsWindowSearchSchema } from '@/modules/projects/components/project-window-control';

function MetricsRoute() {
  const { project_id } = Route.useParams();
  const { time_window } = Route.useSearch();
  return <MetricsScreen project_id={project_id} time_window={time_window} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/metrics')({
  validateSearch: metricsWindowSearchSchema,
  staticData: {
    breadcrumbSlot: ProjectMetricsBreadcrumbs,
  },
  component: MetricsRoute,
});
