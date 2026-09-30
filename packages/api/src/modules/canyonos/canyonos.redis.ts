import { RedisClient } from 'bun';

import { config } from '@core/env';
import { badGateway, notFound } from '@core/errors';

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

/** Runs operation against the running controller's Redis, closing the connection afterwards. */
export async function with_redis<T>(operation: (redis: RedisClient) => Promise<T>): Promise<T> {
  const { redisHost, redisPort } = config.canyonos;
  const redis = new RedisClient(`redis://${redisHost}:${redisPort}`, {
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
