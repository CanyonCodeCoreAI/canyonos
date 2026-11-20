// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RedisClient } from 'bun';

import { badGateway, conflict, notFound } from '@core/errors';
import { parse_json } from '@core/json';
import { update_json_key } from '@core/redis';

import {
  ACTIVE_AGENTS_KEY,
  agent_samples_key,
  agent_spec_key,
  desired_replicas_key,
  SCALING_CONFIG_KEY,
} from '../registry/registry.contract';
import { assert_workflow_running, with_redis } from '../registry/registry.redis';
import { ScalingPolicySchema } from './scaling.types';
import type {
  ScalingAgent,
  ScalingAgentsResponse,
  ScalingDeleteResponse,
  ScalingPolicy,
  ScalingResponse,
  ScalingStatus,
} from './scaling.types';

// Each workflow's config/scaling.yaml as the GC published it, by workflow name: other top-level
// keys are kept untouched on save.
const ScalingConfigSchema = z
  .object({ workflows: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();
type ScalingConfig = z.infer<typeof ScalingConfigSchema>;

// The entries the controller publishes for each agent: `workflow` is its workflow, and a database
// is never scaled.
const AgentSpecSchema = z.object({
  type: z.string().optional(),
  replicas: z.unknown(),
  workflow: z.string().optional(),
});

// The newest `agent:<name>:samples` entry, as the controller rolls one up each poll.
const AgentSampleSchema = z.object({
  replicas_running: z.number().int().nonnegative(),
  replicas_expected: z.number().int().nonnegative(),
  queue_length_total: z.number().nonnegative(),
  requests_per_minute_per_replica: z.number().nonnegative(),
  observed_at: z.number(),
});

function config_invalid(reason: string, cause: unknown) {
  return badGateway(
    'scaling.config_invalid',
    `The running controller's ${SCALING_CONFIG_KEY} ${reason}`,
    {
      cause,
    }
  );
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

/** Rewrites scaling:config with `change` applied, retrying while another writer races us. */
async function update_config(
  redis: RedisClient,
  change: (config: ScalingConfig) => ScalingConfig
): Promise<void> {
  if (await update_json_key(redis, SCALING_CONFIG_KEY, (raw) => change(parse_config(raw)))) return;
  throw conflict(
    'scaling.save_conflict',
    'The scaling policy kept changing while it was being saved, try again'
  );
}

export async function get_scaling(workflow_id: string): Promise<ScalingResponse> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    const { workflows } = parse_config(await redis.get(SCALING_CONFIG_KEY));
    return { workflows: { [workflow]: status_of(workflows[workflow]) } };
  });
}

export async function save_scaling_policy(
  workflow_id: string,
  policy: ScalingPolicy
): Promise<ScalingPolicy> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    await update_config(redis, (config) => ({
      ...config,
      workflows: { ...config.workflows, [workflow]: policy },
    }));
    return policy;
  });
}

export async function delete_scaling_policy(workflow_id: string): Promise<ScalingDeleteResponse> {
  return with_redis(workflow_id, async (redis) => {
    const workflow = await assert_workflow_running(redis, workflow_id);
    await update_config(redis, (config) => {
      if (config.workflows[workflow] == null) {
        throw notFound('scaling.policy_not_found', `No scaling policy is stored for ${workflow}`);
      }
      const { [workflow]: _, ...workflows } = config.workflows;
      return { ...config, workflows };
    });
    return { status: 'none' };
  });
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

/** A scaling agent plus the replica count its spec configures. */
export type AgentReading = Omit<ScalingAgent, 'agent_id'> & {
  readonly replicas_configured: number;
};

// A spec or sample the controller wrote badly hides that agent's figures, never the whole list.
async function read_agent(
  redis: RedisClient,
  name: string,
  workflow: string
): Promise<AgentReading | null> {
  const [spec_raw, desired_raw, [sample_raw]] = await Promise.all([
    redis.get(agent_spec_key(name)),
    redis.get(desired_replicas_key(name)),
    redis.lrange(agent_samples_key(name), 0, 0),
  ]);
  const spec = AgentSpecSchema.safeParse(parse_json(spec_raw));
  if (!spec.success || (spec.data.type ?? 'agent') !== 'agent' || spec.data.workflow !== workflow) {
    return null;
  }

  const sample = AgentSampleSchema.safeParse(parse_json(sample_raw));
  const configured =
    Number.isInteger(spec.data.replicas) && (spec.data.replicas as number) >= 0
      ? (spec.data.replicas as number)
      : 1;
  const desired = desired_raw === null ? Number.NaN : Number(desired_raw);
  return {
    name,
    replicas_configured: configured,
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

/** The workflow's active agents (databases excluded) with what each one is running right now. */
export async function read_agents(redis: RedisClient, workflow: string): Promise<AgentReading[]> {
  const names = parse_names(await redis.get(ACTIVE_AGENTS_KEY));
  const agents = await Promise.all(names.map((name) => read_agent(redis, name, workflow)));
  return agents.filter((agent) => agent !== null);
}

/** The agents the policy applies to, with what each one is running right now. */
export async function list_scaling_agents(workflow_id: string): Promise<ScalingAgentsResponse> {
  return with_redis(workflow_id, async (redis) => {
    const agents = await read_agents(redis, await assert_workflow_running(redis, workflow_id));
    return {
      agents: agents.map(({ replicas_configured: _, ...agent }) => ({
        agent_id: Bun.randomUUIDv5(agent.name, workflow_id),
        ...agent,
      })),
    };
  });
}
