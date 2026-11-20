// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type { AgentRules, GovernanceAgent, GovernanceResponse } from '@canyonos/api/governance';

import { toast } from '@repo/ui/shadcn/sonner';
import { apiCall } from '@/api';
import { groupWorkflowApi } from '@/modules/workflows/workflows.queries';
import {
  dashboardPollInterval,
  workflowQueryKeys,
} from '@/modules/workflows/workflows.query-cache';

const TOAST = { testId: 'app-toast', position: 'top-center' } as const;

const ERROR_MESSAGES: Record<string, string> = {
  'registry.workflow_not_running':
    'This workflow is not running, so its governance rules cannot be read. Deploy it, then retry.',
  'registry.controller_unreachable':
    'The running controller could not be reached. Check that it is up, then retry.',
  'governance.config_invalid':
    "The controller's governance config could not be read. Fix it and reload, then retry.",
  'governance.save_conflict':
    'Someone else saved governance rules at the same time. Retry to save on top of them.',
};

/** A known error code in the screen's words; otherwise what the API said, or the fallback. */
export function governanceErrorMessage(
  error: (Error & { readonly code?: string }) | null,
  fallback: string
): string {
  return ERROR_MESSAGES[error?.code ?? ''] ?? (error?.message || fallback);
}

// Polled: this is where the operator watches an agent go down or a cap trip.
export const governanceQueryOptions = (workflow_id: string) =>
  queryOptions({
    queryKey: workflowQueryKeys.governance(workflow_id),
    queryFn: ({ client }) =>
      apiCall<GovernanceResponse>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.governance.get()
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

function useInvalidateGovernance(workflow_id: string) {
  const query_client = useQueryClient();
  return () =>
    query_client.invalidateQueries({ queryKey: workflowQueryKeys.governance(workflow_id) });
}

export function useSaveAgentRules(workflow_id: string, agent_id: string) {
  const invalidate = useInvalidateGovernance(workflow_id);
  return useMutation({
    mutationFn: (rules: AgentRules, { client }) =>
      apiCall<GovernanceResponse>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.governance.agents[agent_id]!.put(rules)
      ),
    onSuccess: () => {
      toast.success("Governance rules saved. They apply on the controller's next poll.", TOAST);
      return invalidate();
    },
  });
}

export function useSetStopped(workflow_id: string, { agent_id, name }: GovernanceAgent) {
  const invalidate = useInvalidateGovernance(workflow_id);
  return useMutation({
    mutationFn: (stopped: boolean, { client }) =>
      apiCall<GovernanceResponse>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.governance.agents[agent_id]!.stopped.put({
          stopped,
        })
      ),
    onSuccess: (_response, stopped) => {
      toast.success(
        stopped
          ? `${name} stopped. The controller removes its replicas on its next poll.`
          : `${name} started. The controller brings its replicas back on its next poll.`,
        TOAST
      );
      return invalidate();
    },
  });
}
