import { RedisClient } from 'bun';

import { config } from '@core/env';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';
export const PROMPTS_CONFIG_KEY = 'prompts:config';
export const PROMPTS_YAML_KEY = 'prompts:yaml';
export const SCALING_CONFIG_KEY = 'scaling:config';
export const ACTIVE_AGENTS_KEY = 'agents:active';

/** An agent as the controller publishes it: its spec, desired count and newest load sample. */
export interface SeededAgent {
  readonly name: string;
  readonly type?: 'agent' | 'workflow' | 'database';
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

/** Publishes project_id as the running controller, with prompts_yaml as its prompts.yaml. */
export async function seed_running_project(
  project_id: string,
  prompts_yaml: PromptsConfig
): Promise<void> {
  await with_test_redis(async (redis) => {
    await redis.hset(CONTROLLER_IDENTITY_KEY, 'project_id', project_id);
    await redis.set(PROMPTS_YAML_KEY, JSON.stringify(prompts_yaml));
  });
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
    await redis.del(ACTIVE_AGENTS_KEY);
  });
}

/** Publishes agents the way write_config_specs and the poll loop do, newest sample first. */
export async function seed_scaling_agents(agents: readonly SeededAgent[]): Promise<void> {
  await with_test_redis(async (redis) => {
    for (const agent of agents) {
      await redis.set(
        `agent:${agent.name}:spec`,
        agent.raw_spec ??
          JSON.stringify({ name: agent.name, type: agent.type, replicas: agent.replicas ?? 1 })
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
