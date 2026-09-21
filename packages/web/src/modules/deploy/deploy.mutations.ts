import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import type { ProjectDeployAccepted } from '@cc-forge/api/deploy';

import { apiCall, forgeAuthApi } from '@/api';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

// Triggers a deploy and hands off to the deploy-id status route. Shared by the config screen (the
// direct first-deploy path) and the preview screen's Confirm, so the trigger lives in one place.
export function useTriggerDeploy(project_id: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiCall<ProjectDeployAccepted>(() => forgeAuthApi.projects[project_id]!.deploy.post({})),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.deploySummary(accepted.project_id),
      });
      return navigate({
        to: '/projects/$project_id/deploy/$deploy_id',
        params: { project_id: accepted.project_id, deploy_id: accepted.deploy_id },
      });
    },
  });
}
