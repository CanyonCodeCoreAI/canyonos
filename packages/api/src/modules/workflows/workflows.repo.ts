// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  files,
  otelLogs,
  otelMetricRollups,
  otelMetrics,
  otelSpans,
  workflows,
} from '@api/db/schema';
import { WORKFLOW_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';
import { RESOURCE_WORKFLOW_ATTRIBUTE } from '@api/modules/monitoring/monitoring.signals';

import type { WorkflowSummary } from './workflows.types';

export interface WorkflowComponentCounts {
  readonly file_count: number;
  readonly agent_count: number;
  readonly tool_count: number;
}

export const workflows_repo = {
  async list_with_counts(): Promise<WorkflowSummary[]> {
    return db
      .select({
        id: workflows.id,
        name: workflows.name,
        created_at: workflows.created_at,
        updated_at: workflows.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(workflows)
      .leftJoin(files, eq(files.workflow_id, workflows.id))
      .groupBy(workflows.id)
      .orderBy(workflows.created_at);
  },

  async get_with_count(workflow_id: string): Promise<WorkflowSummary | undefined> {
    const [row] = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        created_at: workflows.created_at,
        updated_at: workflows.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(workflows)
      .leftJoin(files, eq(files.workflow_id, workflows.id))
      .where(eq(workflows.id, workflow_id))
      .groupBy(workflows.id)
      .limit(1);
    return row;
  },

  /** The workflow group the workflow runs in. */
  async workflow_group_id(workflow_id: string): Promise<string | null> {
    const [row] = await db
      .select({ workflow_group_id: workflows.workflow_group_id })
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    return row?.workflow_group_id ?? null;
  },

  async exists(workflow_id: string): Promise<boolean> {
    const [row] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    return row !== undefined;
  },

  /** Deletes the workflow, the rows that reference it, and its telemetry. */
  async delete(workflow_id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(otelSpans)
        .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`);
      await tx
        .delete(otelLogs)
        .where(
          sql`${otelLogs.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
        );
      await tx
        .delete(otelMetrics)
        .where(
          sql`${otelMetrics.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
        );
      await tx
        .delete(otelMetricRollups)
        .where(
          sql`${otelMetricRollups.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
        );
      await tx.delete(workflows).where(eq(workflows.id, workflow_id));
    });
  },

  async get_component_counts(workflow_id: string): Promise<WorkflowComponentCounts | undefined> {
    const [row] = await db
      .select({
        file_count: sql<number>`count(${files.id})::int`,
        agent_count: sql<number>`count(*) filter (where ${files.component_kind} = 'agent')::int`,
        tool_count: sql<number>`count(*) filter (where ${files.component_kind} = 'tool')::int`,
      })
      .from(workflows)
      .leftJoin(files, eq(files.workflow_id, workflows.id))
      .where(eq(workflows.id, workflow_id))
      .groupBy(workflows.id)
      .limit(1);
    return row;
  },
};
