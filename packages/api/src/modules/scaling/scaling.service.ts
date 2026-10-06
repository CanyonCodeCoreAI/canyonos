import { z } from 'zod';
import type { RedisClient } from 'bun';

import { badGateway, conflict, notFound } from '@core/errors';

import { assert_project_running, with_redis } from '../canyonos/canyonos.redis';
import { ScalingPolicySchema } from './scaling.types';
import type {
  ScalingAgent,
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingStatus,
} from './scaling.types';

const CONFIG_KEY = 'scaling:config';
const ACTIVE_AGENTS_KEY = 'agents:active';
const SAVE_ATTEMPTS = 5;

// config/scaling.yaml as the GC published it: other top-level keys are kept untouched on save.
const ScalingConfigSchema = z.object({ scaling: z.unknown() }).passthrough();
type ScalingConfig = z.infer<typeof ScalingConfigSchema>;

// The entries the controller publishes for each agent; a workflow or database is never scaled.
const AgentSpecSchema = z.object({ type: z.string().optional(), replicas: z.unknown() });

// The newest `agent:<name>:samples` entry, as the controller rolls one up each poll.
const AgentSampleSchema = z.object({
  replicas_running: z.number().int().nonnegative(),
  replicas_expected: z.number().int().nonnegative(),
  queue_length_total: z.number().nonnegative(),
  requests_per_minute_per_replica: z.number().nonnegative(),
  observed_at: z.number(),
});

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

/** The first rule a stored policy breaks, named the way scaling.yaml spells the field. */
function invalid_reason(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) return 'the policy is not valid';
  const field = issue.path.join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}

// A scaling.yaml from before the one-policy format: policies keyed by agent name.
const AgentKeyedSchema = z
  .record(z.string(), z.object({}).passthrough())
  .refine((entries) => Object.keys(entries).length > 0 && !('metric' in entries));

function status_of(stored: unknown): ScalingStatus {
  if (stored == null) return { status: 'none' };
  const result = ScalingPolicySchema.safeParse(stored);
  if (result.success) return { status: 'applied', policy: result.data };
  const keyed = AgentKeyedSchema.safeParse(stored);
  if (keyed.success) {
    const names = Object.keys(keyed.data).join(', ');
    return {
      status: 'invalid',
      reason: `the policy is keyed by agent name (${names}); scaling.yaml now holds one policy for the whole workflow, so move one agent's fields up to the top level`,
    };
  }
  return { status: 'invalid', reason: invalid_reason(result.error) };
}

/**
 * Rewrites scaling:config with `change` applied, retrying while another writer races us.
 * WATCH makes EXEC a no-op (null) when the key changed after our read.
 */
async function update_config(
  redis: RedisClient,
  change: (config: ScalingConfig) => ScalingConfig
): Promise<void> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    await redis.send('WATCH', [CONFIG_KEY]);
    const next = change(parse_config(await redis.get(CONFIG_KEY)));
    await redis.send('MULTI', []);
    await redis.set(CONFIG_KEY, JSON.stringify(next));
    if ((await redis.send('EXEC', [])) !== null) return;
  }
  throw conflict(
    'scaling.save_conflict',
    'The scaling policy kept changing while it was being saved, try again'
  );
}

export async function get_scaling(project_id: string): Promise<ScalingStatus> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    return status_of(parse_config(await redis.get(CONFIG_KEY)).scaling);
  });
}

export async function save_scaling_policy(
  project_id: string,
  policy: ScalingPolicy
): Promise<ScalingPolicy> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    await update_config(redis, (config) => ({ ...config, scaling: policy }));
    return policy;
  });
}

export async function delete_scaling_policy(project_id: string): Promise<ScalingDeleteResponse> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    await update_config(redis, (config) => {
      if (config.scaling == null) {
        throw notFound('scaling.policy_not_found', 'No scaling policy is stored');
      }
      return { ...config, scaling: null };
    });
    return { status: 'none' };
  });
}

/** The parsed JSON, or undefined when the stored value is missing or not JSON. */
function parse_json(raw: string | null | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parse_names(raw: string | null): string[] {
  const result = z.array(z.string()).safeParse(parse_json(raw ?? '[]'));
  if (!result.success) {
    throw badGateway(
      'scaling.config_invalid',
      `The running controller's ${ACTIVE_AGENTS_KEY} is not a list of agent names`,
      { cause: result.error }
    );
  }
  return result.data;
}

// A spec or sample the controller wrote badly hides that agent's figures, never the whole list.
async function read_agent(redis: RedisClient, name: string): Promise<ScalingAgent | null> {
  const [spec_raw, desired_raw, [sample_raw]] = await Promise.all([
    redis.get(`agent:${name}:spec`),
    redis.get(`agent:${name}:desired_replicas`),
    redis.lrange(`agent:${name}:samples`, 0, 0),
  ]);
  const spec = AgentSpecSchema.safeParse(parse_json(spec_raw));
  if (!spec.success || (spec.data.type ?? 'agent') !== 'agent') return null;

  const sample = AgentSampleSchema.safeParse(parse_json(sample_raw));
  const configured =
    Number.isInteger(spec.data.replicas) && (spec.data.replicas as number) >= 0
      ? (spec.data.replicas as number)
      : 1;
  const desired = desired_raw === null ? Number.NaN : Number(desired_raw);
  return {
    name,
    replicas_expected: Number.isInteger(desired) && desired >= 0 ? desired : configured,
    replicas_running: sample.success ? sample.data.replicas_running : 0,
    load: sample.success
      ? {
          queue_length_total: sample.data.queue_length_total,
          requests_per_minute_per_replica: sample.data.requests_per_minute_per_replica,
          observed_at: new Date(sample.data.observed_at * 1000).toISOString(),
        }
      : null,
  };
}

/** The agents the policy applies to, with what each one is running right now. */
export async function list_scaling_agents(project_id: string): Promise<ScalingAgentsResponse> {
  return with_redis(async (redis) => {
    await assert_project_running(redis, project_id);
    const names = parse_names(await redis.get(ACTIVE_AGENTS_KEY));
    const agents = await Promise.all(names.map((name) => read_agent(redis, name)));
    return { agents: agents.filter((agent) => agent !== null) };
  });
}
