// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { AppError, notFound } from '@core/errors';
import { parse_json } from '@core/json';
import { with_redis_target } from '@core/redis';
import type { RedisTarget } from '@core/redis';

import { CONTROLLER_IDENTITY_KEY, IdentityWorkflowsSchema } from './registry.contract';
import { listed_workflow_groups } from './registry.listed';
import { forget_group_networks, join_group_networks } from './registry.network';
import { registry_repo } from './registry.repo';
import type { ListedWorkflowGroup } from './registry.listed';
import type { RedisClientTls } from './registry.types';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The host the api reaches a workflow's Redis on. An api running on the host itself (its
 * configured Redis on loopback, as with `bun run dashboard:dev`) cannot resolve the container
 * name a workflow stored, so it reaches the workflow's published port on loopback instead. */
export function reachable_redis_host(stored_host: string | null): string {
  const configured = config.canyonos.redisHost;
  return stored_host === null || LOOPBACK_HOSTS.has(configured) ? configured : stored_host;
}

/** Where the api reaches a Redis registered on Docker, signing in with redis_password when
 * there is one, over TLS with redis_tls when given. */
export function registered_target(
  redis_host: string | null,
  redis_port: number,
  redis_password: string,
  redis_tls: RedisClientTls | null = null
): RedisTarget {
  return {
    host: reachable_redis_host(redis_host),
    port: redis_port,
    password: redis_password,
    tls: redis_tls ?? false,
  };
}

// Temporary: applied now so multi-workflow dashboards work without blocking the flow; revisit
// with the workflow-key design in CAN-521 (the api should not hold per-workflow Redis addresses).
/** On Kubernetes, the operator's entry for the workflow group workflow_id belongs to, which
 * says how to reach and sign in to its Redis; null while it lists none. */
export async function listed_workflow_group(
  workflow_id: string
): Promise<ListedWorkflowGroup | null> {
  const workflow_group_id = await registry_repo.workflow_group_of(workflow_id);
  if (!workflow_group_id) return null;
  return (await listed_workflow_groups()).get(workflow_group_id) ?? null;
}

/** Runs operation against the Redis a Docker workflow group registered at target, this API's
 * container on the group's networks first (registry.network.ts); a workflow registered with no
 * workflow group has none to join. */
async function with_registered_target<T>(
  workflow_group_id: string | null,
  target: RedisTarget,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  if (workflow_group_id === null) return with_redis_target(target, operation);
  await join_group_networks(workflow_group_id);
  try {
    return await with_redis_target(target, operation);
  } catch (error) {
    if (error instanceof AppError && error.code === 'registry.controller_unreachable') {
      forget_group_networks(workflow_group_id);
    }
    throw error;
  }
}

/** Runs operation against the Redis workflow_id registered, or the configured one if it never did.
 * On Kubernetes a workflow is reached at its workflow group's Redis, signed in, while the
 * operator lists that group. */
export async function with_redis<T>(
  workflow_id: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  if (config.canyonos.workflowsFile) {
    const listed = await listed_workflow_group(workflow_id);
    if (listed) return with_redis_target(listed.redis, operation);
    // Deleted from the cluster, or not ready: there is no Redis of it to fall back to.
    throw notFound(
      'registry.workflow_not_running',
      "This workflow isn't running in the cluster. Deploy it again with `canyonos deploy --target kubernetes`."
    );
  }
  const workflow = await registry_repo.find_redis(workflow_id);
  return with_registered_target(
    workflow?.workflow_group_id ?? null,
    registered_target(
      workflow?.redis_host ?? null,
      workflow?.redis_port ?? config.canyonos.redisPort,
      workflow?.redis_password ?? '',
      workflow?.redis_tls
    ),
    operation
  );
}

/** Runs operation against the workflow group's Redis with the workflow_id of each workflow
 * registered with it: on Kubernetes the Redis the operator lists, on Docker the one
 * `canyonos deploy` registered; null while neither is there. */
export async function with_group_redis<T>(
  workflow_group_id: string,
  operation: (redis: RedisClient, workflow_ids: string[]) => Promise<T>
): Promise<T | null> {
  if (config.canyonos.workflowsFile) {
    const listed = (await listed_workflow_groups()).get(workflow_group_id);
    if (!listed) return null;
    const workflows = await registry_repo.workflows_of_group(workflow_group_id);
    const workflow_ids = workflows.map(({ workflow_id }) => workflow_id);
    return with_redis_target(listed.redis, (redis) => operation(redis, workflow_ids));
  }
  const registered = await registry_repo.find_group_redis(workflow_group_id);
  if (!registered?.redis_port) return null;
  const { redis_host, redis_port, redis_password, redis_tls, workflow_ids } = registered;
  return with_registered_target(
    workflow_group_id,
    registered_target(redis_host, redis_port, redis_password, redis_tls),
    (redis) => operation(redis, workflow_ids)
  );
}

/** Each workflow's name, by its workflow_id, of the workflow group the controller on redis
 * runs; none while it has published no usable identity. */
export async function running_workflows(redis: RedisClient): Promise<Record<string, string>> {
  const result = IdentityWorkflowsSchema.safeParse(
    parse_json(await redis.hget(CONTROLLER_IDENTITY_KEY, 'workflows'))
  );
  return result.success ? result.data : {};
}

/** The name of the workflow workflow_id; throws not found unless the running controller runs it. */
export async function assert_workflow_running(
  redis: RedisClient,
  workflow_id: string
): Promise<string> {
  const name = (await running_workflows(redis))[workflow_id];
  if (name === undefined) {
    throw notFound(
      'registry.workflow_not_running',
      "This workflow isn't running. Deploy it again with `canyonos deploy` from its folder."
    );
  }
  return name;
}
