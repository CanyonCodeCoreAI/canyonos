import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, FolderIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DeploymentOverviewItem } from '@cc-forge/api/deploy';
import type { ProjectSummary } from '@cc-forge/api/projects';
import type { FleetProject } from '@cc-forge/api/resources';

import { CopyButton } from '@repo/ui/components/copy-button';
import { isCanyonOsLocalMode } from '@/modules/core/canyonos/local-mode';
import { DeploymentStatusBadge } from '@/modules/deploy/components/deployment-status-badge';
import { isDeploymentActive } from '@/modules/deploy/deploy.lifecycle';
import { formatCount, formatMoneyValue } from '@/modules/projects/projects.format';

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

// routing-free anchor props so both link targets stay identical apart from `to`/`params` —
// TanStack's typed Link needs those two spelled out literally, so the target is branched below.
const LINK_CLASS =
  "flex min-w-0 flex-1 items-center gap-3 rounded-md after:absolute after:inset-0 after:z-[1] after:content-[''] focus-visible:outline-none";

interface DeploymentOverviewRowProps {
  readonly project: ProjectSummary;
  readonly deployment: DeploymentOverviewItem | undefined;
  /** Trailing-30-day spend for this project. Absent while the fleet rollup is still loading. */
  readonly spend: FleetProject | undefined;
}

export function DeploymentOverviewRow({ project, deployment, spend }: DeploymentOverviewRowProps) {
  const lastActivity = formatRelativeTime(deployment?.updated_at ?? project.updated_at);

  const rowContent = (
    <>
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
        <FolderIcon className="text-muted-foreground size-4" strokeWidth={1.9} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground truncate text-sm font-semibold">{project.name}</span>
        {/* The ribbon's figures, on their own line: the row's right-hand side is already full, and
            these read as a set rather than as more row metadata. */}
        {spend ? (
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
            <RowMetric label="queries" value={formatCount(spend.requests)} />
            <RowMetric label="spend" value={formatMoneyValue(spend.cost)} />
            {spend.requests > 0 ? (
              <RowMetric label="per query" value={formatMoneyValue(spend.cost / spend.requests)} />
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <li className="group has-[a:focus-visible]:ring-ring hover:bg-muted/40 relative flex items-center gap-3 px-5 py-4 transition-colors has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset sm:gap-4">
      <DeploymentRowLink project={project} deployment={deployment}>
        {rowContent}
      </DeploymentRowLink>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <RowLiveAddress project={project} deployment={deployment} />
        <span className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:inline">
          {lastActivity}
        </span>
        <RowDeployStatus status={deployment?.status} />
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
 * The row's single link target: a stretched ::after overlay covering the whole row.
 *
 * A project mid-deploy resumes its status stream; everything else opens the project detail. Local
 * mode has no deploy routes at all, so every row there opens the detail.
 */
function DeploymentRowLink({
  project,
  deployment,
  children,
}: {
  readonly project: ProjectSummary;
  readonly deployment: DeploymentOverviewItem | undefined;
  readonly children: ReactNode;
}) {
  const anchorProps = {
    'data-testid': `projects-overview-project-${project.id}`,
    'aria-label': project.name,
    title: project.name,
    className: LINK_CLASS,
  } as const;

  if (!isCanyonOsLocalMode && deployment && isDeploymentActive(deployment.status)) {
    return (
      <Link
        to="/projects/$project_id/deploy/$deploy_id"
        params={{ project_id: project.id, deploy_id: deployment.id }}
        {...anchorProps}
      >
        {children}
      </Link>
    );
  }

  return (
    <Link to="/projects/$project_id" params={{ project_id: project.id }} {...anchorProps}>
      {children}
    </Link>
  );
}

/**
 * Where the deployed agent answers, with a copy control.
 *
 * The copy button (z-[2]) sits above the row's link overlay so it stays independently clickable.
 * Local mode has nothing deployed, so a row there carries no address to copy.
 */
function RowLiveAddress({
  project,
  deployment,
}: {
  readonly project: ProjectSummary;
  readonly deployment: DeploymentOverviewItem | undefined;
}) {
  const address = deployment?.address ?? null;
  if (isCanyonOsLocalMode) return null;
  if (!address) return null;

  return (
    <span className="hidden items-center gap-1 lg:flex">
      <span
        className="text-muted-foreground max-w-[11rem] truncate font-mono text-xs"
        title={address}
      >
        {address}
      </span>
      <CopyButton
        value={address}
        className="relative z-[2]"
        data-testid={`projects-overview-copy-ip-${project.id}`}
      />
    </span>
  );
}

/** Local mode runs no deploy pipeline, so a row reports no deploy state — not even "never". */
function RowDeployStatus({
  status,
}: {
  readonly status: DeploymentOverviewItem['status'] | undefined;
}) {
  if (isCanyonOsLocalMode) return null;

  return <DeploymentStatusBadge status={status} />;
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
