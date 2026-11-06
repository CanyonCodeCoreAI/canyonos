// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ProjectIdParams = z.object({ project_id: z.string().uuid() });

export const ProjectSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  file_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ProjectStatsSchema = z.object({
  project_id: z.string().uuid(),
  file_count: z.number().int().nonnegative(),
  workflow_count: z.number().int().nonnegative(),
  ready_workflow_count: z.number().int().nonnegative(),
  agent_count: z.number().int().nonnegative(),
  tool_count: z.number().int().nonnegative(),
});

export const ProjectDeletedSchema = z.object({ project_id: z.string().uuid() });

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

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;
export type ProjectDeleted = z.infer<typeof ProjectDeletedSchema>;
export type SampleWorkflow = z.infer<typeof SampleWorkflowSchema>;
