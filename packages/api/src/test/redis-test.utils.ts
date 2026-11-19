// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { RedisClient } from 'bun';

import { ENDPOINT_KEY } from '@api/modules/monitoring/monitoring.repo';
import { config } from '@core/env';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';
export const PROMPTS_CONFIG_KEY = 'prompts:config';
export const PROMPTS_YAML_KEY = 'prompts:yaml';
export const SCALING_CONFIG_KEY = 'scaling:config';
export const ACTIVE_AGENTS_KEY = 'agents:active';
export const GOVERNANCE_CONFIG_KEY = 'governance:config';
export const GOVERNANCE_SPEND_KEY = 'governance:spend';
export const LLMS_CONFIG_KEY = 'llms:config';
export const UP_AGENTS_KEY = 'routing_table:up';

/** The workflow group, and the name of the workflow, a seeded workflow runs as. */
export const TEST_WORKFLOW_GROUP_ID = '00000000-0000-4000-8000-000000000000';
export const TEST_WORKFLOW = 'app';

/** An agent as the controller publishes it: its spec, desired count and newest load sample. */
export interface SeededAgent {
  readonly name: string;
  /** Its workflow, TEST_WORKFLOW unless given. */
  readonly workflow?: string;
  readonly type?: 'agent' | 'database';
  readonly replicas?: number;
  readonly desired?: number;
  /** Written as-is instead of the spec, to stand in for a controller that wrote junk. */
  readonly raw_spec?: string;
  readonly raw_sample?: string;
  readonly sample?: {
    readonly replicas_running: number;
    readonly replicas_expected: number;
    readonly queue_length_total: number;
    readonly requests_per_minute_per_replica: number;
    readonly observed_at: number;
  };
}

export interface StoredSystemPrompt {
  readonly version: string;
  readonly content: string;
  readonly updated_at: string | null;
  readonly live?: boolean;
}

export interface PromptsConfig {
  readonly prompts: Record<string, StoredSystemPrompt[]>;
}

/** prompts:config: each prompt's live version. */
export interface LivePromptsConfig {
  readonly prompts: Record<string, StoredSystemPrompt>;
}

/** Runs operation against the same Redis the API reads the running controller from. */
async function with_test_redis<T>(operation: (redis: RedisClient) => Promise<T>): Promise<T> {
  const { redisHost, redisPort } = config.canyonos;
  const redis = new RedisClient(`redis://${redisHost}:${redisPort}`, {
    autoReconnect: false,
    maxRetries: 0,
    connectionTimeout: 5000,
  });
  try {
    await redis.connect();
    return await operation(redis);
  } finally {
    redis.close();
  }
}

/** Publishes workflow_id as the running controller's one workflow, named `name`, with
 * prompts_yaml as its prompts.yaml. */
export async function seed_running_workflow(
  workflow_id: string,
  prompts_yaml: PromptsConfig,
  name: string = TEST_WORKFLOW
): Promise<void> {
  // A freshly started controller carries no leftovers from whatever the previous test corrupted.
  await reset_controller();
  await with_test_redis(async (redis) => {
    await redis.hset(CONTROLLER_IDENTITY_KEY, 'workflow_group_id', TEST_WORKFLOW_GROUP_ID);
    await redis.set(PROMPTS_YAML_KEY, JSON.stringify(prompts_yaml));
  });
  await seed_workflows({ [workflow_id]: name });
}

/** Publishes workflows, each name by its workflow_id, as the running controller's. */
export async function seed_workflows(workflows: Record<string, string>): Promise<void> {
  await with_test_redis((redis) =>
    redis.hset(CONTROLLER_IDENTITY_KEY, 'workflows', JSON.stringify(workflows))
  );
}

/** Leaves no controller running, so each test starts from the same Redis state. */
export async function reset_controller(): Promise<void> {
  await with_test_redis(async (redis) => {
    await redis.del(CONTROLLER_IDENTITY_KEY);
    await redis.del(PROMPTS_CONFIG_KEY);
    await redis.del(PROMPTS_YAML_KEY);
    await redis.del(SCALING_CONFIG_KEY);
    const agent_keys = (await redis.send('KEYS', ['agent:*'])) as string[];
    for (const key of agent_keys) await redis.del(key);
    await redis.del(ENDPOINT_KEY);
    await redis.del(ACTIVE_AGENTS_KEY);
    await redis.del(GOVERNANCE_CONFIG_KEY);
    await redis.del(GOVERNANCE_SPEND_KEY);
    await redis.del(LLMS_CONFIG_KEY);
    await redis.del(UP_AGENTS_KEY);
  });
}

/** Publishes agents the way write_config_specs and the poll loop do, newest sample first. */
export async function seed_scaling_agents(agents: readonly SeededAgent[]): Promise<void> {
  await with_test_redis(async (redis) => {
    for (const agent of agents) {
      await redis.set(
        `agent:${agent.name}:spec`,
        agent.raw_spec ??
          JSON.stringify({
            name: agent.name,
            type: agent.type,
            replicas: agent.replicas ?? 1,
            workflow: agent.workflow ?? TEST_WORKFLOW,
          })
      );
      if (agent.desired !== undefined) {
        await redis.set(`agent:${agent.name}:desired_replicas`, String(agent.desired));
      }
      const sample = agent.raw_sample ?? (agent.sample ? JSON.stringify(agent.sample) : null);
      if (sample !== null) await redis.send('LPUSH', [`agent:${agent.name}:samples`, sample]);
    }
    await redis.set(ACTIVE_AGENTS_KEY, JSON.stringify(agents.map((agent) => agent.name)));
  });
}

/** Writes the endpoint's address the way the GlobalController does. */
export async function seed_endpoint(record: Record<string, string>): Promise<void> {
  await with_test_redis(async (redis) => {
    for (const [field, value] of Object.entries(record)) {
      await redis.hset(ENDPOINT_KEY, field, value);
    }
  });
}

/** Overwrites the published agent list with a raw payload. */
export async function seed_active_agents(raw: string): Promise<void> {
  await with_test_redis((redis) => redis.set(ACTIVE_AGENTS_KEY, raw));
}

/** Publishes scaling_config as the running controller's raw scaling:config payload. */
export async function seed_scaling(scaling_config: string): Promise<void> {
  await with_test_redis((redis) => redis.set(SCALING_CONFIG_KEY, scaling_config));
}

export async function read_scaling_config(): Promise<unknown> {
  const raw = await with_test_redis((redis) => redis.get(SCALING_CONFIG_KEY));
  return raw === null ? null : JSON.parse(raw);
}

export async function read_prompts_config(): Promise<LivePromptsConfig | null> {
  const raw = await with_test_redis((redis) => redis.get(PROMPTS_CONFIG_KEY));
  return raw === null ? null : (JSON.parse(raw) as LivePromptsConfig);
}

/** Publishes config as the running controller's governance:config. */
export async function seed_governance(config: unknown): Promise<void> {
  await with_test_redis((redis) => redis.set(GOVERNANCE_CONFIG_KEY, JSON.stringify(config)));
}

/** Publishes spend (agent name to USD) as governance:spend. */
export async function seed_governance_spend(spend: Record<string, number>): Promise<void> {
  await with_test_redis((redis) => redis.set(GOVERNANCE_SPEND_KEY, JSON.stringify(spend)));
}

/** Publishes llms as the running controller's llms.yaml. */
export async function seed_llms(llms: unknown): Promise<void> {
  await with_test_redis((redis) => redis.set(LLMS_CONFIG_KEY, JSON.stringify(llms)));
}

/** Publishes agents as the ones with a replica up, the way the reconciler does. */
export async function seed_up_agents(agents: readonly string[]): Promise<void> {
  await with_test_redis((redis) => redis.sadd(UP_AGENTS_KEY, ...agents));
}

export async function read_governance_config(): Promise<unknown> {
  const raw = await with_test_redis((redis) => redis.get(GOVERNANCE_CONFIG_KEY));
  return raw === null ? null : JSON.parse(raw);
}

export async function read_desired_replicas(agent: string): Promise<string | null> {
  return with_test_redis((redis) => redis.get(`agent:${agent}:desired_replicas`));
}

export async function read_governance_spend(): Promise<unknown> {
  const raw = await with_test_redis((redis) => redis.get(GOVERNANCE_SPEND_KEY));
  return raw === null ? null : JSON.parse(raw);
}
