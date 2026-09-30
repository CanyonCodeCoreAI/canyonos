import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useReducer } from 'react';
import type { Dispatch } from 'react';

import type { ScalingResponse } from '@canyonos/api/scaling';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/shadcn/dropdown-menu';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  freeAgents,
  reduceScalingDrafts,
  scalingScreenState,
} from '@/modules/scaling/scaling-drafts';
import {
  DraftPolicyCard,
  InvalidPolicyCard,
  POLICY_KINDS,
  SavedPolicyCard,
} from '@/modules/scaling/scaling-policy-card';
import { scalingQueryOptions } from '@/modules/scaling/scaling.queries';
import type {
  ScalingDraft,
  ScalingDraftsAction,
  ScalingPolicyKind,
  ScalingScreenState,
} from '@/modules/scaling/scaling-drafts';

const NO_DRAFTS: readonly ScalingDraft[] = [];

export function ScalingScreen({ project_id }: { readonly project_id: string }) {
  const [drafts, dispatch] = useReducer(reduceScalingDrafts, NO_DRAFTS);
  const query = useQuery(scalingQueryOptions(project_id));
  const state = scalingScreenState(
    { data: query.data, error: query.error, is_fetching: query.isFetching },
    drafts
  );

  return (
    <main
      className="scroll-area flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-7"
      data-testid="scaling-screen"
      data-state={state.status}
      data-project-id={project_id}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Scaling
        </h1>
        <AddPolicyMenu state={state} drafts={drafts} dispatch={dispatch} />
      </header>
      <ScalingBody
        project_id={project_id}
        state={state}
        drafts={drafts}
        dispatch={dispatch}
        onRetry={() => void query.refetch()}
      />
    </main>
  );
}

function AddPolicyMenu({
  state,
  drafts,
  dispatch,
}: {
  readonly state: ScalingScreenState;
  readonly drafts: readonly ScalingDraft[];
  readonly dispatch: Dispatch<ScalingDraftsAction>;
}) {
  const has_free_agent = 'response' in state && freeAgents(state.response, drafts).length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add policy"
          title={has_free_agent ? undefined : 'Every running agent already has a policy'}
          disabled={!has_free_agent}
          data-testid="scaling-add-policy"
          className="border-border/70 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground flex size-9 items-center justify-center rounded-[0.5rem] border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon className="size-4" strokeWidth={2.2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {Object.entries(POLICY_KINDS).map(([kind, { label }]) => (
          <DropdownMenuItem
            key={kind}
            data-testid={`scaling-add-${kind}`}
            onSelect={() =>
              dispatch({ type: 'add', id: crypto.randomUUID(), kind: kind as ScalingPolicyKind })
            }
          >
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScalingBody({
  project_id,
  state,
  drafts,
  dispatch,
  onRetry,
}: {
  readonly project_id: string;
  readonly state: ScalingScreenState;
  readonly drafts: readonly ScalingDraft[];
  readonly dispatch: Dispatch<ScalingDraftsAction>;
  readonly onRetry: () => void;
}) {
  switch (state.status) {
    case 'loading':
      return <ScalingLoading />;
    case 'error':
      return (
        <QueryError
          message={state.message}
          onRetry={onRetry}
          test_id="scaling-error"
          retry_test_id="scaling-retry"
        />
      );
    case 'empty':
      return <EmptyState test_id="scaling-empty">No scaling policies yet.</EmptyState>;
    case 'list':
      return (
        <ScalingList
          project_id={project_id}
          response={state.response}
          drafts={drafts}
          dispatch={dispatch}
        />
      );
  }
}

function ScalingLoading() {
  return (
    <div className="grid gap-5 md:grid-cols-2" aria-busy="true" data-testid="scaling-loading">
      <Skeleton className="h-52 w-full rounded-[1.125rem]" />
      <Skeleton className="h-52 w-full rounded-[1.125rem]" />
    </div>
  );
}

function ScalingList({
  project_id,
  response,
  drafts,
  dispatch,
}: {
  readonly project_id: string;
  readonly response: ScalingResponse;
  readonly drafts: readonly ScalingDraft[];
  readonly dispatch: Dispatch<ScalingDraftsAction>;
}) {
  const saved = Object.entries(response.policies).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const invalid = [...response.invalid].sort((left, right) => left.localeCompare(right));

  return (
    <div className="grid gap-5 md:grid-cols-2" data-testid="scaling-list">
      {saved.map(([agent_name, policy]) => (
        <SavedPolicyCard
          key={agent_name}
          project_id={project_id}
          agent_name={agent_name}
          policy={policy}
        />
      ))}
      {invalid.map((agent_name) => (
        <InvalidPolicyCard key={agent_name} project_id={project_id} agent_name={agent_name} />
      ))}
      {drafts.map((draft) => (
        <DraftPolicyCard
          key={draft.id}
          project_id={project_id}
          draft={draft}
          response={response}
          drafts={drafts}
          dispatch={dispatch}
        />
      ))}
    </div>
  );
}
