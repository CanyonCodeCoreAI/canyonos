import { Link } from '@tanstack/react-router';
import { shallowEqual, useSelector } from '@xstate/react';
import { AlertTriangleIcon, CheckIcon, RotateCcwIcon, ScrollTextIcon, XIcon } from 'lucide-react';
import { useMemo } from 'react';

import type { DeployConfig } from '@canyonos/api/deploy';

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/shadcn/alert';
import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { Card } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { Progress } from '@repo/ui/shadcn/progress';
import { cn } from '@repo/ui/utils';
import { DEPLOY_STAGES, statusToCursor } from '@/modules/deploy/deploy.lifecycle';
import { deriveDeployProgress } from '@/modules/deploy/deploy.progress';
import type { DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';
import type {
  DeployPhase,
  DeployProgressView,
  DeployStageStatus,
  DeployStageView,
} from '@/modules/deploy/deploy.progress';

export function DeployProgressScreen({ actorRef }: { actorRef: DeployStatusMachineActorRef }) {
  const { status, failed, reconnecting, errorMessage, config, project_id } = useSelector(
    actorRef,
    (state) => ({
      status: state.context.status,
      failed: state.matches('failed'),
      reconnecting: state.context.reconnecting && state.matches('running'),
      errorMessage: state.context.errorMessage,
      config: state.context.config,
      project_id: state.context.project_id,
    }),
    shallowEqual
  );

  const cursor = statusToCursor(status);
  const progress = useMemo(
    () => deriveDeployProgress(DEPLOY_STAGES, cursor, failed),
    [cursor, failed]
  );

  // The machine only routes here after `loadDeploy` resolved, so the config is always present.
  if (!config) return null;

  return (
    <main
      className="flex min-h-0 flex-1 flex-col px-7 pt-6 pb-16"
      data-testid="deploy-progress-screen"
    >
      <div className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-6">
        <ProgressHero config={config} phase={progress.phase} />

        <ProgressMeter progress={progress} />

        <Card className="overflow-hidden py-0" data-testid="deploy-stages">
          <ol>
            {progress.stages.map((stage) => (
              <StageRow key={stage.status} stage={stage} />
            ))}
          </ol>
        </Card>

        {reconnecting ? (
          <p
            className="text-muted-foreground text-sm"
            role="status"
            data-testid="deploy-stream-reconnecting"
          >
            Connection lost — reconnecting…
          </p>
        ) : null}

        {failed ? (
          <FailureActions
            project_id={project_id}
            stageLabel={progress.stages[cursor]?.label ?? 'Provisioning resources'}
            message={errorMessage ?? 'The deployment failed. No resources are left running.'}
          />
        ) : null}
      </div>
    </main>
  );
}

function ProgressHero({ config, phase }: { config: DeployConfig; phase: DeployPhase }) {
  return (
    <header className="flex flex-col gap-2.5" data-testid="deploy-progress-hero">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-foreground text-[1.75rem] leading-tight font-bold tracking-tight text-balance">
          Deploying {config.project_name}
        </h1>
        <PhaseStatusBadge phase={phase} />
      </div>
      {phase === 'failed' ? (
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          The deployment didn’t finish. Open the logs for details.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          Provisioning infrastructure from setup{' '}
          <b className="text-secondary-foreground font-semibold">{config.name}</b> ·{' '}
          {config.provider_name}. This usually takes a couple of minutes.
        </p>
      )}
    </header>
  );
}

function PhaseStatusBadge({ phase }: { phase: DeployPhase }) {
  switch (phase) {
    case 'complete':
      return (
        <Badge variant="complete" data-testid="deploy-progress-status" data-phase="complete">
          <CheckIcon strokeWidth={2.6} aria-hidden />
          Live
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="failed" data-testid="deploy-progress-status" data-phase="failed">
          <AlertTriangleIcon strokeWidth={2.6} aria-hidden />
          Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="running" data-testid="deploy-progress-status" data-phase="running">
          <span
            className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
            aria-hidden
          />
          In progress
        </Badge>
      );
  }
}

const METER_TONE: Record<DeployPhase, string> = {
  running: 'bg-flow-agent',
  complete: 'bg-primary',
  failed: 'bg-destructive',
};

function ProgressMeter({ progress }: { progress: DeployProgressView }) {
  const { doneCount, totalStages, pct, elapsedLabel, phase } = progress;
  const stepSummary = `${doneCount} of ${totalStages} stages complete`;

  return (
    <div className="flex flex-col gap-2" data-testid="deploy-progress-meter">
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-foreground text-xs font-semibold">{stepSummary}</span>
        <span className="flex items-center gap-3 font-mono text-xs tabular-nums">
          <span className="text-muted-foreground">{elapsedLabel}</span>
          <span className="text-foreground font-semibold">{pct}%</span>
        </span>
      </div>
      <Progress value={pct} aria-valuetext={stepSummary} indicatorClassName={METER_TONE[phase]} />
    </div>
  );
}

const STAGE_STATE_LABEL: Record<DeployStageStatus, string> = {
  done: 'Completed',
  active: 'In progress',
  pending: 'Queued',
  failed: 'Failed',
};

const STAGE_STATE_TEXT: Record<DeployStageStatus, string> = {
  pending: 'text-muted-foreground',
  done: 'text-secondary-foreground',
  active: 'text-foreground',
  failed: 'text-destructive',
};

function StageRow({ stage }: { stage: DeployStageView }) {
  const isActive = stage.state === 'active';

  return (
    <li
      className={cn(
        'border-border/50 flex items-center gap-3 px-4.5 py-3 not-first:border-t',
        STAGE_STATE_TEXT[stage.state]
      )}
      data-testid={`deploy-stage-${stage.status}`}
      data-status={stage.state}
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        role="img"
        aria-label={STAGE_STATE_LABEL[stage.state]}
      >
        <StageIndicator state={stage.state} />
      </span>
      <span className={cn('flex-1 text-[0.84375rem]', isActive ? 'font-semibold' : 'font-medium')}>
        {stage.label}
      </span>
      <span className="text-muted-foreground shrink-0 truncate text-xs">{stage.detail}</span>
    </li>
  );
}

function StageIndicator({ state }: { state: DeployStageStatus }) {
  switch (state) {
    case 'done':
      return (
        <span className="bg-primary text-primary-foreground flex size-[1.1875rem] items-center justify-center rounded-full">
          <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
        </span>
      );
    case 'failed':
      return (
        <span className="bg-destructive text-destructive-foreground flex size-[1.1875rem] items-center justify-center rounded-full">
          <XIcon className="size-3" strokeWidth={3} aria-hidden />
        </span>
      );
    case 'active':
      return (
        <span className="border-flow-agent/25 border-t-flow-agent size-4 rounded-full border-2 motion-safe:animate-spin" />
      );
    case 'pending':
      return <span className="border-muted-foreground/25 size-3.5 rounded-full border-2" />;
    default:
      return null;
  }
}

function FailureActions({
  project_id,
  stageLabel,
  message,
}: {
  project_id: string;
  stageLabel: string;
  message: string;
}) {
  return (
    <Collapsible className="flex flex-col gap-6">
      <div
        className="flex flex-wrap items-center justify-between gap-4"
        data-testid="deploy-progress-actions"
      >
        <span className="text-destructive flex items-center gap-1.5 text-xs font-semibold">
          <AlertTriangleIcon className="size-4" strokeWidth={2.4} aria-hidden />
          Deployment failed
        </span>

        <div className="flex items-center gap-2.5">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="group"
              data-testid="deploy-view-logs"
            >
              <ScrollTextIcon aria-hidden />
              <span className="group-data-[state=open]:hidden">View logs</span>
              <span className="hidden group-data-[state=open]:inline">Hide logs</span>
            </Button>
          </CollapsibleTrigger>
          <Button asChild data-testid="deploy-again">
            <Link to="/projects/$project_id/deploy" params={{ project_id }}>
              <RotateCcwIcon aria-hidden />
              Deploy again
            </Link>
          </Button>
        </div>
      </div>

      <CollapsibleContent asChild>
        <Alert
          variant="destructive"
          data-testid="deploy-error-log"
          className="animate-in fade-in-0 slide-in-from-top-1"
        >
          <AlertTriangleIcon strokeWidth={2.2} aria-hidden />
          <AlertTitle>{stageLabel} failed</AlertTitle>
          <AlertDescription>
            <pre className="overflow-x-auto font-mono text-xs leading-relaxed">{message}</pre>
          </AlertDescription>
        </Alert>
      </CollapsibleContent>
    </Collapsible>
  );
}
