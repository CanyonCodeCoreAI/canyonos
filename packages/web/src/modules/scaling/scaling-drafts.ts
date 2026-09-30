import type { ScalingResponse } from '@canyonos/api/scaling';

export type ScalingPolicyKind = 'throughput' | 'queue_length';

export interface ScalingDraft {
  readonly id: string;
  readonly kind: ScalingPolicyKind;
  readonly agent_name: string | null;
}

export type ScalingDraftsAction =
  | { readonly type: 'add'; readonly id: string; readonly kind: ScalingPolicyKind }
  | { readonly type: 'pick_agent'; readonly id: string; readonly agent_name: string }
  | { readonly type: 'discard'; readonly id: string }
  | { readonly type: 'saved'; readonly id: string };

export function reduceScalingDrafts(
  drafts: readonly ScalingDraft[],
  action: ScalingDraftsAction
): readonly ScalingDraft[] {
  switch (action.type) {
    case 'add':
      return [...drafts, { id: action.id, kind: action.kind, agent_name: null }];
    case 'pick_agent':
      // Refusing a claimed agent here keeps two drafts from saving over each other.
      if (
        drafts.some((draft) => draft.id !== action.id && draft.agent_name === action.agent_name)
      ) {
        return drafts;
      }
      return drafts.map((draft) =>
        draft.id === action.id ? { ...draft, agent_name: action.agent_name } : draft
      );
    case 'discard':
    case 'saved':
      return drafts.filter((draft) => draft.id !== action.id);
  }
}

/**
 * Running agents with no stored policy (valid or invalid) that no draft has claimed. Pass
 * `for_draft_id` to get the options of that draft: its own pick stays offered even once saved, so
 * the draft keeps showing it while the save re-reads the config.
 */
export function freeAgents(
  response: ScalingResponse,
  drafts: readonly ScalingDraft[],
  for_draft_id?: string
): string[] {
  const own_pick = drafts.find((draft) => draft.id === for_draft_id)?.agent_name;
  const claimed = new Set(drafts.map((draft) => draft.agent_name));
  const invalid = new Set(response.invalid);
  return response.agents.filter(
    (agent_name) =>
      agent_name === own_pick ||
      (!(agent_name in response.policies) && !invalid.has(agent_name) && !claimed.has(agent_name))
  );
}

export type ScalingScreenState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'empty'; readonly response: ScalingResponse }
  | { readonly status: 'list'; readonly response: ScalingResponse };

interface ScalingQuerySnapshot {
  readonly data: ScalingResponse | undefined;
  readonly error: Error | null;
  readonly is_fetching: boolean;
}

export function scalingScreenState(
  query: ScalingQuerySnapshot,
  drafts: readonly ScalingDraft[]
): ScalingScreenState {
  // A retry after an error is a fresh load, not the old error.
  if (query.error && !query.is_fetching) return { status: 'error', message: query.error.message };
  if (!query.data || query.error) return { status: 'loading' };
  const response = query.data;
  const is_empty =
    Object.keys(response.policies).length === 0 &&
    response.invalid.length === 0 &&
    drafts.length === 0;
  return { status: is_empty ? 'empty' : 'list', response };
}
