import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CloudUploadIcon } from 'lucide-react';

import type { DeploymentOverviewItem } from '@cc-forge/api/deploy';

import { SectionLabel } from '@repo/ui/components/section-label';
import { Badge } from '@repo/ui/shadcn/badge';
import { Button } from '@repo/ui/shadcn/button';
import { Card } from '@repo/ui/shadcn/card';
import { Progress } from '@repo/ui/shadcn/progress';
import {
  DEPLOY_STAGES,
  deploymentStatusLabel,
  statusToCursor,
} from '@/modules/deploy/deploy.lifecycle';
import { deriveDeployProgress } from '@/modules/deploy/deploy.progress';

interface ResumeDeployCardProps {
  readonly deployment: DeploymentOverviewItem;
}

export function ResumeDeployCard({ deployment }: ResumeDeployCardProps) {
  // Resume only ever shows for a non-terminal deploy, so the progress is driven off the same
  // lifecycle helpers as the deploy-progress screen (failed = false) to keep the step count honest.
  const cursor = statusToCursor(deployment.status);
  const progress = deriveDeployProgress(DEPLOY_STAGES, cursor, false);
  const stageLabel = deploymentStatusLabel(deployment.status);
  const detail = DEPLOY_STAGES[cursor]?.detail ?? '';
  const stepSummary = `${progress.doneCount} of ${progress.totalStages} steps complete`;

  return (
    <Card variant="elevated" data-testid="projects-overview-resume" className="gap-4 p-5">
      <div className="flex items-start gap-4">
        <span className="bg-primary/12 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl">
          <CloudUploadIcon className="size-5" strokeWidth={1.9} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <SectionLabel>Pick up where you left off</SectionLabel>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-foreground truncate text-base font-bold tracking-tight">
              {deployment.project_name}
            </span>
            <Badge variant="running">
              <span
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                aria-hidden
              />
              {stageLabel}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm text-pretty">{detail}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-secondary-foreground font-semibold tabular-nums">
            {stepSummary}
          </span>
          <span className="text-muted-foreground font-mono font-semibold tabular-nums">
            {progress.pct}%
          </span>
        </div>
        <Progress
          value={progress.pct}
          aria-valuetext={stepSummary}
          indicatorClassName="bg-flow-agent"
          data-testid="projects-overview-resume-progress"
        />
      </div>

      <div className="flex justify-end">
        <Button asChild>
          <Link
            to="/projects/$project_id/deploy/$deploy_id"
            params={{ project_id: deployment.project_id, deploy_id: deployment.id }}
            data-testid="projects-overview-resume-link"
          >
            See deploy
            <ArrowRightIcon aria-hidden />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
