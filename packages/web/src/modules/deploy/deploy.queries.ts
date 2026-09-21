import type { DeployPreview, DeployStopAccepted, ProjectDeploySummary } from '@canyonos/api/deploy';

import { apiCall, forgeAuthApi } from '@/api';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

// A failed read has to stay failed: the config screen hides its header controls behind its own
// pending branch, so refetching for them on mount would loop it on its skeleton forever.
export function projectDeploySummaryQueryOptions(project_id: string) {
  return {
    queryKey: projectQueryKeys.deploySummary(project_id),
    queryFn: () =>
      apiCall<ProjectDeploySummary>(() => forgeAuthApi.projects[project_id]!.deploy.summary.get()),
    retry: false,
    retryOnMount: false,
  };
}

export function projectDeployPreviewQueryOptions(project_id: string) {
  return {
    queryKey: projectQueryKeys.deployPreview(project_id),
    queryFn: () =>
      apiCall<DeployPreview>(() => forgeAuthApi.projects[project_id]!.deploy.preview.get()),
    retry: false,
  };
}

export function stopDeployment(project_id: string, deploy_id: string): Promise<DeployStopAccepted> {
  return apiCall<DeployStopAccepted>(() =>
    forgeAuthApi.projects[project_id]!.deploy[deploy_id]!.stop.post()
  );
}
