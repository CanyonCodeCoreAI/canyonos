// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { conflict, internalError } from '@core/errors';
import { parse_json } from '@core/json';

import { open_redis_password, seal_redis_password } from './registry.secrets';
import { RedisClientTlsSchema } from './registry.types';
import type { RedisClientTls, RegisteredWorkflow } from './registry.types';

/** A Docker workflow group's workflows, each name by its workflow_id, and how the api reaches
 * and signs in to the group's Redis. */
export interface WorkflowGroupRegistration {
  readonly workflow_group_id: string;
  readonly workflows: Readonly<Record<string, string>>;
  readonly redis_host: string;
  readonly redis_port: number;
  readonly redis_password: string;
  readonly redis_tls: RedisClientTls | null;
}

/** Where a workflow's Redis is, its password and its client certificate, decrypted. */
export interface StoredRedis {
  readonly redis_host: string | null;
  readonly redis_port: number | null;
  readonly redis_password: string;
  readonly redis_tls: RedisClientTls | null;
}

const redis_columns = {
  redis_host: workflows.redis_host,
  redis_port: workflows.redis_port,
  redis_password: workflows.redis_password,
  redis_tls: workflows.redis_tls,
};

type SealedRedis = Pick<
  typeof workflows.$inferSelect,
  'redis_host' | 'redis_port' | 'redis_password' | 'redis_tls'
>;

/** Whether a workflow may move out of the workflow group `workflow_group_id`, which holds it:
 * what a write of workflows into another workflow group asks before it moves one. */
export type MayTake = (workflow_group_id: string) => boolean;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The first of `workflow_ids` that another workflow group than `workflow_group_id` holds and
 * `may_take` does not release, with that workflow group; null when none is held back. */
async function held_back(
  tx: Transaction,
  workflow_group_id: string,
  workflow_ids: string[],
  may_take: MayTake
): Promise<{ workflow_id: string; held_by: string } | null> {
  const held = await tx
    .select({ workflow_id: workflows.id, held_by: workflows.workflow_group_id })
    .from(workflows)
    .where(inArray(workflows.id, workflow_ids));
  for (const { workflow_id, held_by } of held) {
    if (held_by !== null && held_by !== workflow_group_id && !may_take(held_by)) {
      return { workflow_id, held_by };
    }
  }
  return null;
}

/** No stored password reads as none, and no certificate as a plain connection. */
function open_redis({ redis_password, redis_tls, ...redis }: SealedRedis): StoredRedis {
  return {
    ...redis,
    redis_password: redis_password ? open_redis_password(redis_password) : '',
    redis_tls: redis_tls
      ? RedisClientTlsSchema.parse(parse_json(open_redis_password(redis_tls)))
      : null,
  };
}

const workflow_taken = (workflow_id: string) =>
  conflict(
    'registry.workflow_taken',
    `Workflow ${workflow_id} is in another workflow group: the key that opens that workflow ` +
      'group, or the deploy key, moves it',
    { retryable: false }
  );

export const registry_repo = {
  /** The workflows of a running controller, with their workflow group: registered on Docker
   * with their Redis port, listed on Kubernetes with their workflow group. */
  async list_registrations(): Promise<{ workflow_id: string; workflow_group_id: string | null }[]> {
    return db
      .select({ workflow_id: workflows.id, workflow_group_id: workflows.workflow_group_id })
      .from(workflows)
      .where(or(isNotNull(workflows.redis_port), isNotNull(workflows.workflow_group_id)))
      .orderBy(asc(workflows.id));
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
  async workflows_of_group(workflow_group_id: string): Promise<RegisteredWorkflow[]> {
    return db
      .select({ workflow_id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(eq(workflows.workflow_group_id, workflow_group_id))
      .orderBy(asc(workflows.name));
  },

  /** The workflow's Redis, decrypted, and its workflow group; null for a workflow with no row. */
  async find_redis(
    workflow_id: string
  ): Promise<(StoredRedis & { readonly workflow_group_id: string | null }) | null> {
    const [row] = await db
      .select({ ...redis_columns, workflow_group_id: workflows.workflow_group_id })
      .from(workflows)
      .where(eq(workflows.id, workflow_id))
      .limit(1);
    if (!row) return null;
    const { workflow_group_id, ...redis } = row;
    return { ...open_redis(redis), workflow_group_id };
  },

  /** The Redis a Docker workflow group registered last, decrypted, with the workflow_id of each
   * workflow registered with it; null when none of its workflows registered a Redis. */
  async find_group_redis(
    workflow_group_id: string
  ): Promise<(StoredRedis & { readonly workflow_ids: string[] }) | null> {
    const in_group = and(
      eq(workflows.workflow_group_id, workflow_group_id),
      isNotNull(workflows.redis_port)
    );
    const [row] = await db
      .select(redis_columns)
      .from(workflows)
      .where(in_group)
      .orderBy(desc(workflows.updated_at), asc(workflows.id))
      .limit(1);
    if (!row) return null;
    const registered = await db
      .select({ workflow_id: workflows.id })
      .from(workflows)
      .where(in_group);
    return { ...open_redis(row), workflow_ids: registered.map(({ workflow_id }) => workflow_id) };
  },

  /** Stores each workflow of the workflow group with the group's Redis, its password and its
   * client certificate, encrypted, in one transaction. An existing workflow takes the workflow
   * group and the Redis: its name, creator and creation time stay. One another workflow group
   * holds moves only when `may_take` releases that workflow group: 409 `registry.workflow_taken`
   * otherwise, and nothing is written. */
  async save_registration(
    {
      workflow_group_id,
      workflows: names,
      redis_host,
      redis_port,
      redis_password,
      redis_tls,
    }: WorkflowGroupRegistration,
    may_take: MayTake
  ): Promise<RegisteredWorkflow[]> {
    const entries = Object.entries(names);
    if (entries.length === 0) return [];
    const sealed_password = redis_password ? seal_redis_password(redis_password) : null;
    const sealed_tls = redis_tls ? seal_redis_password(JSON.stringify(redis_tls)) : null;
    const rows = await db.transaction(async (tx) => {
      const taken = await held_back(
        tx,
        workflow_group_id,
        entries.map(([id]) => id),
        may_take
      );
      if (taken) throw workflow_taken(taken.workflow_id);
      return tx
        .insert(workflows)
        .values(
          entries.map(([id, name]) => ({
            id,
            name,
            workflow_group_id,
            redis_host,
            redis_port,
            redis_password: sealed_password,
            redis_tls: sealed_tls,
          }))
        )
        .onConflictDoUpdate({
          target: workflows.id,
          set: {
            workflow_group_id,
            redis_host,
            redis_port,
            redis_password: sealed_password,
            redis_tls: sealed_tls,
            updated_at: sql`now()`,
          },
        })
        .returning({ workflow_id: workflows.id, name: workflows.name });
    });
    if (rows.length !== entries.length) {
      throw internalError('registry.registration_failed', 'The workflows were not registered');
    }
    return rows.sort(
      (a, b) => a.name.localeCompare(b.name) || a.workflow_id.localeCompare(b.workflow_id)
    );
  },

  /** A workflow of a workflow group the operator lists (Kubernetes), as its Redis names it.
   * How to sign in to that Redis stays in the operator's list, never in the database. One
   * another workflow group holds moves only when `may_take` releases that workflow group;
   * returns the workflow group that kept it, or null once it is stored. */
  async save_listed_workflow(
    {
      workflow_id,
      name,
      workflow_group_id,
    }: RegisteredWorkflow & { readonly workflow_group_id: string },
    may_take: MayTake
  ): Promise<string | null> {
    return db.transaction(async (tx) => {
      const taken = await held_back(tx, workflow_group_id, [workflow_id], may_take);
      if (taken) return taken.held_by;
      await tx
        .insert(workflows)
        .values({ id: workflow_id, name, workflow_group_id })
        .onConflictDoUpdate({ target: workflows.id, set: { name, workflow_group_id } });
      return null;
    });
  },

  /** Removes the row an older dashboard stored for a listed workflow group as if it were a
   * workflow: its id is the workflow_group_id, and it has no workflow group of its own. */
  async remove_group_row(workflow_group_id: string): Promise<void> {
    await db
      .delete(workflows)
      .where(and(eq(workflows.id, workflow_group_id), isNull(workflows.workflow_group_id)));
  },
};
