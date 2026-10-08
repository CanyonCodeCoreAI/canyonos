import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, FolderIcon } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { User } from '@canyonos/api/auth';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { FleetOverview, FleetProject } from '@canyonos/api/resources';

import { SectionLabel } from '@repo/ui/components/section-label';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { authSelectors, useAuthStore } from '@/modules/auth/auth.store';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { formatCount, formatMoneyValue } from '@/modules/projects/projects.format';
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

function heroSummary(projectCount: number | undefined): string {
  if (projectCount === undefined) return 'Every project on this machine.';
  if (projectCount === 0) return 'No projects on this machine yet.';
  return `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} on this machine.`;
}

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];
const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'narrow' });

// Compact relative time (e.g. "2h ago") for the row's last-activity metadata.
function formatRelativeTime(iso: string): string {
  const elapsed = Date.parse(iso) - Date.now();
  if (Number.isNaN(elapsed)) return '';
  for (const [unit, msPerUnit] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= msPerUnit) {
      return relativeFormatter.format(Math.round(elapsed / msPerUnit), unit);
    }
  }
  return 'just now';
}

export function ProjectsOverviewScreen() {
  const projectsQuery = useQuery({
    queryKey: projectQueryKeys.all,
    queryFn: () => apiCall<ProjectSummary[]>(() => forgeAuthApi.projects.get()),
    retry: false,
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

  const greeting = greetingForHour(new Date().getHours());
  const firstName = firstNameFor(user);
  const heading = firstName ? `Good ${greeting}, ${firstName}` : `Good ${greeting}`;

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
            {heroSummary(projectsQuery.data?.length)}
          </p>
        </div>
      </header>

      <section className={`${ENTER} flex min-h-0 flex-1 flex-col gap-3 [animation-delay:140ms]`}>
        <SectionLabel>Your projects</SectionLabel>
        <ProjectsList projectsQuery={projectsQuery} spendByProject={spend_by_project} />
      </section>
    </main>
  );
}

function ProjectsList({
  projectsQuery,
  spendByProject,
}: {
  readonly projectsQuery: UseQueryResult<ProjectSummary[]>;
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
          <ProjectOverviewRow
            key={project.id}
            project={project}
            spend={spendByProject.get(project.id)}
          />
        ))}
      </ul>
    </div>
  );
}

/** The whole row is one link to the project dashboard, stretched over it with an ::after overlay. */
function ProjectOverviewRow({
  project,
  spend,
}: {
  readonly project: ProjectSummary;
  /** Trailing-30-day spend for this project. Absent while the fleet rollup is still loading. */
  readonly spend: FleetProject | undefined;
}) {
  return (
    <li className="group has-[a:focus-visible]:ring-ring hover:bg-muted/40 relative flex items-center gap-3 px-5 py-4 transition-colors has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset sm:gap-4">
      <Link
        to="/projects/$project_id/status"
        params={{ project_id: project.id }}
        data-testid={`projects-overview-project-${project.id}`}
        aria-label={project.name}
        title={project.name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md after:absolute after:inset-0 after:z-[1] after:content-[''] focus-visible:outline-none"
      >
        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <FolderIcon className="text-muted-foreground size-4" strokeWidth={1.9} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground truncate text-sm font-semibold">{project.name}</span>
          <RowSpend spend={spend} />
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <span className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:inline">
          {formatRelativeTime(project.updated_at)}
        </span>
        <ChevronRightIcon
          className="text-muted-foreground/60 ease-snappy size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
          strokeWidth={2}
          aria-hidden
        />
      </div>
    </li>
  );
}

/**
 * The ribbon's figures, on their own line: the row's right-hand side is already full, and these read
 * as a set rather than as more row metadata.
 */
function RowSpend({ spend }: { readonly spend: FleetProject | undefined }) {
  if (!spend) return null;

  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
      <RowMetric label="queries" value={formatCount(spend.requests)} />
      <RowMetric label="spend" value={formatMoneyValue(spend.cost)} />
      {spend.requests > 0 ? (
        <RowMetric label="per query" value={formatMoneyValue(spend.cost / spend.requests)} />
      ) : null}
    </span>
  );
}

/** One figure from the cost ribbon, sized for a list row rather than a card. */
function RowMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-foreground font-semibold">{value}</span>
      <span className="font-sans">{label}</span>
    </span>
  );
}

function NoProjectsYet() {
  return (
    <div className="flex flex-1" data-testid="projects-overview-empty">
      <EmptyState>
        <p>No projects on this machine yet.</p>
      </EmptyState>
    </div>
  );
}
