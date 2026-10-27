// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2Icon } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MonitoringEndpoint, MonitoringEndpointResponse } from '@canyonos/api/monitoring';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@repo/ui/shadcn/alert-dialog';
import { Button } from '@repo/ui/shadcn/button';
import { cardVariants } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { toast } from '@repo/ui/shadcn/sonner';
import { cn } from '@repo/ui/utils';
import { ApiResponseError } from '@/api';
import { ContainersSection } from '@/modules/monitoring/components/containers-section';
import {
  endpointQueryOptions,
  errorSummaryQueryOptions,
  replicasQueryOptions,
} from '@/modules/monitoring/monitoring.queries';
import { projectDetailQueryOptions, useDeleteProject } from '@/modules/projects/projects.queries';

const CARD = cardVariants({ className: 'min-w-0 p-5' });
const TOAST = { testId: 'app-toast', position: 'top-center' } as const;

type Deployment = 'checking' | 'running' | 'not_running' | 'unknown';

function deploymentOf(endpoint: UseQueryResult<MonitoringEndpointResponse>): Deployment {
  if (endpoint.isPending) return 'checking';
  if (endpoint.isSuccess) return 'running';
  const is_not_running =
    endpoint.error instanceof ApiResponseError &&
    endpoint.error.code === 'canyonos.project_not_running';
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
  const endpoint = useQuery(endpointQueryOptions(project_id));
  const replicas_query = useQuery(replicasQueryOptions(project_id));
  const errors = useQuery(errorSummaryQueryOptions(project_id, { range: { preset: '24h' } }));

  const deployment = deploymentOf(endpoint);
  // Agent replicas also run calls, but each one serves an endpoint request already counted.
  const endpoint_agent = endpoint.data?.endpoint?.agent;
  const endpoint_requests = readout(replicas_query, ({ replicas }) =>
    replicas
      .filter((replica) => replica.agent === endpoint_agent)
      .reduce((total, replica) => total + (replica.active_requests ?? 0), 0)
  );
  const active_requests = deployment === 'checking' ? undefined : endpoint_requests;

  return (
    <main className="flex min-h-full shrink-0 flex-col gap-7 p-7" data-testid="status-screen">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          {project.data?.name ?? 'Status'}
        </h1>
        <StatusBadge deployment={deployment} />
        <DeleteProjectButton
          project_id={project_id}
          name={project.data?.name}
          deployment={deployment}
        />
      </header>

      <EndpointCard deployment={deployment} endpoint={endpoint.data?.endpoint} />

      <section
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="status-summary"
      >
        <StatusTile
          test_id="status-tile-replicas"
          label="Replicas serving"
          value={readout(
            replicas_query,
            ({ replicas }) => replicas.filter((replica) => !replica.draining).length
          )}
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

function DeleteProjectButton({
  project_id,
  name,
  deployment,
}: {
  readonly project_id: string;
  readonly name: string | undefined;
  readonly deployment: Deployment;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto text-xs"
          data-testid="status-delete-project"
        >
          <Trash2Icon aria-hidden />
          Delete project
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent data-testid="status-delete-dialog">
        <DeleteProjectDialog
          project_id={project_id}
          name={name ?? 'this project'}
          deployment={deployment}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Mounted by the dialog while it is open, so each opening starts from a fresh mutation.
function DeleteProjectDialog({
  project_id,
  name,
  deployment,
}: {
  readonly project_id: string;
  readonly name: string;
  readonly deployment: Deployment;
}) {
  const navigate = useNavigate();
  const remove = useDeleteProject(project_id);

  if (deployment === 'running') {
    return (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>{name} is still running</AlertDialogTitle>
          <AlertDialogDescription>
            Run <code>canyonos quit</code> in its folder, then delete it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button size="sm" variant="outline">
              Close
            </Button>
          </AlertDialogCancel>
        </AlertDialogFooter>
      </>
    );
  }

  const destroy = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success('Project deleted.', TOAST);
        void navigate({ to: '/' });
      },
    });

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
        <AlertDialogDescription>
          This removes the project and all its telemetry from the dashboard. This can&apos;t be
          undone.
        </AlertDialogDescription>
        <DeleteError message={remove.error?.message} />
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel asChild>
          <Button size="sm" variant="outline" disabled={remove.isPending}>
            Cancel
          </Button>
        </AlertDialogCancel>
        <Button
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          onClick={destroy}
          data-testid="status-delete-confirm"
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function DeleteError({ message }: { readonly message: string | undefined }) {
  if (!message) return null;

  return (
    <p className="text-destructive text-sm" role="alert" data-testid="status-delete-error">
      {message}
    </p>
  );
}

const ENDPOINT_MESSAGES: Record<Deployment, string> = {
  checking: 'Looking up the endpoint…',
  running: 'No endpoint reported yet.',
  not_running: 'Deploy the project to get an endpoint.',
  unknown: 'Could not read the endpoint.',
};

function EndpointCard({
  deployment,
  endpoint,
}: {
  readonly deployment: Deployment;
  readonly endpoint: MonitoringEndpoint | null | undefined;
}) {
  if (!endpoint) {
    return (
      <section className={CARD} data-testid="status-endpoint">
        <h2 className="text-foreground text-sm font-semibold">Endpoint</h2>
        <p className="text-muted-foreground mt-3 text-sm" data-testid="status-endpoint-message">
          {ENDPOINT_MESSAGES[deployment]}
        </p>
      </section>
    );
  }

  const { url, status_url, example_body } = endpoint;
  return (
    <section className={CARD} data-testid="status-endpoint">
      <h2 className="text-foreground text-sm font-semibold">Endpoint</h2>
      <p
        className="text-foreground mt-3 font-mono text-sm select-all"
        data-testid="status-endpoint-url"
      >
        {url}
      </p>
      <p className="text-muted-foreground mt-4 text-xs">Query the endpoint</p>
      <pre
        className="bg-muted/50 mt-1.5 overflow-x-auto rounded-lg p-3 font-mono text-xs"
        data-testid="status-endpoint-curl"
      >
        {`curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(example_body)}'`}
      </pre>
      <p className="text-muted-foreground mt-4 text-xs">Check a request&apos;s result</p>
      <pre
        className="bg-muted/50 mt-1.5 overflow-x-auto rounded-lg p-3 font-mono text-xs"
        data-testid="status-endpoint-status-curl"
      >
        {`curl ${status_url}/<request_id>`}
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
