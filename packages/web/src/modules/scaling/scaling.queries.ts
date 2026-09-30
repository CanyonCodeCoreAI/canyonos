import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type { ScalingDeleteResponse, ScalingPolicy, ScalingResponse } from '@canyonos/api/scaling';

import { toast } from '@repo/ui/shadcn/sonner';
import { apiCall, forgeAuthApi } from '@/api';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

export const scalingQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: projectQueryKeys.scaling(project_id),
    queryFn: () => apiCall<ScalingResponse>(() => forgeAuthApi.projects[project_id]!.scaling.get()),
    retry: false,
  });

interface SaveScalingPolicyInput {
  readonly agent_name: string;
  readonly policy: ScalingPolicy;
}

export function useSaveScalingPolicy(project_id: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: ({ agent_name, policy }: SaveScalingPolicyInput) =>
      apiCall<ScalingPolicy>(() =>
        forgeAuthApi.projects[project_id]!.scaling[agent_name]!.put(policy)
      ),
    onSuccess: (_policy, { agent_name }) => {
      toast.success(`Scaling policy saved for ${agent_name}`, { testId: 'app-toast' });
      return query_client.invalidateQueries({ queryKey: projectQueryKeys.scaling(project_id) });
    },
  });
}

export function useDeleteScalingPolicy(project_id: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: (agent_name: string) =>
      apiCall<ScalingDeleteResponse>(() =>
        forgeAuthApi.projects[project_id]!.scaling[agent_name]!.delete()
      ),
    onSuccess: (_response, agent_name) => {
      toast.success(`Scaling policy deleted for ${agent_name}`, { testId: 'app-toast' });
      return query_client.invalidateQueries({ queryKey: projectQueryKeys.scaling(project_id) });
    },
  });
}
