// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { unprocessable } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { UUID_RE } from '../auth/workflow-access';
import { load_prompts } from '../prompts/prompts.service';
import {
  CONTROLLER_IDENTITY_KEY,
  reachable_redis_host,
  running_workflows,
  with_redis_at,
} from './canyonos.redis';
import { canyonos_repo } from './canyonos.repo';
import type { RedisClientTls, RegisteredWorkflow } from './canyonos.types';

const canyonos_logger = logger.child({ domain: LOG_DOMAINS.DB });

interface ControllerIdentity {
  readonly workflow_group_id: string | null;
  readonly workflows: Record<string, string>;
}

async function read_identity(redis: RedisClient): Promise<ControllerIdentity> {
  return {
    workflow_group_id: await redis.hget(CONTROLLER_IDENTITY_KEY, 'workflow_group_id'),
    workflows: await running_workflows(redis),
  };
}

/** Stores each workflow of the identity as a workflow, or gives an existing one the new Redis,
 * its password and its client certificate. */
export async function save_controller_workflows(
  { workflow_group_id, workflows }: ControllerIdentity,
  redis_host: string,
  redis_port: number,
  redis_password: string,
  redis_tls?: RedisClientTls
): Promise<RegisteredWorkflow[]> {
  if (workflow_group_id === null || !UUID_RE.test(workflow_group_id)) {
    throw unprocessable(
      'canyonos.identity_unusable',
      `The controller on Redis port ${redis_port} published no usable workflow group id`
    );
  }

  return Promise.all(
    Object.entries(workflows).map(([workflow_id, name]) =>
      canyonos_repo.save_registration({
        workflow_id,
        name,
        workflow_group_id,
        redis_host,
        redis_port,
        redis_password,
        redis_tls,
      })
    )
  );
}

/** Registers each workflow whose controller publishes its identity on redis_host:redis_port,
 * signing in with redis_password, over TLS with redis_tls when its Redis takes only that. Each
 * keeps redis_host as sent, even when the api reaches it on loopback. */
export async function register_workflows_at(
  redis_host: string,
  redis_port: number,
  redis_password: string,
  redis_tls?: RedisClientTls
): Promise<RegisteredWorkflow[]> {
  const identity = await with_redis_at(
    reachable_redis_host(redis_host),
    redis_port,
    redis_password,
    read_identity,
    redis_tls
  );
  const workflows = await save_controller_workflows(
    identity,
    redis_host,
    redis_port,
    redis_password,
    redis_tls
  );
  // One at a time: each merges its prompts into the workflow group's shared prompts:config.
  for (const { workflow_id } of workflows) {
    // A failed prompt load must not fail the registration: the prompts listing stores them later.
    await load_prompts(workflow_id).catch((error: unknown) =>
      canyonos_logger.warn('Could not load stored prompts', { error })
    );
  }
  return workflows;
}

export async function bootstrap_canyonos(): Promise<void> {
  // Without a reachable controller the dashboard still starts; the CLI registers workflows later.
  await register_workflows_at(config.canyonos.redisHost, config.canyonos.redisPort, '').catch(
    (error: unknown) =>
      canyonos_logger.warn('Could not register the configured controller workflow', { error })
  );
}
