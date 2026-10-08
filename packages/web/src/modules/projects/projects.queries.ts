import type { MetricsKpis } from '@canyonos/api/metrics';
import type { ProjectSummary } from '@canyonos/api/projects';

import { apiCall, forgeAuthApi } from '@/api';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';

export function projectDetailQueryOptions(project_id: string) {
  return {
    queryKey: projectQueryKeys.detail(project_id),
    queryFn: () => apiCall<ProjectSummary>(() => forgeAuthApi.projects[project_id]!.get()),
    retry: false,
  };
}

// Shared so the ribbon, timeseries stats rail, and spend highlights don't each declare their own
// retry/refetchInterval and drift apart.
export function projectKpisQueryOptions(project_id: string) {
  return {
    queryKey: projectQueryKeys.metricsKpis(project_id),
    queryFn: () =>
      apiCall<MetricsKpis>(() => forgeAuthApi.projects[project_id]!.metrics.kpis.get()),
    retry: false,
    refetchInterval: dashboardPollInterval,
  };
}
