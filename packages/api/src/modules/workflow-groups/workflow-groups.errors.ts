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
