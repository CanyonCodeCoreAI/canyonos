// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { load_prompts } from '../prompts/prompts.service';
import { running_workflows, with_redis_target } from './canyonos.redis';
import { registered_workflow_groups } from './canyonos.registry';
import { canyonos_repo } from './canyonos.repo';
import type { RegistryEntry } from './canyonos.registry';

// On Kubernetes the operator lists the workflow groups (canyonos.registry.ts) and nothing posts
// registrations, so the dashboard stores the workflows each listed group's Global Controller
// publishes in its Redis (`controller:identity` `workflows`), by workflow id, with their
// workflow group: the /workflows/:workflow_id routes reach the group's Redis through it. Docker
// registers workflows through the CLI instead, and none of this runs there.

// How often the list is brought into the dashboard.
const SYNC_MS = 10_000;

const sync_logger = logger.child({ domain: LOG_DOMAINS.DB });

// The name and workflow group stored for each workflow, so an unchanged one costs no query.
const stored = new Map<string, string>();

/** Stores each workflow the listed workflow group's Redis names, and removes the row an older
 * dashboard stored for the group itself. */
async function sync_workflow_group(entry: RegistryEntry): Promise<void> {
  const workflows = await with_redis_target(entry.redis, running_workflows);
  if (!stored.has(entry.project_id)) {
    await canyonos_repo.remove_group_row(entry.project_id);
    stored.set(entry.project_id, '');
  }
  for (const [workflow_id, name] of Object.entries(workflows)) {
    const record = `${entry.project_id}/${name}`;
    if (stored.get(workflow_id) === record) continue;
    const first = !stored.has(workflow_id);
    await canyonos_repo.save_listed_workflow({
      workflow_id,
      name,
      workflow_group_id: entry.project_id,
    });
    stored.set(workflow_id, record);
    if (first) {
      // A failed prompt load must not fail the sync: the prompts listing stores them later.
      await load_prompts(workflow_id).catch((error: unknown) =>
        sync_logger.warn('Could not load stored prompts', { error, workflow_id })
      );
    }
  }
}

/** Stores every workflow of each listed workflow group, read from its Redis each time, so a
 * workflow added to a running group shows up; a group whose Redis cannot be read is skipped
 * until the next sync. */
export async function sync_registered_workflows(
  path: string | null = config.canyonos.workflowsFile
): Promise<void> {
  for (const entry of registered_workflow_groups(path).values()) {
    await sync_workflow_group(entry).catch((error: unknown) =>
      sync_logger.warn("Could not store a listed workflow group's workflows", {
        error,
        workflow_group_id: entry.project_id,
      })
    );
  }
}

/** Syncs the operator's list now, then every SYNC_MS. */
export async function start_registered_workflows_sync(): Promise<void> {
  await sync_registered_workflows();
  setInterval(() => void sync_registered_workflows(), SYNC_MS).unref();
}

/** For tests: forget what was stored, so the next sync stores everything again. */
export function forget_synced_workflows(): void {
  stored.clear();
}
