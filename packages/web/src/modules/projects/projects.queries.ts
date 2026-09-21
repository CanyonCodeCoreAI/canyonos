import type { MetricsKpis } from '@canyonos/api/metrics';

import { apiCall, forgeAuthApi } from '@/api';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';

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
