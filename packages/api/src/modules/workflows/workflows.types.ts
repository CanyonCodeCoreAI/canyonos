// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const WorkflowIdParams = z.object({ workflow_id: z.string().uuid() });

// A workflow under the workflow group it runs in.
export const GroupWorkflowParams = WorkflowIdParams.extend({
  workflow_group_id: z.string().uuid(),
});

export const WorkflowSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  // The workflow group it runs in, under which its requests, metrics and settings are read.
  workflow_group_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const WorkflowDeletedSchema = z.object({ workflow_id: z.string().uuid() });

// The bundled workflows that ship a recorded run; anything else is refused, so the route can only
// ever write data the api itself carries.
export const SampleWorkflowSchema = z.enum(['helloworld', 'portfolio']);

export const SampleDataBody = z.object({ workflow: SampleWorkflowSchema });

// What the sample run added, so a caller can say so rather than guess.
export const SampleDataSchema = z.object({
  spans: z.number().int(),
  logs: z.number().int(),
  metrics: z.number().int(),
});

export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type WorkflowDeleted = z.infer<typeof WorkflowDeletedSchema>;
export type SampleWorkflow = z.infer<typeof SampleWorkflowSchema>;
