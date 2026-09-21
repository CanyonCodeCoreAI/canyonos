import type { FileMeta } from '@cc-forge/api/projects';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowSummary,
  WorkflowStat,
} from '@cc-forge/api/workflows';

import type { LegendItem } from '@repo/ui/components/legend';

export interface WorkflowHeroModel {
  readonly name: string;
  readonly workflow_file: string;
}

export type WorkflowLegendItem = LegendItem;

export interface WorkflowEdgeLegendItem {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly dashed: boolean;
}

export interface WorkflowViewModel {
  readonly hero: WorkflowHeroModel;
  readonly summary: string;
  readonly component_legend: readonly WorkflowLegendItem[];
  readonly edge_legend: readonly WorkflowEdgeLegendItem[];
}

export function buildComponentLegend(): WorkflowLegendItem[] {
  return [
    { id: 'workflow', label: 'Workflow', color: 'var(--flow-workflow)' },
    { id: 'agent', label: 'Agent', color: 'var(--flow-agent)' },
    { id: 'tool', label: 'Tool', color: 'var(--flow-tool)' },
  ];
}

export function buildEdgeLegend(stats: readonly WorkflowStat[]): WorkflowEdgeLegendItem[] {
  const loops = stats.find((stat) => stat.id === 'loops')?.value ?? 0;
  const items: WorkflowEdgeLegendItem[] = [
    { id: 'route', label: 'Route', color: 'var(--flow-edge-route)', dashed: false },
    { id: 'call', label: 'Calls tool', color: 'var(--flow-edge-call)', dashed: true },
  ];
  if (loops > 0) {
    items.push({ id: 'loop', label: 'Loop', color: 'var(--flow-edge-loop)', dashed: true });
  }
  items.push({ id: 'return', label: 'Return', color: 'var(--flow-edge-return)', dashed: true });
  return items;
}

export function buildWorkflowViewModel(design: ProjectWorkflowDesign): WorkflowViewModel {
  return {
    hero: { name: design.name, workflow_file: design.source_path },
    summary: design.summary,
    component_legend: buildComponentLegend(),
    edge_legend: buildEdgeLegend(design.stats),
  };
}

export type FileSelectionNormalization =
  | { readonly kind: 'active_source'; readonly file_id: string }
  | { readonly kind: 'auxiliary'; readonly file_id: string }
  | { readonly kind: 'other_workflow'; readonly workflow_id: string }
  | { readonly kind: 'invalid'; readonly message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeFileSelection({
  selected_file_id,
  active_workflow,
  workflows,
  files,
}: {
  readonly selected_file_id?: string;
  readonly active_workflow: ProjectWorkflowSummary;
  readonly workflows: readonly ProjectWorkflowSummary[];
  readonly files: readonly FileMeta[];
}): FileSelectionNormalization {
  if (!selected_file_id) {
    return { kind: 'active_source', file_id: active_workflow.source_file_id };
  }

  if (!UUID_PATTERN.test(selected_file_id)) {
    return { kind: 'invalid', message: 'The selected source reference is malformed.' };
  }

  if (selected_file_id === active_workflow.source_file_id) {
    return { kind: 'active_source', file_id: active_workflow.source_file_id };
  }

  const selected_file = files.find((file) => file.id === selected_file_id);
  if (!selected_file) {
    return {
      kind: 'invalid',
      message: 'The selected source is unavailable or does not belong to this project.',
    };
  }

  if (selected_file.component_kind !== 'workflow') {
    return { kind: 'auxiliary', file_id: selected_file.id };
  }

  const selected_workflow = workflows.find(
    (workflow) => workflow.source_file_id === selected_file.id
  );
  if (!selected_workflow) {
    return { kind: 'invalid', message: 'The selected workflow source has no workflow design.' };
  }

  if (selected_workflow.id === active_workflow.id) {
    return { kind: 'active_source', file_id: active_workflow.source_file_id };
  }

  return { kind: 'other_workflow', workflow_id: selected_workflow.id };
}
