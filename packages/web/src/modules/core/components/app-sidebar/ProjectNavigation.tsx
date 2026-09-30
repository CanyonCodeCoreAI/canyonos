import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { ChevronRightIcon, FileTextIcon, FolderIcon, LayoutDashboardIcon } from 'lucide-react';
import { useEffect, useReducer } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';

import type { ProjectSummary } from '@canyonos/api/projects';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { useSidebar } from '@repo/ui/shadcn/sidebar';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { PALETTE } from '@/modules/core/navigation/navigation';
import {
  createProjectExpansionState,
  reduceProjectExpansion,
} from '@/modules/core/navigation/project-expansion';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';

const PROJECT_COLORS = Object.values(PALETTE);

function isPath(pathname: string, path: string): boolean {
  return pathname === path || pathname === `${path}/`;
}

function projectColor(project_id: string): string {
  let total = 0;
  for (let index = 0; index < project_id.length; index += 1) {
    total += project_id.charCodeAt(index);
  }
  return PROJECT_COLORS[total % PROJECT_COLORS.length] ?? PALETTE.emerald;
}

function ChildQueryError({
  message,
  on_retry,
}: {
  readonly message: string;
  readonly on_retry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5" role="alert">
      <span className="text-destructive truncate text-[0.6875rem]">{message}</span>
      <button
        type="button"
        onClick={on_retry}
        className="text-foreground hover:bg-foreground/[0.06] rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold"
      >
        Retry
      </button>
    </div>
  );
}

const ROUTE_ROW_CLASS =
  'hover:bg-foreground/[0.03] flex items-center gap-[0.4375rem] rounded-[0.4375rem] py-[0.3125rem] pr-2.5 transition-colors';

// Manage names what the project dashboard is for — reading what is already running — rather than
// naming its position in a list.
function ProjectRouteRow({
  project_id,
  to,
  label,
  Icon,
  test_id,
  is_active,
}: {
  readonly project_id: string;
  readonly to: '/projects/$project_id' | '/projects/$project_id/prompts';
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly test_id: string;
  readonly is_active: boolean;
}) {
  return (
    <Link
      to={to}
      params={{ project_id }}
      // The router marks a prefix match active, which would keep Manage current on /prompts.
      activeOptions={{ exact: true }}
      data-testid={`${test_id}-${project_id}`}
      aria-current={is_active ? 'page' : undefined}
      // Indented past where the project's chevron sits, so the row lines up on its icon.
      className={cn(ROUTE_ROW_CLASS, 'pl-[1.875rem]', is_active && 'bg-background shadow-xs')}
    >
      <Icon
        className={cn(
          'size-[0.8125rem] shrink-0',
          is_active ? 'text-primary' : 'text-muted-foreground'
        )}
        strokeWidth={1.9}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[0.75rem] font-semibold',
          is_active ? 'text-primary' : 'text-sidebar-foreground'
        )}
      >
        {label}
      </span>
    </Link>
  );
}

function ProjectRow({ project }: { readonly project: ProjectSummary }) {
  const params = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const is_active = params.project_id === project.id;
  const project_path = `/projects/${project.id}`;
  const is_manage_active = isPath(pathname, project_path);
  const is_prompts_active = isPath(pathname, `${project_path}/prompts`);
  const [expansion, dispatchExpansion] = useReducer(
    reduceProjectExpansion,
    is_active,
    createProjectExpansionState
  );
  const open = expansion.is_open;
  const color = projectColor(project.id);
  const { state: sidebar_state, isMobile: is_mobile } = useSidebar();
  // In icon-collapsed mode the collapsible content is hidden, so the chevron has nothing to reveal
  // and is dropped — the row link is the whole row (mobile uses the full sheet).
  const is_icon_collapsed = sidebar_state === 'collapsed' && !is_mobile;

  useEffect(() => {
    dispatchExpansion({ type: 'activation_changed', is_active });
  }, [is_active]);

  const row_content = (
    <>
      <FolderIcon
        className="size-3.5 shrink-0"
        strokeWidth={1.8}
        style={{ color, fill: color, fillOpacity: 0.18 }}
      />
      <span
        className={cn(
          'app-sidebar-hide-when-collapsed text-foreground min-w-0 flex-1 truncate text-[0.84375rem] font-semibold',
          is_active && 'font-bold'
        )}
      >
        {project.name}
      </span>
      <span className="app-sidebar-meta app-sidebar-hide-when-collapsed text-[0.65625rem]">
        {project.file_count} files
      </span>
    </>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(is_open) => dispatchExpansion({ type: 'open_changed', is_open })}
      className="group/proj flex flex-col gap-[0.1875rem]"
    >
      <div
        className="app-sidebar-row app-sidebar-collapse-to-icon gap-2 px-2.5 py-[0.5625rem]"
        style={{ '--app-sidebar-color': color } as CSSProperties}
      >
        {is_icon_collapsed ? null : (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={`Toggle ${project.name} sources`}
              aria-expanded={open}
              data-testid={`nav-project-toggle-${project.id}`}
              className="app-sidebar-hide-when-collapsed text-muted-foreground hover:bg-foreground/[0.06] -ml-1 flex size-4 shrink-0 items-center justify-center rounded transition-colors"
            >
              <ChevronRightIcon
                className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')}
                strokeWidth={2.2}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
        )}
        {/* The row opens the project overview; reaching it should never cost a second click. The
            sources underneath are a detail of that project, so arriving also expands them — the
            chevron is what closes them again. */}
        <Link
          to="/projects/$project_id"
          params={{ project_id: project.id }}
          onClick={() => dispatchExpansion({ type: 'open_changed', is_open: true })}
          data-testid={`nav-project-${project.id}`}
          aria-label={project.name}
          title={project.name}
          className="app-sidebar-collapse-to-icon flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {row_content}
        </Link>
      </div>

      <CollapsibleContent className="app-sidebar-hide-when-collapsed data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="flex flex-col gap-[0.1875rem]">
          <ProjectRouteRow
            project_id={project.id}
            to="/projects/$project_id"
            label="Manage"
            Icon={LayoutDashboardIcon}
            test_id="nav-project-manage"
            is_active={is_manage_active}
          />
          <ProjectRouteRow
            project_id={project.id}
            to="/projects/$project_id/prompts"
            label="Prompts"
            Icon={FileTextIcon}
            test_id="nav-project-prompts"
            is_active={is_prompts_active}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ProjectNavigation() {
  const projects_query = useQuery({
    queryKey: projectQueryKeys.all,
    queryFn: () => apiCall<ProjectSummary[]>(() => forgeAuthApi.projects.get()),
    retry: false,
  });

  return (
    <section aria-label="Projects" className="app-sidebar-section">
      <div className="app-sidebar-hide-when-collapsed flex items-center gap-2 px-2.5 pt-1.75 pb-1.5">
        <span className="text-muted-foreground text-[0.6875rem] font-bold tracking-[0.07em] uppercase">
          Projects
        </span>
        {projects_query.data ? (
          <span className="text-muted-foreground font-mono text-[0.6875rem] font-semibold">
            {projects_query.data.length}
          </span>
        ) : null}
      </div>

      {projects_query.isPending ? (
        <span
          className="app-sidebar-hide-when-collapsed text-muted-foreground px-2.5 py-2 text-[0.75rem]"
          data-testid="projects-loading"
        >
          Loading projects…
        </span>
      ) : projects_query.error ? (
        <div className="app-sidebar-hide-when-collapsed px-1" data-testid="projects-error">
          <ChildQueryError
            message="Projects unavailable"
            on_retry={() => void projects_query.refetch()}
          />
        </div>
      ) : projects_query.data.length === 0 ? (
        <ProjectsEmpty />
      ) : (
        projects_query.data.map((project) => <ProjectRow key={project.id} project={project} />)
      )}
    </section>
  );
}

function ProjectsEmpty() {
  return (
    <span
      className="app-sidebar-hide-when-collapsed text-muted-foreground px-2.5 py-2 text-[0.75rem]"
      data-testid="projects-empty"
    >
      No projects on this machine yet.
    </span>
  );
}
