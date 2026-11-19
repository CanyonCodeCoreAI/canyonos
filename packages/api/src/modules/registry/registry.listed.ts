// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

// On Kubernetes one dashboard serves every workflow group, each with its own Redis. The
// CanyonOS operator lists them, one entry per CanyonProject, with how to reach and sign in to
// each Redis, in a Secret the dashboard mounts as a file (CANYONOS_PROJECTS_FILE); nothing posts
// registrations. The workflows of each come from its Redis (registry.service.ts). On Docker
// there is no file and nothing here changes.

const ListedRedisSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(false),
  username: z.string().default(''),
  password: z.string().default(''),
});

// The operator's file still calls each workflow group a project: `project_id` is the
// CanyonProject's projectID, which is the workflow_group_id.
const ListedWorkflowGroupSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1),
  redis: ListedRedisSchema,
});

const ProjectsFileSchema = z.object({ projects: z.array(ListedWorkflowGroupSchema) });

export type ListedWorkflowGroup = z.infer<typeof ListedWorkflowGroupSchema>;

const listed_logger = logger.child({ domain: LOG_DOMAINS.DB });

interface Cached {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: Map<string, ListedWorkflowGroup>;
}

let cached: Cached | null = null;

/** The workflow groups listed in the operator's file, by workflow_group_id; empty without a
 * file. The file is read again when it changes (a mounted Secret is replaced, not edited in
 * place). */
export async function listed_workflow_groups(
  path: string | null = config.canyonos.workflowsFile
): Promise<Map<string, ListedWorkflowGroup>> {
  if (!path) return new Map();
  const file = Bun.file(path);
  let stat;
  try {
    stat = await file.stat();
  } catch {
    return new Map();
  }
  if (cached?.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }
  try {
    const parsed = ProjectsFileSchema.parse(await file.json());
    const entries = new Map(parsed.projects.map((entry) => [entry.project_id, entry]));
    cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, entries };
    return entries;
  } catch (error) {
    // A half-written or broken file keeps the last good list rather than losing every workflow.
    listed_logger.warn('Could not read the workflow groups the operator lists', { error, path });
    return cached?.path === path ? cached.entries : new Map();
  }
}
