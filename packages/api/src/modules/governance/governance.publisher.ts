// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

import { running_workflows, with_redis } from '../canyonos/canyonos.redis';
import { registered_workflows } from '../canyonos/canyonos.registry';
import { canyonos_repo } from '../canyonos/canyonos.repo';
import { governance_repo } from './governance.repo';
import type { GovernanceConfig } from './governance.repo';

const publisher_logger = logger.child({ domain: LOG_DOMAINS.WORKER });

function governed_agents(governance: GovernanceConfig): { name: string; since: string }[] {
  return Object.entries(governance.agents).flatMap(([name, { spend }]) =>
    spend?.since !== undefined && spend.rules.length > 0 ? [{ name, since: spend.since }] : []
  );
}

/** Writes the governed spend of the workflow's group, `{}` when no agent is governed, so
 * no stale figure stays. */
export async function publish_spend(redis: RedisClient, workflow_id: string): Promise<void> {
  const agents = governed_agents(await governance_repo.read_config(redis));
  await governance_repo.write_spend(redis, await governance_repo.spend_since(workflow_id, agents));
}

/** A workflow whose controller is not the one on its Redis is skipped: it is not running. On
 * Kubernetes its Redis is the one the operator lists, with its password, and a workflow the
 * operator no longer lists is skipped too; on Docker it is the Redis the workflow registered,
 * with its password too. */
async function publish_workflow_spend(workflow_id: string): Promise<void> {
  if (config.canyonos.workflowsFile && !registered_workflows().has(workflow_id)) return;
  await with_redis(workflow_id, async (redis: RedisClient) => {
    if (!(workflow_id in (await running_workflows(redis)))) return;
    await publish_spend(redis, workflow_id);
  });
}

/** Writes every running workflow's governed spend to its controller; one failure skips one workflow. */
export async function publish_spend_once(): Promise<void> {
  const registrations = await canyonos_repo.list_registrations();
  await Promise.all(
    registrations.map(({ workflow_id }) =>
      publish_workflow_spend(workflow_id).catch((error: unknown) =>
        publisher_logger.warn('Could not publish governance spend', { workflow_id, error })
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
          publisher_logger.warn('Could not list workflows to publish governance spend', { error })
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
