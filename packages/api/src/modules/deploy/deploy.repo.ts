import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  deploymentEvents,
  deploymentFiles,
  deployments,
  deploySetups,
  projects,
} from '@api/db/schema';
import { internalError } from '@core/errors';

import { TERMINAL_DEPLOYMENT_STATUSES } from './deploy.types';
import type { ProjectDeployFile } from '../projects/projects.repo';
import type {
  DeploymentOverviewItem,
  DeploymentStateFilter,
  DeploymentStatus,
} from './deploy.types';

export type DeploySetupRow = typeof deploySetups.$inferSelect;
export type NewDeploySetup = typeof deploySetups.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentEventRow = typeof deploymentEvents.$inferSelect;

export interface NewDeployment {
  readonly project_id: string;
  readonly company_id: string;
  readonly created_by: string;
  readonly deploy_setup_id: string;
}

const not_terminal = () => notInArray(deployments.status, [...TERMINAL_DEPLOYMENT_STATUSES]);
const terminal = () => inArray(deployments.status, [...TERMINAL_DEPLOYMENT_STATUSES]);

const DEPLOYMENT_INFO_COLUMNS = {
  id: deployments.id,
  project_id: deployments.project_id,
  status: deployments.status,
  address: deployments.address,
  error: deployments.error,
  stop_error: deployments.stop_error,
  controller_instance_id: deployments.controller_instance_id,
  created_at: deployments.created_at,
  updated_at: deployments.updated_at,
};

export interface DeploymentInfoRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: DeploymentStatus;
  readonly address: string | null;
  readonly error: string | null;
  readonly stop_error: string | null;
  readonly controller_instance_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Event writes follow a deployment-row write in the same transaction. That row lock serializes the
// worker and stale sweep before this per-deployment sequence is allocated; the UNIQUE index is the
// final database guard.
async function next_seq(tx: Tx, deployment_id: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${deploymentEvents.seq}), 0) + 1` })
    .from(deploymentEvents)
    .where(eq(deploymentEvents.deployment_id, deployment_id));
  return row?.next ?? 1;
}

async function append_event(
  tx: Tx,
  deployment_id: string,
  status: DeploymentStatus,
  detail: string | null
): Promise<void> {
  await tx
    .insert(deploymentEvents)
    .values({ deployment_id, seq: await next_seq(tx, deployment_id), status, detail });
}

export const deploy_setups_repo = {
  async find_one_by_company(company_id: string): Promise<DeploySetupRow | undefined> {
    const [row] = await db
      .select()
      .from(deploySetups)
      .where(eq(deploySetups.company_id, company_id))
      .orderBy(asc(deploySetups.created_at), asc(deploySetups.id))
      .limit(1);
    return row;
  },

  async create(input: NewDeploySetup): Promise<DeploySetupRow> {
    const [row] = await db.insert(deploySetups).values(input).returning();
    if (!row) throw internalError('deploy.create_failed', 'Failed to create deploy setup');
    return row;
  },
};

export const deployments_repo = {
  // The enqueue write: the pending row, its seq-1 event, and the immutable file manifest, atomically.
  // The partial unique index rejects a second active row for the project — the caller maps that to 409.
  async insert_pending_with_event(
    input: NewDeployment,
    manifest: readonly ProjectDeployFile[]
  ): Promise<DeploymentRow> {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(deployments).values(input).returning();
      if (!row) throw internalError('deploy.enqueue_failed', 'Failed to enqueue deployment');
      await append_event(tx, row.id, 'pending', null);
      if (manifest.length > 0) {
        await tx.insert(deploymentFiles).values(
          manifest.map((file) => ({
            deployment_id: row.id,
            path: file.path,
            content_hash: file.content_hash,
            byte_size: file.byte_size,
            component_kind: file.component_kind,
          }))
        );
      }
      return row;
    });
  },

  async find_active_by_project(
    project_id: string
  ): Promise<{ id: string; status: DeploymentStatus } | undefined> {
    const [row] = await db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(and(eq(deployments.project_id, project_id), not_terminal()))
      .limit(1);
    return row;
  },

  async find_by_project(
    deployment_id: string,
    project_id: string
  ): Promise<
    | {
        id: string;
        status: DeploymentStatus;
        controller_instance_id: string | null;
        controller_ip: string | null;
      }
    | undefined
  > {
    const [row] = await db
      .select({
        id: deployments.id,
        status: deployments.status,
        controller_instance_id: deployments.controller_instance_id,
        controller_ip: deployments.controller_ip,
      })
      .from(deployments)
      .where(and(eq(deployments.id, deployment_id), eq(deployments.project_id, project_id)))
      .limit(1);
    return row;
  },

  // One specific deployment, scoped to its project so a caller can only reach a deployment their
  // project owns. Address is set only on success, so a mid-deploy or failed row returns it null.
  async find_for_test(
    deploy_id: string,
    project_id: string
  ): Promise<{ status: DeploymentStatus; address: string | null } | undefined> {
    const [row] = await db
      .select({ status: deployments.status, address: deployments.address })
      .from(deployments)
      .where(and(eq(deployments.id, deploy_id), eq(deployments.project_id, project_id)))
      .limit(1);
    return row;
  },

  // The deployment record scoped to its project, so a caller only ever reads a deployment their
  // project owns. Powers the dashboard's up-front status load.
  async find_info(deploy_id: string, project_id: string): Promise<DeploymentInfoRow | undefined> {
    const [row] = await db
      .select(DEPLOYMENT_INFO_COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.id, deploy_id), eq(deployments.project_id, project_id)))
      .limit(1);
    return row;
  },

  async find_latest_terminal_by_project(
    project_id: string
  ): Promise<DeploymentInfoRow | undefined> {
    const [row] = await db
      .select(DEPLOYMENT_INFO_COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.project_id, project_id), terminal()))
      .orderBy(desc(deployments.created_at), desc(deployments.id))
      .limit(1);
    return row;
  },

  async find_latest_success_by_project(project_id: string): Promise<DeploymentInfoRow | undefined> {
    const [row] = await db
      .select(DEPLOYMENT_INFO_COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.project_id, project_id), eq(deployments.status, 'success')))
      .orderBy(desc(deployments.created_at), desc(deployments.id))
      .limit(1);
    return row;
  },

  async find_active_info_by_project(project_id: string): Promise<DeploymentInfoRow | undefined> {
    const [row] = await db
      .select(DEPLOYMENT_INFO_COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.project_id, project_id), not_terminal()))
      .orderBy(desc(deployments.created_at), desc(deployments.id))
      .limit(1);
    return row;
  },

  async list_overview({
    state,
    limit,
  }: {
    state: DeploymentStateFilter;
    limit: number;
  }): Promise<DeploymentOverviewItem[]> {
    const status_filter =
      state === 'all'
        ? undefined
        : state === 'active'
          ? not_terminal()
          : eq(deployments.status, state);

    return db
      .select({
        id: deployments.id,
        project_id: deployments.project_id,
        project_name: projects.name,
        status: deployments.status,
        address: deployments.address,
        error: deployments.error,
        stop_error: deployments.stop_error,
        created_at: deployments.created_at,
        updated_at: deployments.updated_at,
      })
      .from(deployments)
      .innerJoin(projects, eq(deployments.project_id, projects.id))
      .where(status_filter)
      .orderBy(desc(deployments.updated_at))
      .limit(limit);
  },

  async list_manifest(deployment_id: string): Promise<ProjectDeployFile[]> {
    return db
      .select({
        path: deploymentFiles.path,
        content_hash: deploymentFiles.content_hash,
        byte_size: deploymentFiles.byte_size,
        component_kind: deploymentFiles.component_kind,
      })
      .from(deploymentFiles)
      .where(eq(deploymentFiles.deployment_id, deployment_id))
      .orderBy(deploymentFiles.path);
  },

  async get_status(deployment_id: string): Promise<DeploymentStatus | undefined> {
    const [row] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deployment_id))
      .limit(1);
    return row?.status;
  },

  async list_events_after(deployment_id: string, after_seq: number): Promise<DeploymentEventRow[]> {
    return db
      .select()
      .from(deploymentEvents)
      .where(
        and(
          eq(deploymentEvents.deployment_id, deployment_id),
          sql`${deploymentEvents.seq} > ${after_seq}`
        )
      )
      .orderBy(asc(deploymentEvents.seq));
  },

  // The claim the Python worker will issue verbatim: take the job only while it is still pending, and
  // stamp liveness + version. A lost race (already claimed) returns undefined.
  async claim_pending(id: string, worker_version: string): Promise<DeploymentRow | undefined> {
    const [row] = await db
      .update(deployments)
      .set({
        claimed_at: sql`now()`,
        heartbeat_at: sql`now()`,
        attempts: sql`${deployments.attempts} + 1`,
        worker_version,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(deployments.id, id),
          eq(deployments.status, 'pending'),
          isNull(deployments.claimed_at)
        )
      )
      .returning();
    return row;
  },

  async heartbeat_claimed(id: string): Promise<void> {
    await db
      .update(deployments)
      .set({ heartbeat_at: sql`now()` })
      .where(and(eq(deployments.id, id), isNotNull(deployments.claimed_at), not_terminal()));
  },

  // Advance the phase and append its event in one tx. The status guard keeps a reclaimed (already
  // failed) deployment from being resurrected: it returns undefined and the worker stops.
  async advance_status_with_event(
    id: string,
    status: DeploymentStatus,
    detail?: string
  ): Promise<DeploymentRow | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(deployments)
        .set({
          status,
          updated_at: sql`now()`,
          ...(status === 'success' && detail ? { address: detail } : {}),
        })
        .where(and(eq(deployments.id, id), not_terminal()))
        .returning();
      if (!row) return undefined;
      await append_event(tx, id, status, detail ?? null);
      return row;
    });
  },

  // Matching `status = 'success'` is the concurrency guard: only the first of two simultaneous stop
  // requests sees a row, so one 'stopping' event and one NOTIFY. `heartbeat_at` is reset because the
  // row is otherwise already past its lease — the stale sweep would fail it before a worker claims.
  async request_stop(id: string, project_id: string): Promise<DeploymentRow | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(deployments)
        .set({
          status: 'stopping',
          stop_error: null,
          heartbeat_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(deployments.id, id),
            eq(deployments.project_id, project_id),
            eq(deployments.status, 'success'),
            isNotNull(deployments.controller_instance_id)
          )
        )
        .returning();
      if (!row) return undefined;
      await append_event(tx, id, 'stopping', null);
      return row;
    });
  },

  async claim_stopping(id: string, worker_version: string): Promise<DeploymentRow | undefined> {
    const [row] = await db
      .update(deployments)
      .set({ stop_claimed_at: sql`now()`, heartbeat_at: sql`now()`, worker_version })
      .where(
        and(
          eq(deployments.id, id),
          eq(deployments.status, 'stopping'),
          isNull(deployments.stop_claimed_at)
        )
      )
      .returning();
    return row;
  },

  async record_controller_handles(
    id: string,
    controller_instance_id: string,
    controller_ip: string
  ): Promise<void> {
    await db
      .update(deployments)
      .set({ controller_instance_id, controller_ip, updated_at: sql`now()` })
      .where(and(eq(deployments.id, id), not_terminal()));
  },

  // A failed teardown leaves the deployment live: its instances are probably still running. Back to
  // `success` carrying `stop_error` (the event tells a watching client; the column tells one that
  // reloads later), with `stop_claimed_at` cleared so a retry can be claimed.
  async mark_stop_failed_with_event(
    id: string,
    message: string
  ): Promise<DeploymentRow | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(deployments)
        .set({
          status: 'success',
          stop_error: message,
          stop_claimed_at: null,
          updated_at: sql`now()`,
        })
        .where(and(eq(deployments.id, id), eq(deployments.status, 'stopping')))
        .returning();
      if (!row) return undefined;
      await append_event(tx, id, 'stop_failed', message);
      return row;
    });
  },

  async mark_failed_with_event(id: string, message: string): Promise<DeploymentRow | undefined> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(deployments)
        .set({ status: 'failed', error: message, updated_at: sql`now()` })
        .where(and(eq(deployments.id, id), not_terminal()))
        .returning();
      if (!row) return undefined;
      await append_event(tx, id, 'failed', message);
      return row;
    });
  },

  // Safety net for a worker that died mid-job: a lost teardown returns to the live row with a
  // retryable stop failure, while a lost deploy becomes terminal and publishes its failure event.
  async sweep_stale(lease_seconds: number): Promise<number> {
    return db.transaction(async (tx) => {
      const stale_stops = await tx
        .update(deployments)
        .set({
          status: 'success',
          stop_error: 'worker lost while stopping; retry the stop',
          stop_claimed_at: null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            isNotNull(deployments.claimed_at),
            eq(deployments.status, 'stopping'),
            sql`coalesce(${deployments.heartbeat_at}, ${deployments.claimed_at}) < now() - make_interval(secs => ${lease_seconds})`
          )
        )
        .returning({ id: deployments.id });

      for (const { id } of stale_stops) {
        await append_event(tx, id, 'stop_failed', 'worker lost while stopping; retry the stop');
      }

      const reclaimed = await tx
        .update(deployments)
        .set({ status: 'failed', error: 'worker lost', updated_at: sql`now()` })
        .where(
          and(
            isNotNull(deployments.claimed_at),
            not_terminal(),
            sql`coalesce(${deployments.heartbeat_at}, ${deployments.claimed_at}) < now() - make_interval(secs => ${lease_seconds})`
          )
        )
        .returning({ id: deployments.id });

      for (const { id } of reclaimed) await append_event(tx, id, 'failed', 'worker lost');
      return stale_stops.length + reclaimed.length;
    });
  },
};
