import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';

import type {
  ScalingAgent,
  ScalingAgentsResponse,
  ScalingMetric,
  ScalingStatus,
} from '@canyonos/api/scaling';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { TooltipProvider } from '@repo/ui/shadcn/tooltip';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { DASHBOARD_POLL_INTERVAL_MS } from '@/modules/projects/projects.query-cache';
import { ScalingPolicyCard } from '@/modules/scaling/scaling-policy-card';
import {
  scalingAgentsQueryOptions,
  scalingErrorMessage,
  scalingQueryOptions,
} from '@/modules/scaling/scaling.queries';

type ReadState = 'loading' | 'error' | 'ready';

// A retry after an error is a fresh load, not the old error.
function readState(query: { isError: boolean; isFetching: boolean; data: unknown }): ReadState {
  if (query.isError && !query.isFetching) return 'error';
  if (query.data === undefined) return 'loading';
  return 'ready';
}

export function ScalingScreen({ project_id }: { readonly project_id: string }) {
  const query = useQuery(scalingQueryOptions(project_id));

  return (
    <main
      className="scroll-area flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-7"
      data-testid="scaling-screen"
      data-state={readState(query)}
      data-project-id={project_id}
    >
      <header className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Scaling
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm" data-testid="scaling-scope">
          One policy for the whole workflow. Each agent is measured on its own load and adds or
          removes its own replicas. The workflow container is never scaled.
        </p>
      </header>
      <ScalingBody project_id={project_id} query={query} />
    </main>
  );
}

function ScalingBody({
  project_id,
  query,
}: {
  readonly project_id: string;
  readonly query: UseQueryResult<ScalingStatus, Error>;
}) {
  if (query.isError && !query.isFetching) {
    return (
      <QueryError
        className="max-w-3xl"
        message={scalingErrorMessage(query.error, 'Could not load the policy.')}
        onRetry={() => void query.refetch()}
        test_id="scaling-error"
        retry_test_id="scaling-retry"
      />
    );
  }
  if (query.data === undefined) {
    return (
      <div className="flex flex-col gap-7" aria-busy="true" data-testid="scaling-loading">
        <Skeleton className="h-44 w-full max-w-3xl rounded-[1.125rem]" />
        <Skeleton className="h-40 w-full max-w-3xl rounded-[1.125rem]" />
      </div>
    );
  }
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex max-w-3xl flex-col gap-7">
        {/* Keyed on the stored policy: a save or delete re-reads it and remounts the card closed. */}
        <ScalingPolicyCard
          key={JSON.stringify(query.data)}
          project_id={project_id}
          policy={query.data}
        />
        <ScalingAgents project_id={project_id} policy={query.data} />
      </div>
    </TooltipProvider>
  );
}

const POLL_SECONDS = DASHBOARD_POLL_INTERVAL_MS / 1000;

function agentsState(state: ReadState, data: ScalingAgentsResponse | undefined) {
  if (state !== 'ready' || data === undefined) return state;
  return data.agents.length === 0 ? 'empty' : 'list';
}

/** What each agent is running right now, polled, so a saved policy can be seen taking effect. */
function ScalingAgents({
  project_id,
  policy,
}: {
  readonly project_id: string;
  readonly policy: ScalingStatus;
}) {
  const query = useQuery(scalingAgentsQueryOptions(project_id));
  const state = readState(query);
  const metric = policy.status === 'applied' ? policy.policy.metric : null;

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Agents"
      data-testid="scaling-agents"
      data-state={agentsState(state, query.data)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-foreground text-sm font-semibold">Agents now</h2>
        <p className="text-muted-foreground text-xs">
          Replicas move one at a time, after ten steady measurements. Updated every {POLL_SECONDS}{' '}
          seconds.
        </p>
      </div>
      <ScalingAgentsBody query={query} metric={metric} />
    </section>
  );
}

function ScalingAgentsBody({
  query,
  metric,
}: {
  readonly query: UseQueryResult<ScalingAgentsResponse, Error>;
  readonly metric: ScalingMetric | null;
}) {
  if (query.isError && !query.isFetching) {
    return (
      <QueryError
        message={scalingErrorMessage(query.error, 'Could not load the agents.')}
        onRetry={() => void query.refetch()}
        test_id="scaling-agents-error"
        retry_test_id="scaling-agents-retry"
      />
    );
  }
  if (query.data === undefined) {
    return (
      <Skeleton
        className="h-32 w-full rounded-[1.125rem]"
        aria-busy="true"
        data-testid="scaling-agents-loading"
      />
    );
  }
  if (query.data.agents.length === 0) {
    return (
      <EmptyState size="section" test_id="scaling-agents-empty">
        The controller has not published any agents yet.
      </EmptyState>
    );
  }
  return <AgentsTable agents={query.data.agents} metric={metric} />;
}

const COLUMNS: readonly { readonly metric: ScalingMetric; readonly label: string }[] = [
  { metric: 'requests_per_minute_per_replica', label: 'Throughput' },
  { metric: 'queue_length_total', label: 'Queue' },
];

function AgentsTable({
  agents,
  metric,
}: {
  readonly agents: readonly ScalingAgent[];
  readonly metric: ScalingMetric | null;
}) {
  return (
    <div className="border-border/70 bg-card overflow-hidden rounded-[1.125rem] border shadow-xs">
      <table className="w-full text-sm" data-testid="scaling-agents-table">
        <thead>
          <tr className="text-muted-foreground border-border/60 border-b text-left text-[0.6875rem] font-semibold tracking-wide uppercase">
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Agent
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Replicas
            </th>
            {COLUMNS.map((column) => (
              <th
                key={column.metric}
                scope="col"
                className="px-4 py-2.5 text-right font-semibold"
                data-watched={column.metric === metric}
                data-testid={`scaling-agents-column-${column.metric}`}
              >
                <MetricHeading label={column.label} watched={column.metric === metric} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <AgentRow key={agent.name} agent={agent} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricHeading({ label, watched }: { readonly label: string; readonly watched: boolean }) {
  if (!watched) return <>{label}</>;
  return (
    <span className="text-foreground inline-flex items-center gap-1.5">
      <span className="bg-primary size-1.5 rounded-full" aria-hidden />
      {label}
      <span className="sr-only">, watched by the policy</span>
    </span>
  );
}

function AgentRow({ agent }: { readonly agent: ScalingAgent }) {
  const moving = agent.replicas_running !== agent.replicas_expected;
  return (
    <tr
      className="border-border/50 border-b last:border-b-0"
      data-testid="scaling-agent"
      data-agent={agent.name}
    >
      <th
        scope="row"
        className="text-foreground px-4 py-2.5 text-left font-mono text-xs font-semibold"
      >
        {agent.name}
      </th>
      <td className="px-4 py-2.5">
        <span
          className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums"
          data-testid="scaling-agent-replicas"
          data-moving={moving}
        >
          {agent.replicas_running}
          <ReplicasTarget agent={agent} />
        </span>
      </td>
      <td className="text-foreground px-4 py-2.5 text-right font-mono text-xs tabular-nums">
        <Load value={agent.load?.requests_per_minute_per_replica ?? null} digits={1} />
      </td>
      <td className="text-foreground px-4 py-2.5 text-right font-mono text-xs tabular-nums">
        <Load value={agent.load?.queue_length_total ?? null} digits={0} />
      </td>
    </tr>
  );
}

/** Shown only while the controller is still getting to the count it is heading to. */
function ReplicasTarget({ agent }: { readonly agent: ScalingAgent }) {
  if (agent.replicas_running === agent.replicas_expected) return null;
  return (
    <span className="text-primary inline-flex items-center gap-1">
      <ArrowRightIcon className="size-3" aria-hidden />
      <span className="sr-only">heading to </span>
      {agent.replicas_expected}
    </span>
  );
}

function Load({ value, digits }: { readonly value: number | null; readonly digits: number }) {
  if (value === null) {
    return (
      <span className="text-muted-foreground">
        –<span className="sr-only">no measurement yet</span>
      </span>
    );
  }
  return <>{value.toFixed(digits)}</>;
}
