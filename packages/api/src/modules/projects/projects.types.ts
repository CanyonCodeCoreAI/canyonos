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

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;
export type ProjectDeleted = z.infer<typeof ProjectDeletedSchema>;
