// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, isNotNull } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';
import { internalError } from '@core/errors';

import { open_redis_password, seal_redis_password } from './canyonos.password';
import { RedisClientTlsSchema } from './canyonos.types';
import type { RedisClientTls } from './canyonos.types';

export interface ProjectRegistration {
  readonly project_id: string;
  readonly name: string;
  readonly redis_host: string;
  readonly redis_port: number;
  readonly redis_password: string;
  readonly redis_tls?: RedisClientTls;
}

export const canyonos_repo = {
  async list_registrations(): Promise<{ project_id: string }[]> {
    return db
      .select({ project_id: projects.id })
      .from(projects)
      .where(isNotNull(projects.redis_port));
  },

  /** Where the project's Redis is, its password and its client certificate, decrypted; no
   * stored password reads as none, and no certificate as a plain connection. */
  async find_redis(project_id: string): Promise<
    | (Pick<typeof projects.$inferSelect, 'redis_host' | 'redis_port'> & {
        redis_password: string;
        redis_tls: RedisClientTls | null;
      })
    | null
  > {
    const [row] = await db
      .select({
        redis_host: projects.redis_host,
        redis_port: projects.redis_port,
        redis_password: projects.redis_password,
        redis_tls: projects.redis_tls,
      })
      .from(projects)
      .where(eq(projects.id, project_id))
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

  /** An existing project only takes the new Redis, its password and its client certificate,
   * stored encrypted: its name, creator, and timestamps stay. */
  async save_registration({
    project_id,
    name,
    redis_host,
    redis_port,
    redis_password,
    redis_tls,
  }: ProjectRegistration): Promise<{ project_id: string; name: string }> {
    const sealed_password = redis_password ? seal_redis_password(redis_password) : null;
    const sealed_tls = redis_tls ? seal_redis_password(JSON.stringify(redis_tls)) : null;
    const [row] = await db
      .insert(projects)
      .values({
        id: project_id,
        name,
        redis_host,
        redis_port,
        redis_password: sealed_password,
        redis_tls: sealed_tls,
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: { redis_host, redis_port, redis_password: sealed_password, redis_tls: sealed_tls },
      })
      .returning({ project_id: projects.id, name: projects.name });
    if (!row) throw internalError('canyonos.registration_failed', 'Deployment was not registered');
    return row;
  },

  /** A project the operator lists (Kubernetes): its name follows the list. How to sign in
   * to its Redis stays in the operator's list, never in the database. */
  async save_listed_project({
    project_id,
    name,
    redis_port,
  }: Pick<ProjectRegistration, 'project_id' | 'name' | 'redis_port'>): Promise<void> {
    await db
      .insert(projects)
      .values({ id: project_id, name, redis_port })
      .onConflictDoUpdate({ target: projects.id, set: { name, redis_port } });
  },
};
