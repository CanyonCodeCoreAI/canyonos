import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import {
  ActivityIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  FileIcon,
  FolderIcon,
  LayoutDashboardIcon,
  ServerCogIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
  UploadIcon,
} from 'lucide-react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { LinkProps } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import type { FileMeta, ProjectSummary } from '@canyonos/api/projects';
import type { ProjectWorkflowSummary } from '@canyonos/api/workflows';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { useSidebar } from '@repo/ui/shadcn/sidebar';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { isCanyonOsLocalMode } from '@/modules/core/canyonos/local-mode';
import { ProjectActionsMenu } from '@/modules/core/components/app-sidebar/ProjectActionsMenu';
import { ProjectDeleteDialog } from '@/modules/core/components/app-sidebar/ProjectDeleteDialog';
import { PALETTE } from '@/modules/core/navigation/navigation';
import {
  createProjectExpansionState,
  reduceProjectExpansion,
} from '@/modules/core/navigation/project-expansion';
import { parseFileSearch } from '@/modules/core/navigation/search';
import { projectDeploySummaryQueryOptions } from '@/modules/deploy/deploy.queries';
import { buildFileTree } from '@/modules/projects/projects.file-tree';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { ProjectDeleteTarget } from '@/modules/core/components/app-sidebar/ProjectDeleteDialog';
import type {
  FileTreeFile,
  FileTreeFolder,
  FileTreeRow,
} from '@/modules/projects/projects.file-tree';

const PROJECT_COLORS = Object.values(PALETTE);

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

// Manage names what the project dashboard is for — reading and steering what is already running —
// rather than naming its position in a list. Design is not here because it folds, so it is a section
// rather than a row.
const PROJECT_ROUTE_ROWS = {
  manage: { label: 'Manage', Icon: LayoutDashboardIcon },
  deploy: { label: 'Scaling Policy', Icon: CloudUploadIcon },
  config: { label: 'Config', Icon: SlidersHorizontalIcon },
  performance: { label: 'Emulate', Icon: ActivityIcon },
  deployment_config: { label: 'Deployment Config', Icon: ServerCogIcon },
} as const;

/** One step in from where Design's label starts, which is what makes the tree read as its content. */
const TREE_INDENT = 'pl-[1.0625rem]';

const ROUTE_ROW_CLASS =
  'hover:bg-foreground/[0.03] flex items-center gap-[0.4375rem] rounded-[0.4375rem] py-[0.3125rem] pr-2.5 transition-colors';

/**
 * The upload flow, in order.
 *
 * Used for two things: marking the steps already passed, and deciding when the pane narrows to one
 * project. A project that has never deployed and is standing on one of these is being set up.
 */
const FLOW_STEPS = ['config', 'performance', 'deployment_config'] as const;

const ROUTE_ROW_TARGET = {
  manage: '/projects/$project_id',
  deploy: '/projects/$project_id/deploy',
  config: '/projects/$project_id/deploy',
  performance: '/projects/$project_id/deploy/performance',
  deployment_config: '/projects/$project_id/deployment-config',
} as const;

interface ProjectRouteRowProps {
  readonly project_id: string;
  readonly is_active: boolean;
  readonly type: keyof typeof PROJECT_ROUTE_ROWS;
  /** A row nested under a fold sits one step further in than its parent. */
  readonly nested?: boolean;
  /** A flow step the reader has already been through, marked so progress is visible. */
  readonly is_done?: boolean;
}

function ProjectRouteRow({
  project_id,
  is_active,
  type,
  nested = false,
  is_done = false,
}: ProjectRouteRowProps) {
  const { label, Icon } = PROJECT_ROUTE_ROWS[type];

  return (
    <Link
      to={ROUTE_ROW_TARGET[type]}
      params={{ project_id }}
      data-testid={`nav-project-${type}-${project_id}`}
      aria-current={is_active ? 'page' : undefined}
      // Indented past where a fold's chevron sits, so every row lines up on its icon.
      className={cn(
        ROUTE_ROW_CLASS,
        nested ? 'pl-[2.9375rem]' : 'pl-[1.875rem]',
        is_active && 'bg-background shadow-xs'
      )}
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
      {is_done && !is_active ? (
        <CheckIcon
          className="text-primary size-3 shrink-0"
          strokeWidth={2.6}
          aria-label="done"
          data-testid={`nav-project-${type}-done-${project_id}`}
        />
      ) : null}
    </Link>
  );
}

/**
 * A nav row that folds to reveal what belongs to it.
 *
 * Used by Design over its sources and by Deployment over its screens. The label is only a link when
 * there is somewhere to go; without one it still labels the fold, the same way a source file with no
 * design to open stays inert rather than pretending.
 */
function ProjectNavFold({
  label,
  Icon,
  target,
  is_active,
  toggle_test_id,
  link_test_id,
  toggle_label,
  children,
}: {
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Where the label goes, or null when the fold has no screen of its own. */
  readonly target: LinkProps | null;
  readonly is_active: boolean;
  readonly toggle_test_id: string;
  readonly link_test_id: string;
  readonly toggle_label: string;
  readonly children: ReactNode;
}) {
  // Open by default: a fold that hides what it holds until asked reads as empty on arrival.
  const [open, setOpen] = useState(true);
  const label_class = cn(
    'min-w-0 flex-1 truncate font-mono text-[0.75rem] font-semibold',
    is_active ? 'text-primary' : 'text-sidebar-foreground'
  );
  const icon = (
    <Icon
      className={cn(
        'size-[0.8125rem] shrink-0',
        is_active ? 'text-primary' : 'text-muted-foreground'
      )}
      strokeWidth={1.9}
    />
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-[0.1875rem]">
      <div className="flex items-center gap-[0.1875rem] pl-[0.9375rem]">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={toggle_label}
            aria-expanded={open}
            data-testid={toggle_test_id}
            className="text-muted-foreground hover:bg-foreground/[0.06] flex size-4 shrink-0 items-center justify-center rounded transition-colors"
          >
            <ChevronRightIcon
              className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')}
              strokeWidth={2.2}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        {target === null ? (
          <div className={cn(ROUTE_ROW_CLASS, 'min-w-0 flex-1 hover:bg-transparent')}>
            {icon}
            <span className={label_class}>{label}</span>
          </div>
        ) : (
          <Link
            {...target}
            data-testid={link_test_id}
            aria-current={is_active ? 'page' : undefined}
            className={cn(
              ROUTE_ROW_CLASS,
              'min-w-0 flex-1',
              is_active && 'bg-background shadow-xs'
            )}
          >
            {icon}
            <span className={label_class}>{label}</span>
          </Link>
        )}
      </div>

      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="flex flex-col gap-[0.1875rem]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ProjectSourceProps {
  readonly project_id: string;
  readonly workflows: readonly ProjectWorkflowSummary[];
  readonly source_workflow_id?: string;
  readonly selected_file_id?: string;
}

function ProjectSourceFile({
  row,
  project_id,
  workflows,
  source_workflow_id,
  selected_file_id,
}: {
  readonly row: FileTreeFile;
} & ProjectSourceProps) {
  const paddingLeft = `${0.9375 + row.depth * 0.85}rem`;
  const workflow =
    row.component_kind === 'workflow'
      ? workflows.find((candidate) => candidate.source_file_id === row.file_id)
      : undefined;
  const is_active = row.file_id === selected_file_id;
  const content = (
    <>
      <FileIcon
        className={cn(
          'size-[0.8125rem] shrink-0',
          is_active
            ? 'text-primary'
            : row.component_kind === 'workflow'
              ? 'text-primary/75'
              : 'text-muted-foreground/70'
        )}
        strokeWidth={1.8}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[0.75rem]',
          is_active ? 'text-primary font-semibold' : 'text-muted-foreground font-medium'
        )}
      >
        {row.name}
      </span>
    </>
  );
  const base_class = 'flex items-center gap-[0.4375rem] rounded-[0.4375rem] py-[0.3125rem] pr-2.5';
  const actionable_class = cn(
    base_class,
    'hover:bg-foreground/[0.03] transition-colors',
    is_active && 'bg-background shadow-xs'
  );

  if (workflow) {
    return (
      <Link
        to="/projects/$project_id/workflows/$workflow_id/design"
        params={{ project_id, workflow_id: workflow.id }}
        search={{ file_id: undefined }}
        data-testid={`nav-workflow-${workflow.id}`}
        aria-current={is_active ? 'page' : undefined}
        title={row.name}
        className={actionable_class}
        style={{ paddingLeft }}
      >
        {content}
      </Link>
    );
  }

  if (row.component_kind !== 'workflow' && source_workflow_id) {
    return (
      <Link
        to="/projects/$project_id/workflows/$workflow_id/design"
        params={{ project_id, workflow_id: source_workflow_id }}
        search={{ file_id: row.file_id }}
        data-testid={`nav-file-${row.file_id}`}
        aria-current={is_active ? 'page' : undefined}
        title={row.name}
        className={actionable_class}
        style={{ paddingLeft }}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className={base_class}
      style={{ paddingLeft }}
      data-testid={`nav-source-${row.file_id}`}
      title={`${row.name} is available from a workflow design.`}
    >
      {content}
    </div>
  );
}

function ProjectSourceFolder({
  row,
  expanded_folder_ids,
  on_open_change,
  ...source_props
}: {
  readonly row: FileTreeFolder;
  readonly expanded_folder_ids: ReadonlySet<string>;
  readonly on_open_change: (folder_id: string, is_open: boolean) => void;
} & ProjectSourceProps) {
  const is_open = expanded_folder_ids.has(row.id);
  const paddingLeft = `${0.9375 + row.depth * 0.85}rem`;

  return (
    <Collapsible open={is_open} onOpenChange={(open) => on_open_change(row.id, open)}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={`Toggle ${row.path} folder`}
          data-testid={`nav-folder-${row.path}`}
          className="group/folder hover:bg-foreground/[0.03] text-sidebar-foreground flex min-h-10 w-full items-center gap-[0.4375rem] rounded-[0.4375rem] pr-2.5 text-left transition-colors"
          style={{ paddingLeft }}
        >
          <ChevronRightIcon
            className="text-muted-foreground size-3.5 shrink-0 group-data-[state=open]/folder:rotate-90"
            strokeWidth={2.2}
            aria-hidden
          />
          <FolderIcon className="text-muted-foreground size-[0.8125rem] shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] font-semibold">
            {row.name}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-[0.1875rem]">
          {row.children.map((child) => (
            <ProjectSourceNode
              key={child.id}
              row={child}
              expanded_folder_ids={expanded_folder_ids}
              on_open_change={on_open_change}
              {...source_props}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProjectSourceNode({
  row,
  expanded_folder_ids,
  on_open_change,
  ...source_props
}: {
  readonly row: FileTreeRow;
  readonly expanded_folder_ids: ReadonlySet<string>;
  readonly on_open_change: (folder_id: string, is_open: boolean) => void;
} & ProjectSourceProps) {
  return row.kind === 'folder' ? (
    <ProjectSourceFolder
      row={row}
      expanded_folder_ids={expanded_folder_ids}
      on_open_change={on_open_change}
      {...source_props}
    />
  ) : (
    <ProjectSourceFile row={row} {...source_props} />
  );
}

function ProjectRow({
  project,
  onRequestDelete,
}: {
  readonly project: ProjectSummary;
  readonly onRequestDelete: (target: ProjectDeleteTarget) => void;
}) {
  const params = useParams({ strict: false });
  const { pathname, selected_file_id } = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      selected_file_id: parseFileSearch(state.location.search.file_id),
    }),
  });
  const is_active = params.project_id === project.id;
  const active_workflow_id = is_active ? params.workflow_id : undefined;
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
        <ProjectActionsMenu
          project_id={project.id}
          project_name={project.name}
          onRequestDelete={() => onRequestDelete({ id: project.id, name: project.name, is_active })}
        />
      </div>

      <CollapsibleContent className="app-sidebar-hide-when-collapsed data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="flex flex-col gap-[0.1875rem]">
          <ProjectNavSections
            project_id={project.id}
            open={open}
            pathname={pathname}
            active_workflow_id={active_workflow_id}
            selected_file_id={is_active ? selected_file_id : undefined}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ProjectNavSectionsProps {
  readonly project_id: string;
  /** Whether the row is expanded. Everything read below only feeds what a fold reveals. */
  readonly open: boolean;
  readonly pathname: string;
  /** Set while one of this project's design screens is open. */
  readonly active_workflow_id: string | undefined;
  readonly selected_file_id: string | undefined;
}

/**
 * What a project's row folds open, in the order a project is lived in: design it, deploy it, then
 * manage what is running.
 *
 * Local mode narrows this to Manage. There is no design editor to open and no deploy target to
 * configure on a local install, and the three reads below feed only the sections that lead to them
 * — which is why local mode asks for none of them.
 */
function ProjectNavSections({
  project_id,
  open,
  pathname,
  active_workflow_id,
  selected_file_id,
}: ProjectNavSectionsProps) {
  // Which folders the reader has opened. Empty to start, so the tree arrives shut: a project with a
  // folder per agent unrolls to more rows than the sidebar can hold, and the reader came for one of
  // them. Tracked as opened rather than closed so an id nobody has touched reads as shut.
  const [expanded_folder_ids, setExpandedFolderIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const wanted = open && !isCanyonOsLocalMode;
  const workflows_query = useQuery({
    queryKey: projectQueryKeys.workflows(project_id),
    queryFn: () =>
      apiCall<ProjectWorkflowSummary[]>(() => forgeAuthApi.projects[project_id]!.workflows.get()),
    retry: false,
    enabled: wanted,
  });
  const files_query = useQuery({
    queryKey: projectQueryKeys.files(project_id),
    queryFn: () => apiCall<FileMeta[]>(() => forgeAuthApi.projects[project_id]!.files.get()),
    retry: false,
    enabled: wanted,
  });
  // Deployment only has screens to offer once there has been a deployment. Asked only while the
  // project is expanded, so a long project list does not fan out a request per row.
  const deploy_summary_query = useQuery({
    ...projectDeploySummaryQueryOptions(project_id),
    retry: false,
    enabled: wanted,
  });

  const project_path = `/projects/${project_id}`;
  const is_manage_active = pathname === project_path || pathname === `${project_path}/`;

  if (isCanyonOsLocalMode) {
    return <ProjectRouteRow project_id={project_id} type="manage" is_active={is_manage_active} />;
  }

  const has_deployed = deploy_summary_query.data?.latest != null;
  const rows = files_query.data ? buildFileTree(files_query.data) : [];
  const workflows = workflows_query.data ?? [];
  const design_workflow_id = workflows[0]?.id;
  const source_workflow_id = active_workflow_id ?? design_workflow_id;
  // The design screen is the only route that carries a workflow, so an active one means the
  // project has a design open.
  const is_design_open = active_workflow_id !== undefined;
  const deploy_path = `${project_path}/deploy`;
  const performance_path = `${deploy_path}/performance`;
  const deployment_config_path = `${project_path}/deployment-config`;
  const is_deploy_open = pathname === deploy_path || pathname.startsWith(`${deploy_path}/`);
  // Which step of the setup the reader is standing on, so the ones behind it can be marked.
  const flow_step =
    pathname === deployment_config_path
      ? 'deployment_config'
      : pathname === performance_path
        ? 'performance'
        : pathname === deploy_path || pathname === `${deploy_path}/`
          ? 'config'
          : null;
  const step_index = flow_step === null ? -1 : FLOW_STEPS.indexOf(flow_step);
  const passed = (step: (typeof FLOW_STEPS)[number]) =>
    step_index > FLOW_STEPS.indexOf(step) && !has_deployed;
  const set_folder_open = (folder_id: string, is_open: boolean) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (is_open) next.add(folder_id);
      else next.delete(folder_id);
      return next;
    });
  };

  return (
    <>
      <ProjectNavFold
        label="Design"
        Icon={ShapesIcon}
        target={
          design_workflow_id === undefined
            ? null
            : {
                to: '/projects/$project_id/workflows/$workflow_id/design',
                params: { project_id, workflow_id: design_workflow_id },
                search: { file_id: undefined },
              }
        }
        is_active={is_design_open}
        toggle_test_id={`nav-project-design-toggle-${project_id}`}
        link_test_id={`nav-project-design-${project_id}`}
        toggle_label="Toggle design sources"
      >
        <div className={cn('flex flex-col gap-[0.1875rem]', TREE_INDENT)}>
          {workflows_query.isPending ? (
            <span className="text-muted-foreground px-3 py-1.5 text-[0.6875rem]">
              Loading workflows…
            </span>
          ) : workflows_query.error ? (
            <ChildQueryError
              message="Workflows unavailable"
              on_retry={() => void workflows_query.refetch()}
            />
          ) : workflows_query.data.length === 0 ? (
            <span className="text-muted-foreground px-3 py-1.5 text-[0.6875rem]">
              No workflows detected
            </span>
          ) : null}

          {files_query.isPending ? (
            <span className="text-muted-foreground px-3 py-1.5 text-[0.6875rem]">
              Loading sources…
            </span>
          ) : files_query.error ? (
            <ChildQueryError
              message="Sources unavailable"
              on_retry={() => void files_query.refetch()}
            />
          ) : rows.length === 0 ? (
            <span className="text-muted-foreground px-3 py-1.5 text-[0.6875rem]">
              No project sources
            </span>
          ) : (
            rows.map((row) => (
              <ProjectSourceNode
                key={row.id}
                row={row}
                project_id={project_id}
                workflows={workflows}
                source_workflow_id={source_workflow_id}
                selected_file_id={selected_file_id}
                expanded_folder_ids={expanded_folder_ids}
                on_open_change={set_folder_open}
              />
            ))
          )}
        </div>
      </ProjectNavFold>

      {/* A deploy status or preview screen is still the project's deployment, so the row stays
          lit there and not only on the config screen. The fold is there before the first deploy
          too, because Config and Emulate are the steps that lead to one. */}
      <ProjectNavFold
        label="Scaling Policy"
        Icon={CloudUploadIcon}
        target={{ to: '/projects/$project_id/deploy', params: { project_id } }}
        is_active={is_deploy_open}
        toggle_test_id={`nav-project-deploy-toggle-${project_id}`}
        link_test_id={`nav-project-deploy-${project_id}`}
        toggle_label="Toggle scaling policy screens"
      >
        <ProjectRouteRow
          project_id={project_id}
          type="config"
          is_active={pathname === deploy_path || pathname === `${deploy_path}/`}
          is_done={passed('config')}
          nested
        />
        <ProjectRouteRow
          project_id={project_id}
          type="performance"
          is_active={pathname === performance_path}
          is_done={passed('performance')}
          nested
        />
      </ProjectNavFold>

      {/* Sizing is something you set, not a reading of something running, so it is offered
          before the first deploy as well as after it. */}
      <ProjectRouteRow
        project_id={project_id}
        type="deployment_config"
        is_active={pathname === deployment_config_path}
        is_done={passed('deployment_config')}
      />
      <ProjectRouteRow project_id={project_id} type="manage" is_active={is_manage_active} />
    </>
  );
}

/**
 * The project the pane narrows to while it is being set up, or null when the whole list shows.
 *
 * Two conditions, both needed. The reader is standing on one of the setup screens, and the project
 * has never deployed — a deployed project's Config screen is ordinary navigation, and hiding
 * everything else there would be a pane that shrinks for no reason the reader can see.
 *
 * The summary is asked for by the same key the row asks for it by, so this shares that request
 * rather than adding one.
 */
function useSetupFocus(): string | null {
  const params = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const project_id = params.project_id;

  const summary_query = useQuery({
    ...projectDeploySummaryQueryOptions(project_id ?? ''),
    enabled: project_id !== undefined && !isCanyonOsLocalMode,
    retry: false,
  });

  // Local mode has no setup flow to narrow the pane for: its screens are not offered, so the pane
  // never focuses and this never has a deploy summary to ask for.
  if (isCanyonOsLocalMode) return null;
  if (project_id === undefined) return null;
  const base = `/projects/${project_id}`;
  const on_setup_screen =
    pathname === `${base}/deploy` ||
    pathname === `${base}/deploy/` ||
    pathname === `${base}/deploy/performance` ||
    pathname === `${base}/deployment-config`;

  // Only once the answer is in: guessing while it loads would flash the list away and back.
  const never_deployed = summary_query.data?.latest === null;
  return on_setup_screen && never_deployed ? project_id : null;
}

export function ProjectNavigation() {
  const projects_query = useQuery({
    queryKey: projectQueryKeys.all,
    queryFn: () => apiCall<ProjectSummary[]>(() => forgeAuthApi.projects.get()),
    retry: false,
  });
  const focused_id = useSetupFocus();
  // The delete-confirmation dialog is owned here, above the project rows, so it survives the row
  // unmounting when its project is deleted (see ProjectDeleteDialog for why that matters).
  const [delete_target, setDeleteTarget] = useState<ProjectDeleteTarget | null>(null);
  const requestDelete = useCallback((target: ProjectDeleteTarget) => setDeleteTarget(target), []);

  return (
    <section aria-label="Projects" className="app-sidebar-section">
      <div className="app-sidebar-hide-when-collapsed flex items-center justify-between gap-2 px-2.5 pt-1.75 pb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[0.6875rem] font-bold tracking-[0.07em] uppercase">
            Projects
          </span>
          {projects_query.data ? (
            <span className="text-muted-foreground font-mono text-[0.6875rem] font-semibold">
              {projects_query.data.length}
            </span>
          ) : null}
        </div>
        <ProjectImportLink />
      </div>

      {focused_id !== null ? (
        <span
          className="app-sidebar-hide-when-collapsed text-muted-foreground px-2.5 pb-1 text-[0.6875rem]"
          data-testid="projects-setup-focus"
        >
          Setting up — the rest of your projects are hidden until this one is deployed.
        </span>
      ) : null}

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
        projects_query.data
          .filter((project) => focused_id === null || project.id === focused_id)
          .map((project) => (
            <ProjectRow key={project.id} project={project} onRequestDelete={requestDelete} />
          ))
      )}

      <ProjectDeleteDialog target={delete_target} onClose={() => setDeleteTarget(null)} />
    </section>
  );
}

/** Import is a hosted-dashboard action: a local install's projects arrive on the machine itself. */
function ProjectImportLink() {
  if (isCanyonOsLocalMode) return null;

  return (
    <Link
      to="/projects/import"
      data-testid="project-import-trigger"
      aria-label="Import project"
      className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded-md transition-colors"
    >
      <UploadIcon className="size-3.5" strokeWidth={2.2} />
    </Link>
  );
}

const PROJECTS_EMPTY_CLASS =
  'app-sidebar-hide-when-collapsed text-muted-foreground px-2.5 py-2 text-[0.75rem]';

/**
 * The pane with no projects in it.
 *
 * The hosted dashboard offers the way out of that state — import — as the line itself. Local mode
 * has no import, so it states the fact and stops rather than naming an action it cannot run.
 */
function ProjectsEmpty() {
  if (isCanyonOsLocalMode) {
    return (
      <span className={PROJECTS_EMPTY_CLASS} data-testid="projects-empty">
        No projects on this machine yet.
      </span>
    );
  }

  return (
    <Link
      to="/projects/import"
      className={cn(PROJECTS_EMPTY_CLASS, 'hover:text-foreground transition-colors')}
      data-testid="projects-empty"
    >
      No projects yet. Import a project.
    </Link>
  );
}
