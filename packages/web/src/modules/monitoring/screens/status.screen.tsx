import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MonitoringEndpointsResponse } from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { cn } from '@repo/ui/utils';
import { ApiResponseError } from '@/api';
import { ContainersSection } from '@/modules/monitoring/components/containers-section';
import {
  endpointsQueryOptions,
  errorSummaryQueryOptions,
  replicasQueryOptions,
} from '@/modules/monitoring/monitoring.queries';
import { projectDetailQueryOptions } from '@/modules/projects/projects.queries';

const CARD = 'border-border/70 bg-card min-w-0 rounded-[1.125rem] border p-5 shadow-xs';
// deploy() serves POST /<workflow function name> and the API does not report that name, so this
// shows the `main` entry the runtime contract and `canyonos test` both post to.
const CONVENTIONAL_WORKFLOW_ROUTE = 'main';

type Deployment = 'checking' | 'running' | 'not_running' | 'unknown';

function deploymentOf(endpoints: UseQueryResult<MonitoringEndpointsResponse>): Deployment {
  if (endpoints.isPending) return 'checking';
  if (endpoints.isSuccess) return 'running';
  const is_not_running =
    endpoints.error instanceof ApiResponseError &&
    endpoints.error.code === 'canyonos.project_not_running';
  return is_not_running ? 'not_running' : 'unknown';
}

/** A tile's number: `undefined` while it loads, `null` when its read failed. */
function readout<T>(
  query: UseQueryResult<T>,
  read: (data: T) => number
): number | null | undefined {
  if (query.isError) return null;
  return query.data === undefined ? undefined : read(query.data);
}

interface StatusScreenProps {
  readonly project_id: string;
}

export function StatusScreen({ project_id }: StatusScreenProps) {
  const project = useQuery(projectDetailQueryOptions(project_id));
  const endpoints = useQuery(endpointsQueryOptions(project_id));
  const replicas_query = useQuery(replicasQueryOptions(project_id));
  const errors = useQuery(errorSummaryQueryOptions(project_id, '1d'));

  const deployment = deploymentOf(endpoints);
  // Agent replicas also run calls, but each one serves a workflow request already counted.
  const workflows = new Set(endpoints.data?.endpoints.map((endpoint) => endpoint.name));
  const workflow_requests = readout(replicas_query, ({ replicas }) =>
    replicas
      .filter((replica) => workflows.has(replica.agent))
      .reduce((total, replica) => total + (replica.active_requests ?? 0), 0)
  );
  const active_requests = deployment === 'checking' ? undefined : workflow_requests;

  return (
    <main className="flex min-h-full shrink-0 flex-col gap-7 p-7" data-testid="status-screen">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          {project.data?.name ?? 'Status'}
        </h1>
        <StatusBadge deployment={deployment} />
      </header>

      <EndpointCard deployment={deployment} url={endpoints.data?.endpoints[0]?.url} />

      <section
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="status-summary"
      >
        <StatusTile
          test_id="status-tile-replicas"
          label="Replicas up"
          value={readout(replicas_query, ({ replicas }) => replicas.length)}
        />
        <StatusTile
          test_id="status-tile-agents"
          label="Agents"
          value={readout(
            replicas_query,
            ({ replicas }) => new Set(replicas.map((replica) => replica.agent)).size
          )}
        />
        <StatusTile test_id="status-tile-active" label="Active requests" value={active_requests} />
        <StatusTile
          test_id="status-tile-errors"
          label="Errors · 24h"
          value={readout(errors, ({ total }) => total)}
        />
      </section>

      <div className={CARD}>
        <ContainersSection project_id={project_id} />
      </div>
    </main>
  );
}

const BADGES = {
  running: { label: 'Running', tone: 'bg-primary/10 text-primary', dot: 'bg-primary' },
  not_running: {
    label: 'Not running',
    tone: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  unknown: {
    label: 'Status unknown',
    tone: 'bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
} as const;

function StatusBadge({ deployment }: { readonly deployment: Deployment }) {
  if (deployment === 'checking') return null;

  const badge = BADGES[deployment];
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        badge.tone
      )}
      data-testid="status-badge"
      data-state={deployment}
    >
      <span className={cn('size-1.5 rounded-full', badge.dot)} />
      {badge.label}
    </span>
  );
}

const ENDPOINT_MESSAGES: Record<Deployment, string> = {
  checking: 'Looking up the workflow…',
  running: 'No workflow endpoint reported yet.',
  not_running: 'Deploy the project to get an endpoint.',
  unknown: 'Could not read the workflow endpoint.',
};

function EndpointCard({
  deployment,
  url,
}: {
  readonly deployment: Deployment;
  readonly url: string | undefined;
}) {
  if (!url) {
    return (
      <section className={CARD} data-testid="status-endpoint">
        <h2 className="text-foreground text-sm font-semibold">Endpoint</h2>
        <p className="text-muted-foreground mt-3 text-sm" data-testid="status-endpoint-message">
          {ENDPOINT_MESSAGES[deployment]}
        </p>
      </section>
    );
  }

  const workflow_url = `${url}/${CONVENTIONAL_WORKFLOW_ROUTE}`;
  return (
    <section className={CARD} data-testid="status-endpoint">
      <h2 className="text-foreground text-sm font-semibold">Endpoint</h2>
      <p
        className="text-foreground mt-3 font-mono text-sm select-all"
        data-testid="status-endpoint-url"
      >
        {workflow_url}
      </p>
      <p className="text-muted-foreground mt-4 text-xs">Query the workflow</p>
      <pre
        className="bg-muted/50 mt-1.5 overflow-x-auto rounded-lg p-3 font-mono text-xs"
        data-testid="status-endpoint-curl"
      >
        {`curl -X POST ${workflow_url} \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your question here"}'`}
      </pre>
      <p className="text-muted-foreground mt-4 text-xs">Check a request&apos;s result</p>
      <pre className="bg-muted/50 mt-1.5 overflow-x-auto rounded-lg p-3 font-mono text-xs">
        {`curl ${url}/status/<request_id>`}
      </pre>
    </section>
  );
}

function StatusTile({
  label,
  value,
  test_id,
}: {
  readonly label: string;
  readonly value: number | null | undefined;
  readonly test_id: string;
}) {
  if (value === null) {
    return (
      <div className={CARD} data-testid={test_id} data-state="unavailable">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p
          className="text-muted-foreground mt-1.5 text-[1.5rem] leading-none font-bold"
          title="Could not be read"
        >
          —
        </p>
      </div>
    );
  }

  if (value === undefined) {
    return (
      <div className={CARD} data-testid={test_id} data-state="loading">
        <p className="text-muted-foreground text-xs">{label}</p>
        <Skeleton className="mt-2 h-7 w-12 rounded-md" />
      </div>
    );
  }

  return (
    <div className={CARD} data-testid={test_id} data-state="ready">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className="text-foreground mt-1.5 text-[1.5rem] leading-none font-bold tabular-nums"
        data-testid={`${test_id}-value`}
      >
        {value}
      </p>
    </div>
  );
}
