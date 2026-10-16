// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';
import { internalError } from '@core/errors';

export interface ProjectRegistration {
  readonly project_id: string;
  readonly name: string;
  readonly redis_port: number;
}

export const canyonos_repo = {
  async find_redis_port(project_id: string): Promise<number | null> {
    const [row] = await db
      .select({ redis_port: projects.redis_port })
      .from(projects)
      .where(eq(projects.id, project_id))
      .limit(1);
    return row?.redis_port ?? null;
  },

  /** An existing project only takes the new port: its name, creator, and timestamps stay. */
  async save_registration({
    project_id,
    name,
    redis_port,
  }: ProjectRegistration): Promise<{ project_id: string; name: string }> {
    const [row] = await db
      .insert(projects)
      .values({ id: project_id, name, redis_port })
      .onConflictDoUpdate({ target: projects.id, set: { redis_port } })
      .returning({ project_id: projects.id, name: projects.name });
    if (!row) throw internalError('canyonos.registration_failed', 'Project was not registered');
    return row;
  },
};
