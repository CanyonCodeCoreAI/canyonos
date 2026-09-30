import { createFileRoute } from '@tanstack/react-router';

import { MetricsScreen } from '@/modules/monitoring/screens/metrics.screen';
import { ProjectMetricsBreadcrumbs } from '@/modules/projects/components/project-breadcrumbs';

function MetricsRoute() {
  const { project_id } = Route.useParams();
  return <MetricsScreen project_id={project_id} />;
}

export const Route = createFileRoute('/_authenticated/projects/$project_id/metrics')({
  staticData: {
    breadcrumbSlot: ProjectMetricsBreadcrumbs,
  },
  component: MetricsRoute,
});
