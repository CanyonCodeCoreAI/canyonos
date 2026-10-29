// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { RedisClient } from 'bun';

import { config } from '@core/env';
import { badGateway, notFound } from '@core/errors';

import { registered_projects } from './canyonos.registry';
import { canyonos_repo } from './canyonos.repo';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';

/** Where a project's Redis is and how to sign in to it. */
export interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
  readonly username?: string;
  readonly password?: string;
}

/** The URL of a Redis, with its credentials (escaped) and TLS. */
export function redis_url({
  host,
  port,
  tls = false,
  username = '',
  password = '',
}: RedisTarget): string {
  const credentials = password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  return `${tls ? 'rediss' : 'redis'}://${credentials}${host}:${port}`;
}

async function connect(redis: RedisClient): Promise<void> {
  try {
    await redis.connect();
  } catch (error) {
    throw badGateway(
      'canyonos.controller_unreachable',
      'The running controller could not be reached',
      { cause: error }
    );
  }
}

/** Runs operation against the configured host's Redis on redis_port, then closes the connection. */
export async function with_redis_at<T>(
  redis_port: number,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  return with_redis_url(
    redis_url({ host: config.canyonos.redisHost, port: redis_port }),
    operation
  );
}

/** Runs operation against the Redis at url, then closes the connection. */
async function with_redis_url<T>(
  url: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  const redis = new RedisClient(url, {
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
    connectionTimeout: 5000,
  });

  try {
    await connect(redis);
    return await operation(redis);
  } finally {
    redis.close();
  }
}

// Temporary: applied now so multi-project dashboards work without blocking the flow; revisit
// with the project-key design in CAN-521 (the api should not hold per-project Redis addresses).
/** Runs operation against the Redis project_id registered, or the configured one if it never did.
 * On Kubernetes a project is reached at its own Redis, signed in, while the operator lists it. */
export async function with_redis<T>(
  project_id: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  const listed = registered_projects().get(project_id);
  if (listed) return with_redis_url(redis_url(listed.redis), operation);
  if (config.canyonos.projectsFile) {
    // Deleted from the cluster, or not ready: there is no Redis of it to fall back to.
    throw notFound(
      'canyonos.project_not_running',
      "This project isn't running in the cluster. Deploy it again with `canyonos deploy --target kubernetes`."
    );
  }
  const redis_port = await canyonos_repo.find_redis_port(project_id);
  return with_redis_at(redis_port ?? config.canyonos.redisPort, operation);
}

/** Throws not found unless the running controller belongs to project_id. */
export async function assert_project_running(
  redis: RedisClient,
  project_id: string
): Promise<void> {
  const controller_project_id = await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_id');
  if (controller_project_id !== project_id) {
    throw notFound(
      'canyonos.project_not_running',
      "This project isn't running. Deploy it again with `canyonos deploy` from its folder."
    );
  }
}
