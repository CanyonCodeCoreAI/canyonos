// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from 'drizzle-orm';
import type { RedisClient } from 'bun';

import { db } from '@api/db/client';
import { companies, users } from '@api/db/schema';
import { config } from '@core/env';
import { internalError, unprocessable } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { UUID_RE } from '../auth/project-access';
import { UserStatusEnum } from '../auth/types';
import { load_prompts } from '../prompts/prompts.service';
import { CONTROLLER_IDENTITY_KEY, with_redis_at } from './canyonos.redis';
import { canyonos_repo } from './canyonos.repo';
import type { RegisteredProject } from './canyonos.types';

const ADMIN_NAME = 'admin';
// `.invalid` is reserved by RFC 2606, so this placeholder address can never route.
export const ADMIN_EMAIL = 'admin@canyonos.invalid';
const DEFAULT_PROJECT_NAME = 'project_1';

const canyonos_logger = logger.child({ domain: LOG_DOMAINS.DB });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AdminOwner {
  readonly user_id: string;
  readonly company_id: string;
}

async function ensure_admin_owner(tx: Tx): Promise<AdminOwner> {
  const [existing] = await tx
    .select({ user_id: users.id, company_id: users.companyId })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  if (existing?.company_id) return { user_id: existing.user_id, company_id: existing.company_id };

  const [company] = await tx.insert(companies).values({ name: ADMIN_NAME }).returning();
  if (!company) throw internalError('canyonos.bootstrap_failed', 'Admin company was not created');

  const [user] = await tx
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      companyId: company.id,
      status: UserStatusEnum.ACTIVE,
    })
    .returning({ id: users.id });
  if (!user) throw internalError('canyonos.bootstrap_failed', 'Admin user was not created');
  return { user_id: user.id, company_id: company.id };
}

export async function ensure_canyonos_admin(): Promise<AdminOwner> {
  return db.transaction((tx) => ensure_admin_owner(tx));
}

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

/** Stores the identity's project under the admin, or gives an existing one the new Redis port. */
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

  return db.transaction(async (tx) => {
    const { user_id, company_id } = await ensure_admin_owner(tx);
    return canyonos_repo.save_registration(tx, {
      project_id,
      name: project_name || DEFAULT_PROJECT_NAME,
      company_id,
      created_by: user_id,
      redis_port,
    });
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
  await ensure_canyonos_admin();

  // Without a reachable controller the dashboard still starts; the CLI registers projects later.
  await register_project_at(config.canyonos.redisPort).catch((error: unknown) =>
    canyonos_logger.warn('Could not register the configured controller project', { error })
  );
}
