import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { User } from '@canyonos/api/auth';
import type { DeploymentOverviewItem } from '@canyonos/api/deploy';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { FleetOverview, FleetProject } from '@canyonos/api/resources';

import { SectionLabel } from '@repo/ui/components/section-label';
import { Button } from '@repo/ui/shadcn/button';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { authSelectors, useAuthStore } from '@/modules/auth/auth.store';
import { isCanyonOsLocalMode } from '@/modules/core/canyonos/local-mode';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { DeploymentOverviewRow } from '@/modules/deploy/components/deployment-overview-row';
import { ResumeDeployCard } from '@/modules/deploy/components/resume-deploy-card';
import { isDeploymentActive } from '@/modules/deploy/deploy.lifecycle';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

const SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;
const ENTER = 'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ease-snappy duration-300';
const LIST_CARD =
  'border-border bg-card scroll-area flex min-h-0 flex-col overflow-y-auto rounded-2xl border shadow-xs';

type Greeting = 'morning' | 'afternoon' | 'evening';

function greetingForHour(hour: number): Greeting {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function firstNameFor(user: User | null): string | undefined {
  const named = user?.name?.trim();
  if (named) return named.split(/\s+/)[0];
  const email = user?.email?.trim();
  if (email) return email.split('@')[0];
  return undefined;
}

// The overview endpoint returns deployments ordered updated_at desc, so the first non-terminal row
// is the most recently touched deploy still in flight — the one worth resuming.
function activeDeployment(
  deployments: readonly DeploymentOverviewItem[]
): DeploymentOverviewItem | undefined {
  return deployments.find((deployment) => isDeploymentActive(deployment.status));
}

// First occurrence per project wins because the list is ordered updated_at desc, so each project
// maps to its latest deployment — the record that drives the row's status pill, endpoint address
// and last-activity time on the overview.
function latestDeploymentByProject(
  deployments: readonly DeploymentOverviewItem[]
): Map<string, DeploymentOverviewItem> {
  const latest = new Map<string, DeploymentOverviewItem>();
  for (const deployment of deployments) {
    if (!latest.has(deployment.project_id)) {
      latest.set(deployment.project_id, deployment);
    }
  }
  return latest;
}

/**
 * The hero line on a local install.
 *
 * It counts projects and says nothing about deploys: a local install has no deploy target, so
 * "nothing deployed yet" would describe a pipeline that does not exist rather than one standing
 * idle. The fleet spend rollup is left alone for the same reason its figures are not read here —
 * it answers with an empty workspace, and a zero would read as a bill that stopped.
 */
function localHeroSummary(projectCount: number | undefined): string {
  if (projectCount === undefined) return 'Every project on this machine.';
  if (projectCount === 0) return 'No projects on this machine yet.';
  return `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} on this machine.`;
}

function heroSummary(input: {
  projectCount: number | undefined;
  liveCount: number;
  inFlightCount: number;
  deploymentsReady: boolean;
}): string {
  if (isCanyonOsLocalMode) return localHeroSummary(input.projectCount);

  const { projectCount, liveCount, inFlightCount, deploymentsReady } = input;
  if (projectCount === undefined) {
    return 'Every project in your workspace and its latest deploy activity.';
  }
  if (projectCount === 0) {
    return 'Import your first project to start deploying agents.';
  }
  const projects = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} in your workspace`;
  if (!deploymentsReady) return `${projects}.`;

  const signals: string[] = [];
  if (liveCount > 0) signals.push(`${liveCount} live`);
  if (inFlightCount > 0) signals.push(`${inFlightCount} deploying`);
  if (signals.length === 0) return `${projects} — nothing deployed yet.`;
  return `${projects} · ${signals.join(' · ')}.`;
}

export function ProjectsOverviewScreen() {
  const projectsQuery = useQuery({
    queryKey: projectQueryKeys.all,
    queryFn: () => apiCall<ProjectSummary[]>(() => forgeAuthApi.projects.get()),
    retry: false,
  });
  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'overview', 'all', 50],
    queryFn: () =>
      apiCall<DeploymentOverviewItem[]>(() =>
        forgeAuthApi.projects.deployments.get({ $query: { state: 'all', limit: 50 } })
      ),
    retry: false,
    // Nothing on this screen reads deploy state in local mode, so the rollup is never asked for.
    enabled: !isCanyonOsLocalMode,
  });
  const spend_query = useQuery({
    queryKey: ['resources', 'overview', '30d'],
    queryFn: () =>
      apiCall<FleetOverview>(() =>
        forgeAuthApi.resources.overview.get({ $query: { time_window: '30d' } })
      ),
    retry: false,
  });
  const user = useAuthStore(authSelectors.user);

  // Spend is decoration on a row that already reads without it, so a failed rollup drops the figures
  // rather than failing the list.
  const spend_by_project = new Map<string, FleetProject>(
    (spend_query.data?.projects ?? []).map((entry) => [entry.id, entry])
  );

  const deployments = deploymentsQuery.data ?? [];
  const activeDeploy = activeDeployment(deployments);
  const latestByProject = latestDeploymentByProject(deployments);

  let liveCount = 0;
  let inFlightCount = 0;
  for (const latest of latestByProject.values()) {
    if (latest.status === 'success') liveCount += 1;
    else if (isDeploymentActive(latest.status)) inFlightCount += 1;
  }

  const greeting = greetingForHour(new Date().getHours());
  const firstName = firstNameFor(user);
  const heading = firstName ? `Good ${greeting}, ${firstName}` : `Good ${greeting}`;
  const summary = heroSummary({
    projectCount: projectsQuery.data?.length,
    liveCount,
    inFlightCount,
    deploymentsReady: deploymentsQuery.isSuccess,
  });
  const isProjectsEmpty = projectsQuery.data?.length === 0;

  return (
    <main
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-8 pt-7 pb-8"
      data-testid="projects-overview"
    >
      <header
        className={`${ENTER} flex shrink-0 flex-wrap items-end justify-between gap-5 [animation-delay:0ms]`}
        data-testid="projects-overview-hero"
      >
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-[1.75rem] leading-none font-bold tracking-tight text-balance">
            {heading}
          </h1>
          <p className="text-muted-foreground max-w-[38rem] text-sm leading-relaxed text-pretty">
            {summary}
          </p>
        </div>
        <HeroNewProjectButton projects_empty={isProjectsEmpty} />
      </header>

      <ResumeDeploySlot deployment={activeDeploy} />

      <section className={`${ENTER} flex min-h-0 flex-1 flex-col gap-3 [animation-delay:140ms]`}>
        <SectionLabel>Your projects &amp; deploys</SectionLabel>
        <ProjectsList
          projectsQuery={projectsQuery}
          latestByProject={latestByProject}
          spendByProject={spend_by_project}
        />
      </section>
    </main>
  );
}

/**
 * The hero's create action.
 *
 * Absent while the list is empty, because the empty state carries its own, and absent in local mode,
 * which has no import to create through.
 */
function HeroNewProjectButton({ projects_empty }: { readonly projects_empty: boolean }) {
  if (isCanyonOsLocalMode) return null;
  if (projects_empty) return null;

  return (
    <Button asChild>
      <Link to="/projects/import" data-testid="projects-overview-new-project">
        <PlusIcon aria-hidden />
        New project
      </Link>
    </Button>
  );
}

/** The card that picks a deploy back up. Local mode never starts one, so it never has one to resume. */
function ResumeDeploySlot({
  deployment,
}: {
  readonly deployment: DeploymentOverviewItem | undefined;
}) {
  if (isCanyonOsLocalMode) return null;
  if (!deployment) return null;

  return (
    <div className={`${ENTER} shrink-0 [animation-delay:70ms]`}>
      <ResumeDeployCard deployment={deployment} />
    </div>
  );
}

function ProjectsList({
  projectsQuery,
  latestByProject,
  spendByProject,
}: {
  readonly projectsQuery: UseQueryResult<ProjectSummary[]>;
  readonly latestByProject: Map<string, DeploymentOverviewItem>;
  readonly spendByProject: Map<string, FleetProject>;
}) {
  if (projectsQuery.isPending) {
    return (
      <div className={LIST_CARD} data-testid="projects-overview-loading" aria-busy>
        <ul className="divide-border divide-y">
          {SKELETON_KEYS.map((key) => (
            <li key={key} className="flex items-center gap-4 px-5 py-4">
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-5 w-20 rounded-md" />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (projectsQuery.error) {
    return (
      <QueryError
        test_id="projects-overview-error"
        message="We couldn't load your projects."
        onRetry={() => void projectsQuery.refetch()}
      />
    );
  }

  if (projectsQuery.data.length === 0) return <NoProjectsYet />;

  return (
    <div className={LIST_CARD} data-testid="projects-overview-list">
      <ul className="divide-border divide-y">
        {projectsQuery.data.map((project) => (
          <DeploymentOverviewRow
            key={project.id}
            project={project}
            deployment={latestByProject.get(project.id)}
            spend={spendByProject.get(project.id)}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The workspace with nothing in it.
 *
 * The hosted dashboard names the way out — import — and offers the button for it. Local mode has
 * neither, so it says what is true and leaves it there.
 */
function NoProjectsYet() {
  if (isCanyonOsLocalMode) {
    return (
      <div className="flex flex-1" data-testid="projects-overview-empty">
        <EmptyState>
          <p>No projects on this machine yet.</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-1" data-testid="projects-overview-empty">
      <EmptyState>
        <p>No projects yet. Import your first project to get started.</p>
        <Button asChild size="sm">
          <Link to="/projects/import" data-testid="projects-overview-empty-new-project">
            <PlusIcon aria-hidden />
            New project
          </Link>
        </Button>
      </EmptyState>
    </div>
  );
}
