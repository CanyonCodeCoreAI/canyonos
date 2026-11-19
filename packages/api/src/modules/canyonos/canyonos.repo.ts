// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, isNotNull } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { internalError } from '@core/errors';

import { open_redis_password, seal_redis_password } from './canyonos.password';
import { RedisClientTlsSchema } from './canyonos.types';
import type { RedisClientTls } from './canyonos.types';

export interface WorkflowRegistration {
  readonly workflow_id: string;
  readonly name: string;
  readonly workflow_group_id: string;
  readonly redis_host: string;
  readonly redis_port: number;
  readonly redis_password: string;
  readonly redis_tls?: RedisClientTls;
}

export const canyonos_repo = {
  async list_registrations(): Promise<{ workflow_id: string }[]> {
    return db
      .select({ workflow_id: workflows.id })
      .from(workflows)
      .where(isNotNull(workflows.redis_port));
  },

  /** Where the workflow's Redis is, its password and its client certificate, decrypted; no
   * stored password reads as none, and no certificate as a plain connection. */
  async find_redis(workflow_id: string): Promise<
    | (Pick<typeof workflows.$inferSelect, 'redis_host' | 'redis_port'> & {
        redis_password: string;
        redis_tls: RedisClientTls | null;
      })
    | null
  > {
    const [row] = await db
      .select({
        redis_host: workflows.redis_host,
        redis_port: workflows.redis_port,
        redis_password: workflows.redis_password,
        redis_tls: workflows.redis_tls,
      })
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    if (!row) return null;
    const { redis_password, redis_tls, ...redis } = row;
    return {
      ...redis,
      redis_password: redis_password ? open_redis_password(redis_password) : '',
      redis_tls: redis_tls
        ? RedisClientTlsSchema.parse(JSON.parse(open_redis_password(redis_tls)))
        : null,
    };
  },

  /** An existing workflow only takes the new Redis, its password and its client certificate,
   * stored encrypted: its name, creator, and timestamps stay. */
  async save_registration({
    workflow_id,
    name,
    workflow_group_id,
    redis_host,
    redis_port,
    redis_password,
    redis_tls,
  }: WorkflowRegistration): Promise<{ workflow_id: string; name: string }> {
    const sealed_password = redis_password ? seal_redis_password(redis_password) : null;
    const sealed_tls = redis_tls ? seal_redis_password(JSON.stringify(redis_tls)) : null;
    const [row] = await db
      .insert(workflows)
      .values({
        id: workflow_id,
        name,
        workflow_group_id,
        redis_host,
        redis_port,
        redis_password: sealed_password,
        redis_tls: sealed_tls,
      })
      .onConflictDoUpdate({
        target: workflows.id,
        set: { redis_host, redis_port, redis_password: sealed_password, redis_tls: sealed_tls },
      })
      .returning({ workflow_id: workflows.id, name: workflows.name });
    if (!row) throw internalError('canyonos.registration_failed', 'Workflow was not registered');
    return row;
  },

  /** A workflow the operator lists (Kubernetes): its name follows the list. How to sign in
   * to its Redis stays in the operator's list, never in the database. */
  async save_listed_workflow({
    workflow_id,
    name,
    redis_port,
  }: Pick<WorkflowRegistration, 'workflow_id' | 'name' | 'redis_port'>): Promise<void> {
    await db
      .insert(workflows)
      .values({ id: workflow_id, name, redis_port })
      .onConflictDoUpdate({ target: workflows.id, set: { name, redis_port } });
  },
};
