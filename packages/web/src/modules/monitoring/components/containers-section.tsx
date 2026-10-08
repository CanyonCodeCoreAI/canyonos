import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MonitoringReplica, MonitoringReplicasResponse } from '@canyonos/api/monitoring';

import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { replicasQueryOptions } from '@/modules/monitoring/monitoring.queries';

function groupByAgent(
  replicas: readonly MonitoringReplica[]
): Map<string, readonly MonitoringReplica[]> {
  const groups = new Map<string, MonitoringReplica[]>();
  for (const replica of replicas) {
    const group = groups.get(replica.agent);
    if (group) group.push(replica);
    else groups.set(replica.agent, [replica]);
  }
  return groups;
}

export function ContainersSection({ project_id }: { readonly project_id: string }) {
  const query = useQuery(replicasQueryOptions(project_id));

  return (
    <section className="flex min-w-0 flex-col" data-testid="metrics-containers">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-foreground text-sm font-semibold">Containers</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Every replica reporting up, with the requests queued on it.
          </p>
        </div>
        <span
          className="text-foreground text-2xl font-semibold tabular-nums"
          data-testid="metrics-containers-count"
        >
          {query.data?.replicas.length}
        </span>
      </header>
      <ContainersBody query={query} />
    </section>
  );
}

function ContainersBody({ query }: { readonly query: UseQueryResult<MonitoringReplicasResponse> }) {
  if (query.isPending) return <Skeleton className="h-24 w-full rounded-lg" />;

  if (query.isError) {
    return (
      <EmptyState size="section" test_id="metrics-containers-error">
        Could not load containers.
      </EmptyState>
    );
  }

  if (query.data.replicas.length === 0) {
    return (
      <EmptyState size="section" test_id="metrics-containers-empty">
        No containers up.
      </EmptyState>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {[...groupByAgent(query.data.replicas)].map(([agent, replicas]) => (
        <li
          key={agent}
          className="grid grid-cols-[10rem_minmax(0,1fr)_2rem] items-center gap-4"
          data-testid={`metrics-containers-agent-${agent}`}
        >
          <span className="text-muted-foreground truncate text-xs">{agent}</span>
          <span className="flex flex-wrap gap-1.5">
            {replicas.map((replica) => (
              <span
                key={replica.replica}
                title={`${replica.replica}: ${replica.queue_length ?? 0} queued`}
                data-testid={`metrics-containers-replica-${replica.replica}`}
                className="bg-primary/70 text-primary-foreground dark:text-foreground flex size-8 items-center justify-center rounded-md text-xs font-medium tabular-nums"
              >
                {replica.queue_length ?? 0}
              </span>
            ))}
          </span>
          <span
            className="text-foreground text-right text-xs tabular-nums"
            data-testid={`metrics-containers-agent-count-${agent}`}
          >
            {replicas.length}
          </span>
        </li>
      ))}
    </ul>
  );
}
