// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { governance_repo } from './governance.repo';
import type { GovernanceConfig } from './governance.repo';

// A registered-workflows job, which registry.service.ts runs on every running workflow each
// tick: the LLM gateway denies or switches a governed agent's calls past its spend by it.

export const PUBLISH_SPEND_FAILED = 'Could not publish governance spend';

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
