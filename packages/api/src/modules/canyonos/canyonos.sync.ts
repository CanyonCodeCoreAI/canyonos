// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { load_prompts } from '../prompts/prompts.service';
import { registered_projects } from './canyonos.registry';
import { canyonos_repo } from './canyonos.repo';

// On Kubernetes the operator lists the projects (canyonos.registry.ts) and nothing posts
// registrations, so the dashboard stores what the list says, by project id. Docker
// registers projects through the CLI instead, and none of this runs there.

// How often the list is brought into the dashboard.
const SYNC_MS = 10_000;

const sync_logger = logger.child({ domain: LOG_DOMAINS.DB });

// The name stored for each listed project, so an unchanged entry costs no query.
const stored = new Map<string, string>();

/** Stores every listed project the dashboard does not have yet, and the name of one the
 * operator now lists under a new name. */
export async function sync_registered_projects(
  path: string | null = config.canyonos.projectsFile
): Promise<void> {
  for (const entry of registered_projects(path).values()) {
    if (stored.get(entry.project_id) === entry.name) continue;
    const first = !stored.has(entry.project_id);
    try {
      await canyonos_repo.save_listed_project({
        project_id: entry.project_id,
        name: entry.name,
        redis_port: entry.redis.port,
      });
      stored.set(entry.project_id, entry.name);
    } catch (error) {
      sync_logger.warn('Could not store a listed project', {
        error,
        project_id: entry.project_id,
      });
      continue;
    }
    if (first) {
      // A failed prompt load must not fail the sync: the prompts listing stores them later.
      await load_prompts(entry.project_id).catch((error: unknown) =>
        sync_logger.warn('Could not load stored prompts', { error })
      );
    }
  }
}

/** Syncs the operator's list now, then every SYNC_MS. */
export async function start_registered_projects_sync(): Promise<void> {
  await sync_registered_projects();
  setInterval(() => void sync_registered_projects(), SYNC_MS).unref();
}
