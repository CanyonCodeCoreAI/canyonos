// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { unprocessable } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { UUID_RE } from '../auth/project-access';
import { load_prompts } from '../prompts/prompts.service';
import { CONTROLLER_IDENTITY_KEY, with_redis_at } from './canyonos.redis';
import { canyonos_repo } from './canyonos.repo';
import type { RegisteredProject } from './canyonos.types';

const DEFAULT_PROJECT_NAME = 'project_1';

const canyonos_logger = logger.child({ domain: LOG_DOMAINS.DB });

interface ControllerIdentity {
  readonly project_id: string | null;
  readonly project_name: string | null;
}

async function read_identity(redis: RedisClient): Promise<ControllerIdentity> {
  return {
    project_id: await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_id'),
    project_name: await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_name'),
  };
}

/** Stores the identity's project, or gives an existing one the new Redis port. */
export async function save_controller_project(
  { project_id, project_name }: ControllerIdentity,
  redis_port: number
): Promise<RegisteredProject> {
  if (project_id === null || !UUID_RE.test(project_id)) {
    throw unprocessable(
      'canyonos.identity_unusable',
      `The controller on Redis port ${redis_port} published no usable project id`
    );
  }

  return canyonos_repo.save_registration({
    project_id,
    name: project_name || DEFAULT_PROJECT_NAME,
    redis_port,
  });
}

/** Registers the project whose controller publishes its identity on redis_port. */
export async function register_project_at(redis_port: number): Promise<RegisteredProject> {
  const identity = await with_redis_at(redis_port, read_identity);
  const project = await save_controller_project(identity, redis_port);
  // A failed prompt load must not fail the registration: the prompts listing stores them later.
  await load_prompts(project.project_id).catch((error: unknown) =>
    canyonos_logger.warn('Could not load stored prompts', { error })
  );
  return project;
}

export async function bootstrap_canyonos(): Promise<void> {
  // Without a reachable controller the dashboard still starts; the CLI registers projects later.
  await register_project_at(config.canyonos.redisPort).catch((error: unknown) =>
    canyonos_logger.warn('Could not register the configured controller project', { error })
  );
}
