// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { project_running, with_redis_at } from '../canyonos/canyonos.redis';
import { canyonos_repo } from '../canyonos/canyonos.repo';
import { governance_repo } from './governance.repo';
import type { GovernanceConfig } from './governance.repo';

const publisher_logger = logger.child({ domain: LOG_DOMAINS.WORKER });

function governed_agents(governance: GovernanceConfig): { name: string; since: string }[] {
  return Object.entries(governance.agents).flatMap(([name, { spend }]) =>
    spend?.since !== undefined && spend.rules.length > 0 ? [{ name, since: spend.since }] : []
  );
}

/** Writes the project's governed spend, `{}` when no agent is governed, so no stale figure stays. */
export async function publish_spend(redis: RedisClient, project_id: string): Promise<void> {
  const agents = governed_agents(await governance_repo.read_config(redis));
  await governance_repo.write_spend(redis, await governance_repo.spend_since(project_id, agents));
}

/** A project whose controller is not the one on its port is skipped: it is not running. */
async function publish_project_spend(project_id: string, redis_port: number): Promise<void> {
  await with_redis_at(redis_port, async (redis) => {
    if (!(await project_running(redis, project_id))) return;
    await publish_spend(redis, project_id);
  });
}

/** Writes every running project's governed spend to its controller; one failure skips one project. */
export async function publish_spend_once(): Promise<void> {
  const registrations = await canyonos_repo.list_registrations();
  await Promise.all(
    registrations.map(({ project_id, redis_port }) =>
      publish_project_spend(project_id, redis_port).catch((error: unknown) =>
        publisher_logger.warn('Could not publish governance spend', { project_id, error })
      )
    )
  );
}

/** Re-arms after each tick ends, so a slow tick never overlaps the next. */
export function start_governance_publisher({
  interval_ms = config.governance.publishIntervalMs,
}: { interval_ms?: number } = {}): { stop(): void; tick(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      publish_spend_once()
        .catch((error: unknown) =>
          publisher_logger.warn('Could not list projects to publish governance spend', { error })
        )
        .finally(arm);
    }, interval_ms);
    timer.unref();
  };
  arm();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    tick: publish_spend_once,
  };
}
