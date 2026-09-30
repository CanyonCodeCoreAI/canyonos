import { z } from 'zod';
import type { RedisClient } from 'bun';

import { badGateway, conflict, notFound } from '@core/errors';

import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import { ScalingPolicySchema } from './scaling.types';
import type { ScalingDeleteResponse, ScalingPolicy, ScalingResponse } from './scaling.types';

const ACTIVE_AGENTS_KEY = 'agents:active';
const CONFIG_KEY = 'scaling:config';
const SAVE_ATTEMPTS = 5;

// config/scaling.yaml as the GC published it: other top-level keys are kept untouched on save.
const ScalingConfigSchema = z
  .object({ scaling: z.record(z.string(), z.unknown()).nullish() })
  .passthrough();
type ScalingConfig = z.infer<typeof ScalingConfigSchema>;

function config_invalid(reason: string, cause: unknown) {
  return badGateway('scaling.config_invalid', `The running controller's ${CONFIG_KEY} ${reason}`, {
    cause,
  });
}

function parse_config(raw: string | null): ScalingConfig {
  let document: unknown;
  try {
    document = JSON.parse(raw ?? '{}');
  } catch (error) {
    throw config_invalid('is not valid JSON', error);
  }
  const result = ScalingConfigSchema.safeParse(document);
  if (!result.success) throw config_invalid('is not a scaling document', result.error);
  return result.data;
}

function parse_active_agents(value: string | null): string[] {
  return z.array(z.string()).parse(JSON.parse(value ?? '[]'));
}

/**
 * Rewrites scaling:config with `change` applied, retrying while another writer races us.
 * WATCH makes EXEC a no-op (null) when the key changed after our read.
 */
async function update_config(
  redis: RedisClient,
  agent_name: string,
  change: (config: ScalingConfig) => ScalingConfig
): Promise<void> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    await redis.send('WATCH', [CONFIG_KEY]);
    const next = change(parse_config(await redis.get(CONFIG_KEY)));
    await redis.send('MULTI', []);
    await redis.send('SET', [CONFIG_KEY, JSON.stringify(next)]);
    if ((await redis.send('EXEC', [])) !== null) return;
  }
  throw conflict(
    'scaling.save_conflict',
    `The scaling policy for "${agent_name}" kept changing while it was being saved, try again`
  );
}

export async function get_scaling(project_id: string): Promise<ScalingResponse> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    const [active_agents, config] = await Promise.all([
      redis.get(ACTIVE_AGENTS_KEY),
      redis.get(CONFIG_KEY),
    ]);

    const policies: Record<string, ScalingPolicy> = {};
    const invalid: string[] = [];
    for (const [agent_name, value] of Object.entries(parse_config(config).scaling ?? {})) {
      const result = ScalingPolicySchema.safeParse(value);
      if (result.success) policies[agent_name] = result.data;
      else invalid.push(agent_name);
    }
    return { agents: parse_active_agents(active_agents), policies, invalid };
  });
}

export async function save_scaling_policy(
  project_id: string,
  agent_name: string,
  policy: ScalingPolicy
): Promise<ScalingPolicy> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    const agents = parse_active_agents(await redis.get(ACTIVE_AGENTS_KEY));
    if (!agents.includes(agent_name)) {
      throw notFound(
        'scaling.agent_not_found',
        `Agent "${agent_name}" was not found in the running controller`
      );
    }

    await update_config(redis, agent_name, (config) => ({
      ...config,
      scaling: { ...config.scaling, [agent_name]: policy },
    }));
    return policy;
  });
}

export async function delete_scaling_policy(
  project_id: string,
  agent_name: string
): Promise<ScalingDeleteResponse> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    await update_config(redis, agent_name, (config) => {
      if (!config.scaling || !(agent_name in config.scaling)) {
        throw notFound(
          'scaling.policy_not_found',
          `No scaling policy is stored for agent "${agent_name}"`
        );
      }
      const scaling = Object.fromEntries(
        Object.entries(config.scaling).filter(([name]) => name !== agent_name)
      );
      return { ...config, scaling };
    });
    return { agent_name };
  });
}
