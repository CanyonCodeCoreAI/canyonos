// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Publishes to the Redis at `CANYONOS_REDIS_HOST`:`CANYONOS_REDIS_PORT` what the Global
 * Controller of a self-hosted workflow group publishes to its own: its identity, one workflow,
 * and its API key's sha256. `playwright.config.ts` runs it before the first API starts, which
 * then finds that workflow group and its key as a dashboard beside a controller does.
 */

import { RedisClient } from 'bun';

import { hashApiKey } from '../src/__tests__/helpers/auth';
import {
  SELF_HOSTED_API_KEY,
  SELF_HOSTED_WORKFLOW,
  SELF_HOSTED_WORKFLOW_GROUP_ID,
  SELF_HOSTED_WORKFLOW_NAME,
} from '../src/__tests__/helpers/self-hosted';

const host = Bun.env.CANYONOS_REDIS_HOST ?? '127.0.0.1';
const port = Bun.env.CANYONOS_REDIS_PORT ?? '6379';
const redis = new RedisClient(`redis://${host}:${port}`);
try {
  await redis.hset('controller:identity', 'workflow_group_id', SELF_HOSTED_WORKFLOW_GROUP_ID);
  await redis.hset(
    'controller:identity',
    'workflows',
    JSON.stringify({ [SELF_HOSTED_WORKFLOW]: SELF_HOSTED_WORKFLOW_NAME })
  );
  await redis.set('auth:api_key_hash', hashApiKey(SELF_HOSTED_API_KEY));
} finally {
  redis.close();
}
console.log(`Published the self-hosted controller to redis://${host}:${port}`);
