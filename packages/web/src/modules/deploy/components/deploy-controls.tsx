import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ActivityIcon, CloudUploadIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DeploymentInfo } from '@cc-forge/api/deploy';

import { Button } from '@repo/ui/shadcn/button';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { deploymentStatusLabel } from '@/modules/deploy/deploy.lifecycle';
import { projectDeploySummaryQueryOptions } from '@/modules/deploy/deploy.queries';

/**
 * The deploy actions a project header offers, read from the project's deploy summary.
 *
 * A running deploy replaces every other action, so no screen can offer a second, conflicting one.
 *
 * Without `deploy_cta` the header carries the full set: a skeleton while the summary loads, the link
 * to the latest finished deploy, and the CTA into the deploy config screen.
 *
 * `deploy_cta` belongs to a screen that owns the deploy itself. It replaces everything but the
 * running deploy: no skeleton, no latest-deploy link, and no deploy at all until it returns one.
 *
 * An unreadable summary reads as no running deploy: the API's `deploy.already_running` is the guard,
 * and a header that offered nothing would leave the config screen with no way to deploy from it.
 */
export function ProjectDeployControls({
  project_id,
  deploy_cta,
}: {
  readonly project_id: string;
  readonly deploy_cta?: () => ReactNode;
}) {
  const summary_query = useQuery({
    ...projectDeploySummaryQueryOptions(project_id),
    refetchInterval: (query) => (query.state.data?.active ? 3_000 : false),
  });

  if (summary_query.isPending) {
    return deploy_cta ? null : (
      <Skeleton className="h-8 w-24 rounded-lg" data-testid="project-deploy-header-loading" />
    );
  }

  const { active = null, latest = null } = summary_query.data ?? {};
  if (active) {
    return <ActiveDeployLink project_id={project_id} deployment={active} />;
  }

  if (deploy_cta) return <>{deploy_cta()}</>;

  return (
    <>
      {latest ? <LatestDeployLink project_id={project_id} deployment={latest} /> : null}
      <DeployLink project_id={project_id} redeploy={latest?.status === 'success'} />
    </>
  );
}

// `redeploy` reads "Re-deploy" when the project already has a live deployment to replace.
function DeployLink({
  project_id,
  redeploy,
}: {
  readonly project_id: string;
  readonly redeploy: boolean;
}) {
  return (
    <Button asChild size="sm">
      <Link
        to="/projects/$project_id/deploy"
        params={{ project_id }}
        data-testid="header-project-deploy"
      >
        <CloudUploadIcon aria-hidden />
        {redeploy ? 'Re-deploy' : 'Deploy'}
      </Link>
    </Button>
  );
}

function LatestDeployLink({
  project_id,
  deployment,
}: {
  readonly project_id: string;
  readonly deployment: Pick<DeploymentInfo, 'id'>;
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link
        to="/projects/$project_id/deploy/$deploy_id"
        params={{ project_id, deploy_id: deployment.id }}
        data-testid="header-project-latest-deploy"
      >
        <ActivityIcon aria-hidden className="h-2 w-2" />
        Latest deploy
      </Link>
    </Button>
  );
}

function ActiveDeployLink({
  project_id,
  deployment,
}: {
  readonly project_id: string;
  readonly deployment: Pick<DeploymentInfo, 'id' | 'status'>;
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link
        to="/projects/$project_id/deploy/$deploy_id"
        params={{ project_id, deploy_id: deployment.id }}
        data-testid="header-project-deploy-progress"
      >
        <ActivityIcon aria-hidden />
        {deploymentStatusLabel(deployment.status)}
      </Link>
    </Button>
  );
}
