// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  files,
  otelLogs,
  otelMetrics,
  otelSpans,
  projects,
  projectWorkflows,
} from '@api/db/schema';
import { PROJECT_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';
import { RESOURCE_PROJECT_ATTRIBUTE } from '@api/modules/monitoring/monitoring.signals';

import type { ProjectSummary } from './projects.types';

export interface ProjectComponentCounts {
  readonly file_count: number;
  readonly agent_count: number;
  readonly tool_count: number;
}

export const projects_repo = {
  async list_with_counts(): Promise<ProjectSummary[]> {
    return db
      .select({
        id: projects.id,
        name: projects.name,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .groupBy(projects.id)
      .orderBy(projects.created_at);
  },

  async get_with_count(project_id: string): Promise<ProjectSummary | undefined> {
    const [row] = await db
      .select({
        id: projects.id,
        name: projects.name,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .where(eq(projects.id, project_id))
      .groupBy(projects.id)
      .limit(1);
    return row;
  },

  async exists(project_id: string): Promise<boolean> {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project_id))
      .limit(1);
    return row !== undefined;
  },

  /** Deletes the project, the rows that reference it, and its telemetry. */
  async delete(project_id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(otelSpans)
        .where(sql`${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} = ${project_id}`);
      await tx
        .delete(otelLogs)
        .where(
          sql`${otelLogs.resource_attributes} ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`
        );
      await tx
        .delete(otelMetrics)
        .where(
          sql`${otelMetrics.resource_attributes} ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`
        );
      await tx.delete(projects).where(eq(projects.id, project_id));
    });
  },

  async get_component_counts(project_id: string): Promise<ProjectComponentCounts | undefined> {
    const [row] = await db
      .select({
        file_count: sql<number>`count(${files.id})::int`,
        agent_count: sql<number>`count(*) filter (where ${files.component_kind} = 'agent')::int`,
        tool_count: sql<number>`count(*) filter (where ${files.component_kind} = 'tool')::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .where(eq(projects.id, project_id))
      .groupBy(projects.id)
      .limit(1);
    return row;
  },

  // A READY workflow with no design, or one marked stale, is not ready: its design is missing or
  // out of date with the files it was read from.
  async get_workflow_counts(
    project_id: string
  ): Promise<{ workflow_count: number; ready_workflow_count: number }> {
    const [row] = await db
      .select({
        workflow_count: sql<number>`count(*)::int`,
        ready_workflow_count: sql<number>`count(*) filter (where ${projectWorkflows.generation_status} = 'READY' and ${projectWorkflows.stale_at} is null and ${projectWorkflows.design} is not null)::int`,
      })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.project_id, project_id));
    return row ?? { workflow_count: 0, ready_workflow_count: 0 };
  },
};
