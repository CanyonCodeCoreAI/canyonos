// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import {
  RESOURCE_WORKFLOW_ATTRIBUTE,
  WORKFLOW_ID_ATTRIBUTE,
} from '@api/modules/telemetry/telemetry.contract';
import {
  otelLogs,
  otelMetricRollups,
  otelMetrics,
  otelSpans,
} from '@api/modules/telemetry/telemetry.schema';

import type { WorkflowSummary } from './workflows.types';

const summary_columns = {
  id: workflows.id,
  name: workflows.name,
  workflow_group_id: workflows.workflow_group_id,
  created_at: workflows.created_at,
  updated_at: workflows.updated_at,
};

// A workflow is listed only under a workflow group the caller's key opens, which has a row: one
// with no workflow group, or whose workflow group has no row, is nobody's.
export const workflows_repo = {
  async list(workflow_group_ids: readonly string[]): Promise<WorkflowSummary[]> {
    if (workflow_group_ids.length === 0) return [];
    return db
      .select(summary_columns)
      .from(workflows)
      .where(inArray(workflows.workflow_group_id, [...workflow_group_ids]))
      .orderBy(workflows.created_at);
  },

  async get(
    workflow_id: string,
    workflow_group_ids: readonly string[]
  ): Promise<WorkflowSummary | undefined> {
    if (workflow_group_ids.length === 0) return undefined;
    const [row] = await db
      .select(summary_columns)
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflow_id),
          inArray(workflows.workflow_group_id, [...workflow_group_ids])
        )
      )
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
};
