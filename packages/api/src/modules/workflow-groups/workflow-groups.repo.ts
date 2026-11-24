// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflowGroups } from '@api/db/schema';
import type { DeployedFingerprints, StoredLastApply, StoredWorkflow } from '@api/db/schema';

export type WorkflowGroupRow = typeof workflowGroups.$inferSelect;

/** What a change to the upload bumps: the generation, and when it last changed. */
const changed = () => ({
  generation: sql`${workflowGroups.generation} + 1`,
  last_change_at: new Date(),
  updated_at: sql`now()`,
});

const generation_of = async (rows: Promise<{ generation: number }[]>): Promise<number | null> =>
  (await rows)[0]?.generation ?? null;

export const workflow_groups_repo = {
  /** The workflow group's row; null when it has none, or only the key a stop left (`stop`). */
  async find(id: string): Promise<WorkflowGroupRow | null> {
    const [row] = await db
      .select()
      .from(workflowGroups)
      .where(and(eq(workflowGroups.id, id), isNull(workflowGroups.stopped_at)))
      .limit(1);
    return row ?? null;
  },

  /** Every workflow group, or those of `ids`. */
  async list(ids?: readonly string[]): Promise<Pick<WorkflowGroupRow, 'id' | 'name'>[]> {
    if (ids?.length === 0) return [];
    return db
      .select({ id: workflowGroups.id, name: workflowGroups.name })
      .from(workflowGroups)
      .where(
        and(
          isNull(workflowGroups.stopped_at),
          ids ? inArray(workflowGroups.id, [...ids]) : undefined
        )
      )
      .orderBy(workflowGroups.id);
  },

  /** The API key hash of the workflow group, stopped or not, read fresh each time so a changed
   * key holds at once; null when it has no row. */
  async api_key_hash(id: string): Promise<Pick<WorkflowGroupRow, 'api_key_hash'> | null> {
    const [row] = await db
      .select({ api_key_hash: workflowGroups.api_key_hash })
      .from(workflowGroups)
      .where(eq(workflowGroups.id, id))
      .limit(1);
    return row ?? null;
  },

  async api_key_hashes(): Promise<Pick<WorkflowGroupRow, 'id' | 'api_key_hash'>[]> {
    return db
      .select({ id: workflowGroups.id, api_key_hash: workflowGroups.api_key_hash })
      .from(workflowGroups);
  },

  /** The workflow groups whose latest change the apply loop has not applied yet. */
  async list_unapplied(): Promise<string[]> {
    const rows = await db
      .select({ id: workflowGroups.id })
      .from(workflowGroups)
      .where(gt(workflowGroups.generation, workflowGroups.applied_generation));
    return rows.map(({ id }) => id);
  },

  /** The workflow group's row for its Global Controller container `controller_container_id`:
   * a new one when it has none, made with the API key hash the PUT sets (`api_key_hash`, none
   * for one that keeps or removes the key), so it is never open before its key is known; and one
   * that starts from nothing when its upload went into another container, whose volume it no
   * longer is. Kubernetes has no such container: null. */
  async claim(
    id: string,
    controller_container_id: string | null,
    api_key_hash: string | null | undefined
  ): Promise<WorkflowGroupRow> {
    await db
      .insert(workflowGroups)
      .values({ id, controller_container_id, api_key_hash: api_key_hash ?? null })
      .onConflictDoUpdate({
        target: workflowGroups.id,
        set: {
          controller_container_id,
          workflows: {},
          deployed: null,
          applied_generation: 0,
          stopped_at: null,
          updated_at: sql`now()`,
        },
        setWhere: sql`${workflowGroups.controller_container_id} is distinct from ${controller_container_id} or ${workflowGroups.stopped_at} is not null`,
      });
    const row = await this.find(id);
    if (!row) throw new Error(`The workflow group ${id} vanished while it was claimed`);
    return row;
  },

  /** Keeps what a PUT of the workflow group sent (`api_key_hash` left undefined keeps the key it
   * has) and drops the workflows it left out; returns the new generation. */
  async save_settings(
    id: string,
    {
      name,
      config,
      env_digest,
      api_key_hash,
      removed_workflows,
    }: {
      name: string;
      config: string;
      env_digest: string | null;
      api_key_hash?: string | null;
      removed_workflows: string[];
    }
  ): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({
          name,
          config,
          env_digest,
          api_key_hash,
          ...(removed_workflows.length === 0
            ? {}
            : {
                workflows: sql`${workflowGroups.workflows} - array[${sql.join(
                  removed_workflows.map((workflow) => sql`${workflow}`),
                  sql`, `
                )}]::text[]`,
              }),
          ...changed(),
        })
        .where(eq(workflowGroups.id, id))
        .returning({ generation: workflowGroups.generation })
    );
  },

  async save_workflow(
    id: string,
    workflow_id: string,
    workflow: StoredWorkflow
  ): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({
          workflows: sql`${workflowGroups.workflows} || jsonb_build_object(${workflow_id}::text, ${JSON.stringify(workflow)}::jsonb)`,
          ...changed(),
        })
        .where(eq(workflowGroups.id, id))
        .returning({ generation: workflowGroups.generation })
    );
  },

  async remove_workflow(id: string, workflow_id: string): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({ workflows: sql`${workflowGroups.workflows} - ${workflow_id}::text`, ...changed() })
        .where(eq(workflowGroups.id, id))
        .returning({ generation: workflowGroups.generation })
    );
  },

  /** Forgets the upload, so the apply loop stops the deploy; returns the new generation. */
  async clear_upload(id: string): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({ name: '', config: null, env_digest: null, workflows: {}, ...changed() })
        .where(eq(workflowGroups.id, id))
        .returning({ generation: workflowGroups.generation })
    );
  },

  /** Recorded before the container starts, so an API that restarts mid-start does not restart a
   * healthy deploy. */
  async save_deployed(
    id: string,
    deployed: DeployedFingerprints,
    controller_container_id: string | null
  ): Promise<void> {
    await db
      .update(workflowGroups)
      .set({ deployed, controller_container_id, updated_at: sql`now()` })
      .where(eq(workflowGroups.id, id));
  },

  async save_apply(id: string, last_apply: StoredLastApply): Promise<void> {
    await db
      .update(workflowGroups)
      .set({ applied_generation: last_apply.generation, last_apply, updated_at: sql`now()` })
      .where(eq(workflowGroups.id, id));
  },

  /** Kubernetes, at API start: the uploads were in the pod's emptyDir, which is gone, so no
   * row holds a workflow until the next upload, and none has a change left to apply. */
  async forget_uploads(): Promise<void> {
    await db.update(workflowGroups).set({
      workflows: {},
      applied_generation: sql`${workflowGroups.generation}`,
      updated_at: sql`now()`,
    });
  },

  /** Kubernetes, at API start: the row of a workflow group whose CanyonProject runs, from what
   * the CanyonProject holds; made when there is none. Its upload is gone with the old pod. */
  async restore(
    id: string,
    {
      name,
      api_key_hash,
      deployed,
    }: { name: string; api_key_hash: string | null; deployed: DeployedFingerprints | null }
  ): Promise<void> {
    await db
      .insert(workflowGroups)
      .values({ id, name, api_key_hash, deployed })
      .onConflictDoUpdate({
        target: workflowGroups.id,
        set: {
          name,
          api_key_hash,
          deployed,
          workflows: {},
          controller_container_id: null,
          applied_generation: sql`${workflowGroups.generation}`,
          stopped_at: null,
          updated_at: sql`now()`,
        },
      });
  },

  /** The row of the workflow group whose Global Controller runs on the configured Redis, as a
   * dashboard run beside one finds it at start (self-host): made when there is none, with the
   * key hash that controller published, which it keeps up to date. */
  async adopt(id: string, api_key_hash: string | null): Promise<void> {
    await db
      .insert(workflowGroups)
      .values({ id, api_key_hash })
      .onConflictDoUpdate({
        target: workflowGroups.id,
        set: { api_key_hash, stopped_at: null, updated_at: sql`now()` },
      });
  },

  /** After a stop: forgets all of the workflow group but its id and API key hash, which the
   * workflows it ran keep their history behind. `find` and `list` no longer return it. */
  async stop(id: string): Promise<void> {
    await db
      .update(workflowGroups)
      .set({
        name: '',
        config: null,
        env_digest: null,
        controller_container_id: null,
        workflows: {},
        generation: 0,
        applied_generation: 0,
        deployed: null,
        last_apply: null,
        stopped_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(workflowGroups.id, id));
  },
};
