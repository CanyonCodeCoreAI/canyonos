import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingStatus,
} from '@canyonos/api/scaling';

import { toast } from '@repo/ui/shadcn/sonner';
import { apiCall, forgeAuthApi } from '@/api';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';

const TOAST = { testId: 'app-toast', position: 'top-center' } as const;

const ERROR_MESSAGES: Record<string, string> = {
  'canyonos.project_not_running':
    'This project is not running, so its scaling policy cannot be read. Deploy it, then retry.',
  'canyonos.controller_unreachable':
    'The running controller could not be reached. Check that it is up, then retry.',
  'scaling.config_invalid':
    "The controller's scaling config could not be read. Fix config/scaling.yaml and reload, then retry.",
};

/** A known error code in the screen's words; otherwise what the API said, or the fallback. */
export function scalingErrorMessage(
  error: (Error & { readonly code?: string }) | null,
  fallback: string
): string {
  return ERROR_MESSAGES[error?.code ?? ''] ?? (error?.message || fallback);
}

export const scalingQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: projectQueryKeys.scaling(project_id),
    queryFn: () => apiCall<ScalingStatus>(() => forgeAuthApi.projects[project_id]!.scaling.get()),
    retry: false,
  });

// Polled: this is where the operator watches the replica counts move after a change.
export const scalingAgentsQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: projectQueryKeys.scalingAgents(project_id),
    queryFn: () =>
      apiCall<ScalingAgentsResponse>(() => forgeAuthApi.projects[project_id]!.scaling.agents.get()),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

// The agents key sits under the policy key, so one invalidation re-reads both.
function useInvalidateScaling(project_id: string) {
  const query_client = useQueryClient();
  return () => query_client.invalidateQueries({ queryKey: projectQueryKeys.scaling(project_id) });
}

export function useSaveScalingPolicy(project_id: string) {
  const invalidate = useInvalidateScaling(project_id);
  return useMutation({
    mutationFn: (policy: ScalingPolicy) =>
      apiCall<ScalingPolicy>(() => forgeAuthApi.projects[project_id]!.scaling.put(policy)),
    // Toasted here: the re-read remounts the card, so a callback on the call site never runs.
    onSuccess: () => {
      toast.success(
        "Scaling policy saved. Agents pick it up on the controller's next poll.",
        TOAST
      );
      return invalidate();
    },
  });
}

export function useDeleteScalingPolicy(project_id: string) {
  const invalidate = useInvalidateScaling(project_id);
  return useMutation({
    mutationFn: () =>
      apiCall<ScalingDeleteResponse>(() => forgeAuthApi.projects[project_id]!.scaling.delete()),
    onSuccess: () => {
      toast.success(
        'Scaling policy deleted. Agents keep their current replicas until the next reload.',
        TOAST
      );
      return invalidate();
    },
  });
}
