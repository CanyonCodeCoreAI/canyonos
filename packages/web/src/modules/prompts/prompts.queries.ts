import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  Prompt,
  PromptListItem,
  SystemPrompt,
  SystemPromptCreate,
} from '@canyonos/api/prompts';

import { apiCall, forgeAuthApi } from '@/api';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

const ERROR_MESSAGES: Record<string, string> = {
  'canyonos.project_not_running': 'This project is not running, so its prompts cannot be read.',
  'canyonos.controller_unreachable': 'The running controller could not be reached.',
};

/** What to tell the reader about a failed prompt read: the known causes by name, else `fallback`. */
export function promptErrorMessage(
  error: (Error & { readonly code?: string }) | null,
  fallback: string
): string {
  return ERROR_MESSAGES[error?.code ?? ''] ?? fallback;
}

export const promptsQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: projectQueryKeys.prompts(project_id),
    queryFn: () =>
      apiCall<PromptListItem[]>(() => forgeAuthApi.projects[project_id]!.prompts.get()),
    retry: false,
  });

export const promptQueryOptions = (project_id: string, name: string) =>
  queryOptions({
    queryKey: projectQueryKeys.prompt(project_id, name),
    queryFn: () => apiCall<Prompt>(() => forgeAuthApi.projects[project_id]!.prompts[name]!.get()),
    retry: false,
  });

export function useCreateSystemPrompt(project_id: string, name: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: (body: SystemPromptCreate) =>
      apiCall<SystemPrompt>(() =>
        forgeAuthApi.projects[project_id]!.prompts[name]!.versions.post(body)
      ),
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: projectQueryKeys.prompt(project_id, name) }),
  });
}

export function useMakePromptLive(project_id: string, name: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: (version: string) =>
      apiCall<PromptListItem>(() =>
        forgeAuthApi.projects[project_id]!.prompts[name]!.live.put({ version })
      ),
    // The listing carries each prompt's live version too, so both reads are stale.
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: projectQueryKeys.prompts(project_id) }),
  });
}
