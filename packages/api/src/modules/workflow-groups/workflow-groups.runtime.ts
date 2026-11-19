// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RedisClient } from 'bun';

import { parse_json } from '@core/json';

import {
  ACTIVE_AGENTS_KEY,
  agent_replicas_key,
  agent_spec_key,
  desired_replicas_key,
  ENDPOINT_KEY,
  EndpointAddressSchema,
  LAUNCH_ERRORS_KEY,
  MACHINE_ERRORS_KEY,
  replica_key,
} from '../registry/registry.contract';
import { running_workflows, with_group_redis } from '../registry/registry.redis';
import type { DeployReport } from './workflow-groups.target';
import type { AgentStatus, Endpoint } from './workflow-groups.types';

// The running deploy's endpoint, agents and machine errors, read from the workflow group's
// Redis as the Global Controller and the reconciler keep them there, through the Redis
// `canyonos deploy` registered with this dashboard (PUT /v1/workflow-groups/:id/dashboard).

export type RuntimeStatus = Pick<DeployReport, 'endpoint' | 'agents' | 'machine_errors' | 'errors'>;

const NOT_REGISTERED = 'Not registered with the dashboard; run canyonos deploy again';
const NOT_PUBLISHED = 'The Global Controller has not published to its Redis yet';
const ENDPOINT_UNREADABLE = 'The endpoint the Global Controller published in Redis is unreadable';

const AgentNamesSchema = z.array(z.string());
const AgentSpecSchema = z.object({ name: z.string().min(1) });

const unread = (errors: string[]): RuntimeStatus => ({
  endpoint: null,
  agents: null,
  machine_errors: null,
  errors,
});

/** The endpoint's address, null while none is published. */
async function read_endpoint(
  redis: RedisClient
): Promise<{ endpoint: Endpoint | null; error?: string }> {
  const record = await redis.hgetall(ENDPOINT_KEY);
  if (Object.keys(record).length === 0) return { endpoint: null };
  const result = EndpointAddressSchema.safeParse(record);
  return result.success
    ? { endpoint: result.data }
    : { endpoint: null, error: ENDPOINT_UNREADABLE };
}

/** A replica counts as running once its launch finished: only the last write adds `address`. */
async function running_replicas(redis: RedisClient, agent: string): Promise<number> {
  const replica_ids = await redis.smembers(agent_replicas_key(agent));
  const addresses = await Promise.all(
    replica_ids.map((replica_id) => redis.hget(replica_key(replica_id), 'address'))
  );
  return addresses.filter(Boolean).length;
}

function desired_replicas(raw: string | null): number {
  const desired = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(desired) ? Math.max(0, desired) : 0;
}

/** Each published agent's desired and running replica counts and why its last launch failed,
 * if it did; none while no agent spec is published. */
async function read_agents(redis: RedisClient): Promise<Record<string, AgentStatus>> {
  const names = AgentNamesSchema.safeParse(parse_json(await redis.get(ACTIVE_AGENTS_KEY)));
  if (!names.success) return {};
  const launch_errors = await redis.hgetall(LAUNCH_ERRORS_KEY);
  const agents = await Promise.all(
    names.data.map(async (listed): Promise<[string, AgentStatus] | null> => {
      const spec = AgentSpecSchema.safeParse(parse_json(await redis.get(agent_spec_key(listed))));
      if (!spec.success) return null;
      const { name } = spec.data;
      return [
        name,
        {
          desired_replicas: desired_replicas(await redis.get(desired_replicas_key(name))),
          running_replicas: await running_replicas(redis, name),
          launch_error: launch_errors[name] ?? null,
        },
      ];
    })
  );
  return Object.fromEntries(agents.filter((agent) => agent !== null));
}

/** What the controller on redis keeps of the deploy, unless it runs none of `workflow_ids`:
 * then its Redis still holds an earlier deploy's state, or nothing yet. */
async function read_runtime(
  redis: RedisClient,
  workflow_ids: readonly string[]
): Promise<RuntimeStatus> {
  const running = await running_workflows(redis);
  if (!workflow_ids.some((workflow_id) => workflow_id in running)) return unread([NOT_PUBLISHED]);
  const { endpoint, error } = await read_endpoint(redis);
  return {
    endpoint,
    agents: await read_agents(redis),
    machine_errors: await redis.hgetall(MACHINE_ERRORS_KEY),
    errors: error ? [error] : [],
  };
}

/** The deploy's endpoint, agents and machine errors from the workflow group's Redis; a part
 * that could not be read is left null and named under `errors`. */
export async function read_runtime_status(workflow_group_id: string): Promise<RuntimeStatus> {
  try {
    return (await with_group_redis(workflow_group_id, read_runtime)) ?? unread([NOT_REGISTERED]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unread([`Could not read the deploy's state in Redis: ${message}`]);
  }
}
