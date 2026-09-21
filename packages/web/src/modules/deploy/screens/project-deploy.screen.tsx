import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import type { DeployConfig } from '@canyonos/api/deploy';

import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import { ProjectDeployControls } from '@/modules/deploy/components/deploy-controls';
import { DeploySkeleton } from '@/modules/deploy/components/deploy-skeleton';
import { ScalingPlanCard } from '@/modules/deploy/components/scaling-plan-card';
import { projectDeploySummaryQueryOptions } from '@/modules/deploy/deploy.queries';
import {
  planSummary,
  SCALING_PLAN_DEFAULTS,
  ScalingPlanSchema,
} from '@/modules/deploy/deploy.scaling-plan';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { ScalingPlanInput } from '@/modules/deploy/deploy.scaling-plan';

export function ProjectDeployScreen({ project_id }: { readonly project_id: string }) {
  const config_query = useQuery({
    queryKey: projectQueryKeys.deployConfig(project_id),
    queryFn: () =>
      apiCall<DeployConfig>(() => forgeAuthApi.projects[project_id]!.deploy.config.get()),
    retry: false,
  });
  const summary_query = useQuery(projectDeploySummaryQueryOptions(project_id));

  // A run in flight owns the project, so configuring a second deploy is not a state the user can be
  // in — including when the run starts while this screen is open.
  const active_deploy = summary_query.data?.active;
  if (active_deploy) {
    return (
      <Navigate
        to="/projects/$project_id/deploy/$deploy_id"
        params={{ project_id, deploy_id: active_deploy.id }}
        replace
      />
    );
  }

  if (config_query.isPending || summary_query.isPending) {
    return <DeploySkeleton />;
  }

  if (config_query.error || !config_query.data) {
    return (
      <QueryError
        message="Could not load this deploy configuration."
        onRetry={() => void config_query.refetch()}
        className="m-7"
        test_id="deploy-config-error"
      />
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="deploy-screen">
      <DeployForm config={config_query.data} />
    </main>
  );
}

// Ties the header-docked submit button back to the form it submits.
const DEPLOY_FORM_ID = 'deploy-form';

type Analysis = 'planning' | 'ready';

function DeployForm({ config }: { config: DeployConfig }) {
  const navigate = useNavigate();

  const planForm = useForm<ScalingPlanInput>({
    resolver: zodResolver(ScalingPlanSchema),
    defaultValues: SCALING_PLAN_DEFAULTS as Partial<ScalingPlanInput>,
    mode: 'onTouched',
  });

  // A plan is only answerable once the load is set; the other three ship with an answer. The
  // serialised plan is what "set" is remembered against, so changing any answer afterwards puts the
  // reader back in front of the Set button rather than leaving a deploy offered for a stale plan.
  const parsed_plan = ScalingPlanSchema.safeParse(planForm.watch());
  const plan_signature = parsed_plan.success ? JSON.stringify(parsed_plan.data) : null;

  const [analyzed_signature, setAnalyzedSignature] = useState<string | null>(null);

  const analysis: Analysis =
    analyzed_signature !== null && analyzed_signature === plan_signature ? 'ready' : 'planning';

  // Setting the policy hands over to the emulation, whether or not this project has run before. The
  // emulation is what a policy is for: it is where the answers get read, and it is where the way on
  // sits — a deploy for a project that has never run, a review of the changes for one that has.
  const setPlan = () => {
    if (plan_signature === null || !parsed_plan.success) return;
    setAnalyzedSignature(plan_signature);
    void navigate({
      to: '/projects/$project_id/deploy/performance',
      params: { project_id: config.project_id },
      // The answers travel in the URL, so the emulation runs the policy just set rather than a
      // default, and the run stays linkable and survives a reload.
      search: {
        load: parsed_plan.data.expected_load,
        unit: parsed_plan.data.load_unit,
        priority: parsed_plan.data.priority,
        endpoint: parsed_plan.data.llm_endpoint,
      },
    });
  };

  const summary = parsed_plan.success ? planSummary(parsed_plan.data, config.provider_name) : null;

  return (
    <form
      id={DEPLOY_FORM_ID}
      // Set is the only way on, so a stray Enter in a field does the same thing rather than
      // reloading the screen.
      onSubmit={(event) => {
        event.preventDefault();
        setPlan();
      }}
      noValidate
      data-testid="deploy-form"
      className="mx-auto flex h-fit w-full max-w-[640px] flex-col gap-6 px-7 pt-6 pb-6"
    >
      <HeaderDockPortal>
        <ProjectDeployControls project_id={config.project_id} />
      </HeaderDockPortal>

      <header className="flex flex-col gap-2" data-testid="deploy-hero">
        <h1 className="text-foreground text-[1.75rem] leading-tight font-bold tracking-tight">
          Set scaling policy for {config.project_name}
        </h1>
        <p className="text-muted-foreground text-sm">
          Plan the traffic and the target. The fleet it runs on is set in Deployment Config.
        </p>
      </header>

      <ScalingPlanCard
        form={planForm}
        config={config}
        is_submitting={false}
        onSet={setPlan}
        can_set={plan_signature !== null}
        is_set={analysis === 'ready'}
      />

      <footer className="flex items-center gap-4">
        <AnalysisStatus analysis={analysis} config={config} summary={summary} />
      </footer>
    </form>
  );
}

function AnalysisStatus({
  analysis,
  config,
  summary,
}: {
  readonly analysis: Analysis;
  readonly config: DeployConfig;
  readonly summary: { readonly throughput: string; readonly detail: string } | null;
}) {
  if (analysis === 'planning') {
    return (
      <p
        className="text-muted-foreground flex items-center gap-2 text-sm"
        data-testid="deploy-status"
        data-analysis="planning"
      >
        <span className="bg-muted-foreground/50 size-2 rounded-full" aria-hidden />
        Answer the scaling policy, then choose Set.
      </p>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      data-testid="deploy-status"
      data-analysis="ready"
    >
      <p className="text-foreground flex items-center gap-2 text-sm font-semibold">
        <span className="bg-primary size-2 rounded-full" aria-hidden />
        Ready to deploy to {config.provider_name} · {summary?.throughput}
      </p>
      <p className="text-muted-foreground pl-4 text-[0.8125rem]">{summary?.detail}</p>
    </div>
  );
}
