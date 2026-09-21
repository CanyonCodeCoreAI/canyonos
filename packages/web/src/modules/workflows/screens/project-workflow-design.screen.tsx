import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { FileMeta } from '@canyonos/api/projects';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowDetail,
  ProjectWorkflowSummary,
  WorkflowStatus,
} from '@canyonos/api/workflows';

import { FlowCanvas } from '@repo/ui/components/flow';
import { Legend } from '@repo/ui/components/legend';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@repo/ui/shadcn/resizable';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import {
  FileEditorSkeleton,
  ProjectFileEditor,
} from '@/modules/projects/components/project-file-editor';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import { GraphSkeletonPanel } from '@/modules/workflows/components/WorkflowDesignSkeleton';
import { WorkflowEdgeLegend } from '@/modules/workflows/components/WorkflowEdgeLegend';
import { WorkflowHero } from '@/modules/workflows/components/WorkflowHero';
import {
  buildWorkflowViewModel,
  normalizeFileSelection,
} from '@/modules/workflows/workflows.selectors';

const MIN_PANE_WIDTH_PX = 450;

interface ProjectWorkflowDesignScreenProps {
  readonly project_id: string;
  readonly workflow_id: string;
  readonly selected_file_id?: string;
}

function PanelMessage({
  test_id,
  children,
}: {
  readonly test_id: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="border-border bg-card text-muted-foreground flex min-h-[28rem] items-center justify-center rounded-2xl border p-10 text-center text-sm shadow-sm lg:h-full lg:min-h-0"
      data-testid={test_id}
    >
      {children}
    </div>
  );
}

function GraphPanel({
  project_id,
  workflow_id,
  design,
  status,
  is_design_pending,
  design_error,
  retry_design,
}: {
  readonly project_id: string;
  readonly workflow_id: string;
  readonly design?: ProjectWorkflowDesign;
  readonly status: WorkflowStatus;
  readonly is_design_pending: boolean;
  readonly design_error: boolean;
  readonly retry_design: () => void;
}) {
  if (status === 'PENDING' || status === 'GENERATING') return <GraphSkeletonPanel generating />;

  if (status === 'FAILED') {
    return (
      <PanelMessage test_id="workflow-design-unavailable">
        <div className="flex max-w-md flex-col gap-1.5">
          <strong className="text-foreground">Design generation failed</strong>
          <span>
            The source is available, but this workflow&rsquo;s design could not be generated.
          </span>
        </div>
      </PanelMessage>
    );
  }

  if (is_design_pending) return <GraphSkeletonPanel />;

  if (design_error || !design) {
    return (
      <PanelMessage test_id="workflow-design-error">
        <QueryError message="Could not load this workflow design." onRetry={retry_design} />
      </PanelMessage>
    );
  }

  const model = buildWorkflowViewModel(design);
  return (
    <div className="border-border bg-muted flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border shadow-sm lg:h-full lg:min-h-0">
      <div className="border-border/60 bg-card/70 flex min-h-[2.75rem] flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-sm">
        <span className="text-foreground text-sm font-semibold tracking-tight">Flow graph</span>
        <Legend items={model.component_legend} data-testid="workflow-legend" />
      </div>
      <div className="relative min-h-0 flex-1">
        <FlowCanvas
          key={`${project_id}:${workflow_id}:${design.updated_at}`}
          nodes={design.nodes}
          edges={design.edges}
          showControls
          showEdgeMarkers
          data-testid="workflow-canvas"
          nodeTestId={(id) => `workflow-node-${id}`}
        />
        <div className="border-border/60 bg-card/70 pointer-events-none absolute right-3 bottom-3 rounded-lg border px-3 py-1.5 shadow-sm backdrop-blur-sm">
          <WorkflowEdgeLegend items={model.edge_legend} />
        </div>
      </div>
    </div>
  );
}

export function ProjectWorkflowDesignScreen({
  project_id,
  workflow_id,
  selected_file_id,
}: ProjectWorkflowDesignScreenProps) {
  const navigate = useNavigate();
  const normalized_search = useRef<string | null>(null);
  const [notice_key, setNoticeKey] = useState<string | null>(null);
  const [selection_notice, setSelectionNotice] = useState<{
    readonly route_key: string;
    readonly message: string;
  } | null>(null);
  const route_key = `${project_id}:${workflow_id}`;

  const workflow_query = useQuery({
    queryKey: projectQueryKeys.workflow(project_id, workflow_id),
    queryFn: () =>
      apiCall<ProjectWorkflowDetail>(() =>
        forgeAuthApi.projects[project_id]!.workflows[workflow_id]!.get()
      ),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => {
      const workflow_status = query.state.data?.status;
      return workflow_status === 'PENDING' || workflow_status === 'GENERATING' ? 1_500 : false;
    },
  });
  const workflows_query = useQuery({
    queryKey: projectQueryKeys.workflows(project_id),
    queryFn: () =>
      apiCall<ProjectWorkflowSummary[]>(() => forgeAuthApi.projects[project_id]!.workflows.get()),
    retry: false,
  });
  const files_query = useQuery({
    queryKey: projectQueryKeys.files(project_id),
    queryFn: () => apiCall<FileMeta[]>(() => forgeAuthApi.projects[project_id]!.files.get()),
    retry: false,
  });

  const active_workflow = workflow_query.data;
  // The design is per-workflow: gate on the selected workflow's own generation status so a failed or
  // pending sibling never hides a ready workflow.
  const workflow_status = active_workflow?.status;
  const is_workflow_ready = workflow_status === 'READY';
  const design_query = useQuery({
    queryKey: projectQueryKeys.workflowDesign(project_id, workflow_id),
    queryFn: () =>
      apiCall<ProjectWorkflowDesign>(() =>
        forgeAuthApi.projects[project_id]!.workflows[workflow_id]!.design.get()
      ),
    retry: false,
    enabled: is_workflow_ready,
  });

  const can_normalize =
    active_workflow &&
    (!selected_file_id || (files_query.data !== undefined && workflows_query.data !== undefined));
  const selection = can_normalize
    ? normalizeFileSelection({
        selected_file_id,
        active_workflow,
        workflows: workflows_query.data ?? [],
        files: files_query.data ?? [],
      })
    : undefined;

  // Preserve the invalid-file notice after URL normalization removes selected_file_id.
  if (selected_file_id && selection) {
    const key = `${route_key}:${selected_file_id}:${selection.kind}`;
    if (notice_key !== key) {
      setNoticeKey(key);
      setSelectionNotice(
        selection.kind === 'invalid' ? { route_key, message: selection.message } : null
      );
    }
  }

  useEffect(() => {
    if (!selected_file_id || !selection || selection.kind === 'auxiliary') {
      normalized_search.current = null;
      return;
    }

    const search_key = `${route_key}:${selected_file_id}:${selection.kind}`;
    if (normalized_search.current === search_key) return;
    normalized_search.current = search_key;

    const next_workflow_id =
      selection.kind === 'other_workflow' ? selection.workflow_id : workflow_id;
    void navigate({
      to: '/projects/$project_id/workflows/$workflow_id/design',
      params: { project_id, workflow_id: next_workflow_id },
      search: { file_id: undefined },
      replace: true,
    });
  }, [navigate, project_id, route_key, selected_file_id, selection, workflow_id]);

  const visible_file_id =
    selection?.kind === 'auxiliary' ? selection.file_id : active_workflow?.source_file_id;
  const design_model = design_query.data
    ? buildWorkflowViewModel(design_query.data)
    : active_workflow
      ? {
          hero: {
            name: active_workflow.source_path.split('/').at(-1) ?? 'Workflow',
            workflow_file: active_workflow.source_path,
          },
          summary:
            workflow_status === 'FAILED'
              ? 'The workflow source remains available while generation is unavailable.'
              : 'The workflow source is ready while Canyon Code prepares its design.',
        }
      : undefined;

  if (workflow_query.isPending) {
    return (
      <main
        className="flex min-h-0 w-full flex-1 flex-col gap-5 px-7 pt-6 pb-6"
        data-testid="project-workflow-loading"
        aria-busy="true"
      >
        <Skeleton className="h-8 w-64 rounded-lg" />
        <div className="grid min-h-[32rem] flex-1 grid-cols-1 gap-4 lg:min-h-0 lg:grid-cols-2">
          <GraphSkeletonPanel />
          <FileEditorSkeleton className="lg:h-full lg:min-h-0" />
        </div>
      </main>
    );
  }

  if (workflow_query.error || !active_workflow) {
    return (
      <QueryError
        message="Could not load this project workflow."
        onRetry={() => void workflow_query.refetch()}
        className="m-7"
        test_id="project-workflow-error"
      />
    );
  }

  return (
    <main
      className="flex min-h-0 w-full flex-1 flex-col gap-5 px-7 pt-6 pb-6"
      data-testid="workflow-design"
    >
      {design_model ? <WorkflowHero model={design_model.hero} /> : null}

      {workflows_query.error ? (
        <QueryError
          message="Could not load the project workflow list. Source selection is temporarily limited."
          onRetry={() => void workflows_query.refetch()}
          test_id="project-workflows-error"
        />
      ) : null}
      {files_query.error ? (
        <QueryError
          message="Could not load the project source list. The active workflow source is still available."
          onRetry={() => void files_query.refetch()}
          test_id="project-files-error"
        />
      ) : null}
      {selection_notice?.route_key === route_key ? (
        <output
          className="text-foreground block rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
          data-testid="file-selection-error"
        >
          {selection_notice.message} Showing the active workflow source instead.
        </output>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col gap-3.5">
        <div className="flex flex-col gap-0.75">
          <h2 className="text-foreground text-base font-bold tracking-tight">Components</h2>
          <p className="text-muted-foreground text-[0.8125rem]">{design_model?.summary}</p>
        </div>

        <ResizablePanelGroup
          orientation="horizontal"
          id="workflow-workspace"
          className="min-h-[32rem] flex-1 lg:min-h-0"
        >
          <ResizablePanel
            id="workflow-graph-pane"
            minSize={MIN_PANE_WIDTH_PX}
            className="flex min-w-0 flex-col"
          >
            <GraphPanel
              project_id={project_id}
              workflow_id={workflow_id}
              design={design_query.data}
              status={active_workflow.status}
              is_design_pending={is_workflow_ready && design_query.isPending}
              design_error={Boolean(design_query.error)}
              retry_design={() => void design_query.refetch()}
            />
          </ResizablePanel>
          <ResizableHandle
            withHandle
            id="workflow-workspace-handle"
            aria-label="Resize the design and source panes"
            className="w-2 bg-transparent"
          />
          <ResizablePanel
            id="workflow-source-pane"
            minSize={MIN_PANE_WIDTH_PX}
            className="flex min-w-0 flex-col"
          >
            {visible_file_id ? (
              <ProjectFileEditor
                project_id={project_id}
                file_id={visible_file_id}
                className="min-w-0 lg:h-full lg:min-h-0"
              />
            ) : (
              <FileEditorSkeleton className="lg:h-full lg:min-h-0" />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </section>
    </main>
  );
}
