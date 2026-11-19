// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

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
  /** The workflows of a running controller: registered on Docker with their Redis port, listed
   * on Kubernetes with their workflow group. */
  async list_registrations(): Promise<{ workflow_id: string }[]> {
    return db
      .select({ workflow_id: workflows.id })
      .from(workflows)
      .where(or(isNotNull(workflows.redis_port), isNotNull(workflows.workflow_group_id)));
  },

  async workflow_group_of(workflow_id: string): Promise<string | null> {
    const [row] = await db
      .select({ workflow_group_id: workflows.workflow_group_id })
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    return row?.workflow_group_id ?? null;
  },

  /** The workflows stored for workflow group `workflow_group_id`, by name. */
  async workflows_of_group(
    workflow_group_id: string
  ): Promise<{ workflow_id: string; name: string }[]> {
    return db
      .select({ workflow_id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(eq(workflows.workflow_group_id, workflow_group_id))
      .orderBy(workflows.name);
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

  /** A workflow of a workflow group the operator lists (Kubernetes), as its Redis names it.
   * How to sign in to that Redis stays in the operator's list, never in the database. */
  async save_listed_workflow({
    workflow_id,
    name,
    workflow_group_id,
  }: Pick<WorkflowRegistration, 'workflow_id' | 'name' | 'workflow_group_id'>): Promise<void> {
    await db
      .insert(workflows)
      .values({ id: workflow_id, name, workflow_group_id })
      .onConflictDoUpdate({ target: workflows.id, set: { name, workflow_group_id } });
  },

  /** Removes the row an older dashboard stored for a listed workflow group as if it were a
   * workflow: its id is the workflow_group_id, and it has no workflow group of its own. */
  async remove_group_row(workflow_group_id: string): Promise<void> {
    await db
      .delete(workflows)
      .where(and(eq(workflows.id, workflow_group_id), isNull(workflows.workflow_group_id)));
  },
};
