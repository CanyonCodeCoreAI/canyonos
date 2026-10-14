// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { RedisClient } from 'bun';

import { config } from '@core/env';
import { badGateway, notFound } from '@core/errors';

import { canyonos_repo } from './canyonos.repo';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';

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
  const redis = new RedisClient(`redis://${config.canyonos.redisHost}:${redis_port}`, {
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
/** Runs operation against the Redis project_id registered, or the configured one if it never did. */
export async function with_redis<T>(
  project_id: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
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
      `No running controller was found for project "${project_id}"`
    );
  }
}
