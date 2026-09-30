import { RedisClient } from 'bun';

import { config } from '@core/env';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';
export const PROMPTS_CONFIG_KEY = 'prompts:config';
export const ACTIVE_AGENTS_KEY = 'agents:active';
export const SCALING_CONFIG_KEY = 'scaling:config';

export interface StoredPromptVersion {
  readonly version: string;
  readonly system: string;
  readonly user: string;
  readonly updated_at: string | null;
}

export interface PromptsConfig {
  readonly prompts: Record<string, StoredPromptVersion[]>;
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

/** Publishes project_id as the running controller, with prompts_config as its prompt config. */
export async function seed_running_project(
  project_id: string,
  prompts_config: PromptsConfig
): Promise<void> {
  await with_test_redis(async (redis) => {
    await redis.hset(CONTROLLER_IDENTITY_KEY, 'project_id', project_id);
    await redis.set(PROMPTS_CONFIG_KEY, JSON.stringify(prompts_config));
  });
}

/** Leaves no controller running, so each test starts from the same Redis state. */
export async function reset_controller(): Promise<void> {
  await with_test_redis(async (redis) => {
    await redis.del(CONTROLLER_IDENTITY_KEY);
    await redis.del(PROMPTS_CONFIG_KEY);
    await redis.del(ACTIVE_AGENTS_KEY);
    await redis.del(SCALING_CONFIG_KEY);
  });
}

/** Publishes the running controller's agents and, unless null, the raw scaling:config payload. */
export async function seed_scaling(
  active_agents: readonly string[],
  scaling_config: string | null
): Promise<void> {
  await with_test_redis(async (redis) => {
    await redis.set(ACTIVE_AGENTS_KEY, JSON.stringify(active_agents));
    if (scaling_config !== null) await redis.set(SCALING_CONFIG_KEY, scaling_config);
  });
}

export async function read_scaling_config(): Promise<unknown> {
  const raw = await with_test_redis((redis) => redis.get(SCALING_CONFIG_KEY));
  return raw === null ? null : JSON.parse(raw);
}

export async function read_prompts_config(): Promise<PromptsConfig | null> {
  const raw = await with_test_redis((redis) => redis.get(PROMPTS_CONFIG_KEY));
  return raw === null ? null : (JSON.parse(raw) as PromptsConfig);
}
