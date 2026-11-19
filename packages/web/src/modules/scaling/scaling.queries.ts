// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingResponse,
} from '@canyonos/api/scaling';

import { toast } from '@repo/ui/shadcn/sonner';
import { apiCall, canyonosAuthApi } from '@/api';
import {
  dashboardPollInterval,
  workflowQueryKeys,
} from '@/modules/workflows/workflows.query-cache';

const TOAST = { testId: 'app-toast', position: 'top-center' } as const;

const ERROR_MESSAGES: Record<string, string> = {
  'registry.workflow_not_running':
    'This workflow is not running, so its scaling policy cannot be read. Deploy it, then retry.',
  'registry.controller_unreachable':
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

export const scalingQueryOptions = (workflow_id: string) =>
  queryOptions({
    queryKey: workflowQueryKeys.scaling(workflow_id),
    queryFn: () =>
      apiCall<ScalingResponse>(() => canyonosAuthApi.workflows[workflow_id]!.scaling.get()),
    retry: false,
  });

// Polled: this is where the operator watches the replica counts move after a change.
export const scalingAgentsQueryOptions = (workflow_id: string) =>
  queryOptions({
    queryKey: workflowQueryKeys.scalingAgents(workflow_id),
    queryFn: () =>
      apiCall<ScalingAgentsResponse>(() =>
        canyonosAuthApi.workflows[workflow_id]!.scaling.agents.get()
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

// The agents key sits under the policy key, so one invalidation re-reads both.
function useInvalidateScaling(workflow_id: string) {
  const query_client = useQueryClient();
  return () => query_client.invalidateQueries({ queryKey: workflowQueryKeys.scaling(workflow_id) });
}

export function useSaveScalingPolicy(workflow_id: string) {
  const invalidate = useInvalidateScaling(workflow_id);
  return useMutation({
    mutationFn: (policy: ScalingPolicy) =>
      apiCall<ScalingPolicy>(() => canyonosAuthApi.workflows[workflow_id]!.scaling.put(policy)),
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

export function useDeleteScalingPolicy(workflow_id: string) {
  const invalidate = useInvalidateScaling(workflow_id);
  return useMutation({
    mutationFn: () =>
      apiCall<ScalingDeleteResponse>(() =>
        canyonosAuthApi.workflows[workflow_id]!.scaling.delete()
      ),
    onSuccess: () => {
      toast.success(
        'Scaling policy deleted. Agents keep their current replicas until the next reload.',
        TOAST
      );
      return invalidate();
    },
  });
}
