import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, CloudUploadIcon, Loader2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';

import type {
  ProjectWorkflowDesign,
  ProjectWorkflowSummary,
  WorkflowStatus,
} from '@cc-forge/api/workflows';

import { Button } from '@repo/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { EmulationPolicyBar } from '@/modules/deploy/components/emulation-policy-bar';
import { EmulationStage } from '@/modules/deploy/components/emulation-stage';
import { toEmulationGraph } from '@/modules/deploy/deploy.emulation';
import { deployErrorFor } from '@/modules/deploy/deploy.errors';
import { useTriggerDeploy } from '@/modules/deploy/deploy.mutations';
import { projectDeploySummaryQueryOptions } from '@/modules/deploy/deploy.queries';
import { PRIORITY_DEFAULT } from '@/modules/deploy/deploy.scaling-plan';
import { STARTING_CONFIG_FIELDS } from '@/modules/deploy/deploy.starting-config';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import { Route as deployPerformanceRoute } from '@/routes/_authenticated/projects/$project_id/deploy/performance';
import type { EmulationGraph, EmulationPolicy } from '@/modules/deploy/deploy.emulation';
import type { StartingConfigInput } from '@/modules/deploy/deploy.starting-config';

/** The policy an emulation falls back to when the reader arrives without one from the policy screen. */
const FALLBACK_POLICY: EmulationPolicy = {
  expected_load: 300,
  load_unit: 'minute',
  priority: PRIORITY_DEFAULT,
  llm_endpoint: 'bedrock',
};

/**
 * The same arriving traffic through one workflow, scheduled two ways.
 *
 * Open to every project, not only one on its way to a first deploy: the question it answers — would
 * this policy hold — is worth asking again after a project is live, and the answer does not depend on
 * anything the project has actually run.
 *
 * The policy arrives in the URL from the screen that set it, so the run is linkable and survives a
 * reload. Without one it starts from a stated default rather than guessing at the project.
 */
export function DeployPerformanceScreen({ project_id }: { readonly project_id: string }) {
  const search = deployPerformanceRoute.useSearch();
  // Memoised on the four values it is built from, not rebuilt per render. The panes restart their run
  // when what they were handed changes identity, and this screen re-renders for reasons that have
  // nothing to do with the policy — naming a fleet, a query revalidating — each of which would
  // otherwise cut the run short of its cycle.
  const baseline: EmulationPolicy = useMemo(
    () => ({
      expected_load: search.load ?? FALLBACK_POLICY.expected_load,
      load_unit: search.unit ?? FALLBACK_POLICY.load_unit,
      priority: search.priority ?? FALLBACK_POLICY.priority,
      llm_endpoint: search.endpoint ?? FALLBACK_POLICY.llm_endpoint,
    }),
    [search.load, search.unit, search.priority, search.endpoint]
  );

  const [policy, setPolicy] = useState<EmulationPolicy>(baseline);
  // The fleet the run settled on, which appears once it has. Cleared on every restart, because a
  // fleet read off the old policy would sit under a run of the new one.
  const [fleet, setFleet] = useState<StartingConfigInput | null>(null);
  // Bumped on every edit so both lanes start over: a run carrying history across a change of load
  // would be showing two policies at once.
  const [run_key, setRunKey] = useState(0);
  const restart = (next: EmulationPolicy) => {
    setPolicy(next);
    setFleet(null);
    setRunKey((key) => key + 1);
  };

  const deployMutation = useTriggerDeploy(project_id);
  const summary_query = useQuery({ ...projectDeploySummaryQueryOptions(project_id), retry: false });
  const workflows_query = useQuery({
    queryKey: projectQueryKeys.workflows(project_id),
    queryFn: () =>
      apiCall<ProjectWorkflowSummary[]>(() => forgeAuthApi.projects[project_id]!.workflows.get()),
    retry: false,
    // A project reaches this screen straight off an import, while its design is still being made.
    // Ask again until it is ready rather than deciding once, on the way in, that the project has no
    // workflow to send traffic down.
    refetchInterval: (query) => (isGenerating(query.state.data?.[0]?.status) ? 1_500 : false),
  });
  const workflow = workflows_query.data?.[0];
  const design_query = useQuery({
    queryKey: projectQueryKeys.workflowDesign(project_id, workflow?.id ?? ''),
    queryFn: () =>
      apiCall<ProjectWorkflowDesign>(() =>
        forgeAuthApi.projects[project_id]!.workflows[workflow!.id]!.design.get()
      ),
    // The API refuses the design of a workflow that has not got one, so the request waits for the
    // status that says it has. Retries are the default ones: a design that is there and did not
    // arrive is worth asking for again.
    enabled: workflow?.status === 'READY',
  });

  // Memoised on the design, not rebuilt per render. The panes restart their run when the graph they
  // were handed changes identity, and this screen re-renders for reasons that have nothing to do with
  // the workflow — naming a fleet, a query revalidating — each of which would otherwise throw the
  // animation back to zero.
  const graph = useMemo(
    () => (design_query.data ? toEmulationGraph(design_query.data) : null),
    [design_query.data]
  );
  // Only a project still on its way to a first deploy has a next step to be sent to.
  const in_upload_flow = summary_query.data !== undefined && summary_query.data.latest === null;

  return (
    <main className="flex flex-col gap-6 p-7" data-testid="deploy-performance-screen">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
            Emulate
          </h1>
          <p className="text-muted-foreground text-sm">
            The same arriving traffic through your workflow, scheduled two ways. Simulated from the
            policy below — nothing here is measured.
          </p>
        </div>

        {/* The way on lives here, because this is where a policy gets read. A project that has never
            run deploys the fleet this run worked out; one that has run reviews what would change,
            which is where its baseline diff is. Deploy waits for the fleet — there is nothing to
            deploy until the emulation has named one. */}
        {in_upload_flow ? (
          <div className="flex flex-col items-end gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={fleet === null || deployMutation.isPending}
              onClick={() => deployMutation.mutate()}
              data-testid="emulation-deploy"
            >
              <CloudUploadIcon aria-hidden />
              Deploy
            </Button>
            {fleet === null ? (
              <span className="text-muted-foreground text-[0.6875rem]">
                Waiting for the emulation to settle
              </span>
            ) : null}
          </div>
        ) : summary_query.data === undefined ? null : (
          <Button size="sm" asChild>
            <Link
              to="/projects/$project_id/deploy/preview"
              params={{ project_id }}
              data-testid="emulation-review"
            >
              <CloudUploadIcon aria-hidden />
              Review changes
            </Link>
          </Button>
        )}
      </header>

      <EmulationPolicyBar
        policy={policy}
        baseline={baseline}
        onChange={restart}
        onReset={() => restart(baseline)}
      />

      <div className="flex min-w-0 flex-col gap-4" data-testid="deploy-emulation">
        <EmulationPanel
          workflow={{
            status: workflow?.status,
            is_pending: workflows_query.isPending,
            is_error: workflows_query.isError,
            retry: () => void workflows_query.refetch(),
          }}
          design={{
            graph,
            is_pending: design_query.isPending,
            is_error: design_query.isError,
            retry: () => void design_query.refetch(),
          }}
          policy={policy}
          baseline={baseline}
          run_key={run_key}
          onSettled={setFleet}
        />
      </div>

      {fleet === null ? null : <InitialFleetFold fleet={fleet} />}

      {deployMutation.isError ? (
        <p className="text-destructive text-sm" role="alert" data-testid="emulation-deploy-error">
          {deployErrorFor(deployMutation.error)}
        </p>
      ) : null}
    </main>
  );
}

/** A workflow whose design is on its way, which is what a freshly imported project arrives as. */
function isGenerating(status: WorkflowStatus | undefined): boolean {
  return status === 'PENDING' || status === 'GENERATING';
}

/**
 * The emulation, or the reason there is not one yet.
 *
 * Each way of having no picture is answered on its own. A design still being generated is not a
 * project without a workflow, and neither is a design the browser failed to fetch — all three used
 * to read as "no workflow was detected", and the last two never recovered from it.
 */
function EmulationPanel({
  workflow,
  design,
  policy,
  baseline,
  run_key,
  onSettled,
}: {
  readonly workflow: {
    readonly status: WorkflowStatus | undefined;
    readonly is_pending: boolean;
    readonly is_error: boolean;
    readonly retry: () => void;
  };
  readonly design: {
    readonly graph: EmulationGraph | null;
    readonly is_pending: boolean;
    readonly is_error: boolean;
    readonly retry: () => void;
  };
  readonly policy: EmulationPolicy;
  readonly baseline: EmulationPolicy;
  readonly run_key: number;
  readonly onSettled: (fleet: StartingConfigInput) => void;
}) {
  if (workflow.is_pending) return <EmulationWaiting message="Analyzing workflow…" />;

  if (workflow.is_error) {
    return (
      <QueryError
        message="Could not load this project's workflows."
        onRetry={workflow.retry}
        test_id="deploy-emulation-workflows-error"
      />
    );
  }

  if (isGenerating(workflow.status)) {
    return (
      <EmulationWaiting
        message="Preparing this project's workflow design…"
        test_id="deploy-emulation-generating"
      />
    );
  }

  if (workflow.status === 'FAILED') {
    return (
      <EmptyState size="section" test_id="deploy-emulation-failed">
        <p>
          This workflow&rsquo;s design could not be generated, so there is no path to send traffic
          down.
        </p>
      </EmptyState>
    );
  }

  if (workflow.status === 'READY') {
    if (design.is_pending) return <EmulationWaiting message="Analyzing workflow…" />;
    if (design.is_error) {
      return (
        <QueryError
          message="Could not load this workflow's design."
          onRetry={design.retry}
          test_id="deploy-emulation-design-error"
        />
      );
    }
  }

  // No workflow at all, and a design with nothing in it, are the same answer to the reader.
  if (design.graph === null) {
    return (
      <EmptyState size="section" test_id="deploy-emulation-empty">
        <p>No workflow was detected in this project, so there is no path to send traffic down.</p>
      </EmptyState>
    );
  }

  return (
    <EmulationStage
      graph={design.graph}
      policy={policy}
      baseline={baseline}
      run_key={run_key}
      onSettled={onSettled}
    />
  );
}

function EmulationWaiting({
  message,
  test_id = 'deploy-emulation-loading',
}: {
  readonly message: string;
  readonly test_id?: string;
}) {
  return (
    <div className="flex min-h-64 items-center justify-center" data-testid={test_id}>
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        {message}
      </p>
    </div>
  );
}

/**
 * The fleet the run worked out, folded away under the picture.
 *
 * Closed by default: the number a reader wants is usually none of them — they watched the emulation,
 * they are satisfied, they deploy. Opening it is for the reader who wants to check before they do.
 */
function InitialFleetFold({ fleet }: { readonly fleet: StartingConfigInput }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border bg-card rounded-2xl border shadow-xs"
      data-testid="emulation-fleet"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/40 flex w-full items-center gap-2.5 rounded-2xl px-4 py-3 text-left transition-colors"
          data-testid="emulation-fleet-toggle"
        >
          <ChevronRightIcon
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 transition-transform duration-150',
              open && 'rotate-90'
            )}
            strokeWidth={2.2}
            aria-hidden
          />
          <span className="text-foreground min-w-0 flex-1 truncate text-[0.8125rem] font-bold">
            Initial deployment config
          </span>
          <span className="text-muted-foreground shrink-0 font-mono text-[0.75rem] tabular-nums">
            {fleet.starting_cpu_instances} CPU · {fleet.starting_gpu_instances} GPU
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <dl className="border-border/70 grid grid-cols-2 gap-x-6 gap-y-3 border-t px-4 py-3.5 sm:grid-cols-4">
          {STARTING_CONFIG_FIELDS.map((field) => (
            <div key={field.name} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-muted-foreground text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">
                {field.label}
              </dt>
              <dd className="text-foreground font-mono text-[0.875rem] font-semibold tabular-nums">
                {fleet[field.name]}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground border-border/70 border-t px-4 py-3 text-[0.71875rem]">
          Worked out from the blocks CanyonOS stacked in this run, with headroom over what it
          needed. Change it on the Deployment Config screen.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
