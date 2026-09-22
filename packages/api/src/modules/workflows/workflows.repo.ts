import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { files, projects, projectWorkflows } from '@api/db/schema';

import type { WorkflowDesignPayload } from './workflows.types';

export type ProjectWorkflowRow = typeof projectWorkflows.$inferSelect;

export interface WorkflowJob {
  readonly project_id: string;
  readonly workflow_id: string;
}

export interface ProjectWorkflowClaim {
  readonly generation_revision: number;
  readonly source_file_id: string;
}

export interface ProjectWorkflowGenerationState {
  readonly workflow_id: string;
  readonly generation_status: string;
  readonly stale_at: string | null;
  readonly error_message: string | null;
  readonly updated_at: string;
  readonly has_design: boolean;
}

export interface WorkflowListRow {
  readonly id: string;
  readonly project_id: string;
  readonly source_file_id: string;
  readonly source_path: string;
  readonly updated_at: string;
  readonly generation_status: string;
  readonly stale_at: string | null;
  readonly has_design: boolean;
}

export interface WorkflowDetailRow extends ProjectWorkflowRow {
  readonly source_path: string;
  readonly project_name: string;
}

// A row needs (re)generation only when it is freshly PENDING or carries a stale lease. A healthy
// in-flight row (GENERATING with no stale lease) is intentionally excluded so a concurrent enqueue
// cannot steal it — see claim_generation.
const needs_generation = or(
  eq(projectWorkflows.generation_status, 'PENDING'),
  isNotNull(projectWorkflows.stale_at)
);

const exact_claim_where = (project_id: string, workflow_id: string, generation_revision: number) =>
  and(
    eq(projectWorkflows.project_id, project_id),
    eq(projectWorkflows.id, workflow_id),
    eq(projectWorkflows.generation_revision, generation_revision),
    eq(projectWorkflows.generation_status, 'GENERATING'),
    sql`${projectWorkflows.stale_at} is null`
  );

export const workflows_repo = {
  async list_for_project(project_id: string): Promise<WorkflowListRow[]> {
    return db
      .select({
        id: projectWorkflows.id,
        project_id: projectWorkflows.project_id,
        source_file_id: projectWorkflows.source_file_id,
        source_path: files.path,
        updated_at: projectWorkflows.updated_at,
        generation_status: projectWorkflows.generation_status,
        stale_at: projectWorkflows.stale_at,
        has_design: sql<boolean>`${projectWorkflows.design} is not null`,
      })
      .from(projectWorkflows)
      .innerJoin(files, eq(projectWorkflows.source_file_id, files.id))
      .where(eq(projectWorkflows.project_id, project_id))
      .orderBy(files.path);
  },

  async find_in_project(
    project_id: string,
    workflow_id: string
  ): Promise<WorkflowDetailRow | undefined> {
    const [row] = await db
      .select({
        workflow: projectWorkflows,
        source_path: files.path,
        project_name: projects.name,
      })
      .from(projectWorkflows)
      .innerJoin(projects, eq(projectWorkflows.project_id, projects.id))
      .innerJoin(files, eq(projectWorkflows.source_file_id, files.id))
      .where(and(eq(projectWorkflows.project_id, project_id), eq(projectWorkflows.id, workflow_id)))
      .limit(1);
    return row
      ? { ...row.workflow, source_path: row.source_path, project_name: row.project_name }
      : undefined;
  },

  async list_generation_states(project_id: string): Promise<ProjectWorkflowGenerationState[]> {
    return db
      .select({
        workflow_id: projectWorkflows.id,
        generation_status: projectWorkflows.generation_status,
        stale_at: projectWorkflows.stale_at,
        error_message: projectWorkflows.error_message,
        updated_at: projectWorkflows.updated_at,
        has_design: sql<boolean>`${projectWorkflows.design} is not null`,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.project_id, project_id))
      .orderBy(projectWorkflows.created_at, projectWorkflows.id);
  },

  async list_work_needed(): Promise<WorkflowJob[]> {
    return db
      .select({
        project_id: projectWorkflows.project_id,
        workflow_id: projectWorkflows.id,
      })
      .from(projectWorkflows)
      .where(needs_generation);
  },

  // Boot-only recovery. A hard process kill can leave a row GENERATING with no stale lease, which
  // claim_generation refuses to steal at runtime. On boot no worker is in flight, so every such row
  // is orphaned: mark it stale so the normal claim path reclaims it.
  async reclaim_orphaned_generations(): Promise<number> {
    const rows = await db
      .update(projectWorkflows)
      .set({ stale_at: sql`now()` })
      .where(
        and(
          eq(projectWorkflows.generation_status, 'GENERATING'),
          sql`${projectWorkflows.stale_at} is null`
        )
      )
      .returning({ id: projectWorkflows.id });
    return rows.length;
  },

  async claim_generation(
    project_id: string,
    workflow_id: string
  ): Promise<ProjectWorkflowClaim | undefined> {
    const [row] = await db
      .update(projectWorkflows)
      .set({
        generation_revision: sql`${projectWorkflows.generation_revision} + 1`,
        generation_status: 'GENERATING',
        stale_at: null,
      })
      .where(
        and(
          eq(projectWorkflows.project_id, project_id),
          eq(projectWorkflows.id, workflow_id),
          needs_generation
        )
      )
      .returning({
        generation_revision: projectWorkflows.generation_revision,
        source_file_id: projectWorkflows.source_file_id,
      });
    return row
      ? { generation_revision: row.generation_revision, source_file_id: row.source_file_id }
      : undefined;
  },

  async complete_ready(
    project_id: string,
    workflow_id: string,
    generation_revision: number,
    model: string,
    design: WorkflowDesignPayload
  ): Promise<boolean> {
    const rows = await db
      .update(projectWorkflows)
      .set({
        generation_status: 'READY',
        design,
        error_message: null,
        model,
        updated_at: sql`now()`,
      })
      .where(exact_claim_where(project_id, workflow_id, generation_revision))
      .returning({ id: projectWorkflows.id });
    return rows.length === 1;
  },

  // Every generation failure — expected error, missing source, or an unexpected crash — resolves the
  // same way: FAILED with the error persisted and retry still possible. Any retained design is left
  // in place but is unreachable while FAILED, so last-good is never silently served as current.
  async complete_failed(
    project_id: string,
    workflow_id: string,
    generation_revision: number,
    model: string,
    error_message: string
  ): Promise<boolean> {
    const rows = await db
      .update(projectWorkflows)
      .set({
        generation_status: 'FAILED',
        error_message,
        model,
        updated_at: sql`now()`,
      })
      .where(exact_claim_where(project_id, workflow_id, generation_revision))
      .returning({ id: projectWorkflows.id });
    return rows.length === 1;
  },
};
