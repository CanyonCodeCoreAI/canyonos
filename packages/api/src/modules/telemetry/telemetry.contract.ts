// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// What the telemetry tables hold, as the OTLP receiver writes it. A leaf: telemetry.schema.ts
// builds its indexes from these, and every reader of the tables imports them from here.

// The receiver writes OTLP/JSON, which spells this enum as the proto's own value names.
export const STATUS_CODE = {
  UNSET: 'STATUS_CODE_UNSET',
  OK: 'STATUS_CODE_OK',
  ERROR: 'STATUS_CODE_ERROR',
} as const;

// Spans carry their workflow's id, and that of the workflow group it runs in.
export const WORKFLOW_ID_ATTRIBUTE = 'canyonos.workflow.id';
export const WORKFLOW_GROUP_ID_ATTRIBUTE = 'canyonos.workflow_group.id';

/** The resource attribute a workflow's metrics and logs carry its id in; its workflow group's id
 * is WORKFLOW_GROUP_ID_ATTRIBUTE there too. */
export const RESOURCE_WORKFLOW_ATTRIBUTE = 'canyonos.workflow.id';
