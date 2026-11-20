// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  Prompt,
  PromptListItem,
  SystemPrompt,
  SystemPromptCreate,
} from '@canyonos/api/prompts';

import { apiCall } from '@/api';
import { groupWorkflowApi } from '@/modules/workflows/workflows.queries';
import { workflowQueryKeys } from '@/modules/workflows/workflows.query-cache';

const ERROR_MESSAGES: Record<string, string> = {
  'registry.workflow_not_running': 'This workflow is not running, so its prompts cannot be read.',
  'registry.controller_unreachable': 'The running controller could not be reached.',
};

/** What to tell the reader about a failed prompt read: the known causes by name, else `fallback`. */
export function promptErrorMessage(
  error: (Error & { readonly code?: string }) | null,
  fallback: string
): string {
  return ERROR_MESSAGES[error?.code ?? ''] ?? fallback;
}

export const promptsQueryOptions = (workflow_id: string) =>
  queryOptions({
    queryKey: workflowQueryKeys.prompts(workflow_id),
    queryFn: ({ client }) =>
      apiCall<PromptListItem[]>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.prompts.get()
      ),
    retry: false,
  });

export const promptQueryOptions = (workflow_id: string, name: string) =>
  queryOptions({
    queryKey: workflowQueryKeys.prompt(workflow_id, name),
    queryFn: ({ client }) =>
      apiCall<Prompt>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.prompts[name]!.get()
      ),
    retry: false,
  });

export function useCreateSystemPrompt(workflow_id: string, name: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: (body: SystemPromptCreate, { client }) =>
      apiCall<SystemPrompt>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.prompts[name]!.versions.post(body)
      ),
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: workflowQueryKeys.prompt(workflow_id, name) }),
  });
}

export function useMakePromptLive(workflow_id: string, name: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: (version: string, { client }) =>
      apiCall<PromptListItem>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.prompts[name]!.live.put({ version })
      ),
    // The listing carries each prompt's live version too, so both reads are stale.
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: workflowQueryKeys.prompts(workflow_id) }),
  });
}
