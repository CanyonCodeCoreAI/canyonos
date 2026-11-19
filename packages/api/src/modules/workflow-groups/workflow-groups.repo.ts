// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, gt, sql } from 'drizzle-orm';

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
  async find(id: string): Promise<WorkflowGroupRow | null> {
    const [row] = await db.select().from(workflowGroups).where(eq(workflowGroups.id, id)).limit(1);
    return row ?? null;
  },

  async list(): Promise<Pick<WorkflowGroupRow, 'id' | 'name'>[]> {
    return db
      .select({ id: workflowGroups.id, name: workflowGroups.name })
      .from(workflowGroups)
      .orderBy(workflowGroups.id);
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
   * a new one when it has none, and one that starts from nothing when its upload went into
   * another container, whose volume it no longer is. Kubernetes has no such container: null. */
  async claim(id: string, controller_container_id: string | null): Promise<WorkflowGroupRow> {
    await db
      .insert(workflowGroups)
      .values({ id, controller_container_id })
      .onConflictDoUpdate({
        target: workflowGroups.id,
        set: {
          controller_container_id,
          workflows: {},
          deployed: null,
          applied_generation: 0,
          updated_at: sql`now()`,
        },
        setWhere: sql`${workflowGroups.controller_container_id} is distinct from ${controller_container_id}`,
      });
    const row = await this.find(id);
    if (!row) throw new Error(`The workflow group ${id} vanished while it was claimed`);
    return row;
  },

  /** Keeps what a PUT of the workflow group sent and drops the workflows it left out; returns
   * the new generation. */
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
      api_key_hash: string | null | undefined;
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
          ...(api_key_hash === undefined ? {} : { api_key_hash }),
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

  async save_workflow(id: string, name: string, workflow: StoredWorkflow): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({
          workflows: sql`${workflowGroups.workflows} || jsonb_build_object(${name}::text, ${JSON.stringify(workflow)}::jsonb)`,
          ...changed(),
        })
        .where(eq(workflowGroups.id, id))
        .returning({ generation: workflowGroups.generation })
    );
  },

  async remove_workflow(id: string, name: string): Promise<number | null> {
    return generation_of(
      db
        .update(workflowGroups)
        .set({ workflows: sql`${workflowGroups.workflows} - ${name}::text`, ...changed() })
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
          updated_at: sql`now()`,
        },
      });
  },

  async remove(id: string): Promise<void> {
    await db.delete(workflowGroups).where(eq(workflowGroups.id, id));
  },
};
