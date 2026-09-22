import type { WorkflowStatus } from './workflows.types';

export interface WorkflowStatusInput {
  readonly generation_status: string;
  readonly stale_at: string | null;
  readonly has_design: boolean;
}

/**
 * The single source of truth for a workflow's externally-visible status. A pending stale signal
 * outranks the stored generation_status because the design is known to be out of date; a READY row
 * whose design was lost reads as FAILED. Mirrors the per-row precedence in projects.service get_status.
 */
export function derive_workflow_status(row: WorkflowStatusInput): WorkflowStatus {
  if (row.stale_at !== null) return 'PENDING';
  if (row.generation_status === 'READY') return row.has_design ? 'READY' : 'FAILED';
  return row.generation_status as WorkflowStatus;
}
