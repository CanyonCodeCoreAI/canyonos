// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from '@core/errors';
import type { AppError } from '@core/errors';

// The refusals every target answers alike.

export function unknown_workflow_group(workflow_group_id: string): AppError {
  return notFound(
    'workflow_groups.unknown_workflow_group',
    `No workflow group has the id ${workflow_group_id}`
  );
}

export function unknown_workflow(workflow_id: string): AppError {
  return notFound('workflow_groups.unknown_workflow', `No workflow has the id ${workflow_id}`);
}

export function graph_unavailable(workflow_id: string): AppError {
  return notFound(
    'workflow_groups.graph_unavailable',
    `Workflow ${workflow_id} has no agent graph: its code couldn't be read when it was ` +
      'uploaded, or it was uploaded before the API read graphs. Run `canyonos deploy` again'
  );
}
