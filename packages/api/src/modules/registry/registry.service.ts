// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RedisClient } from 'bun';

import { config } from '@core/env';
import { AppError, unprocessable } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import { with_redis_target } from '@core/redis';

import { publish_spend, PUBLISH_SPEND_FAILED } from '../governance/governance.publisher';
import { reconcile_live_prompts, RECONCILE_PROMPTS_FAILED } from '../prompts/prompts.service';
import { CONTROLLER_IDENTITY_KEY } from './registry.contract';
import { listed_workflow_groups } from './registry.listed';
import {
  listed_workflow_group,
  registered_target,
  running_workflows,
  with_redis,
} from './registry.redis';
import { registry_repo } from './registry.repo';
import type { ListedWorkflowGroup } from './registry.listed';
import type { WorkflowGroupRegistration } from './registry.repo';
import type { RegisteredWorkflow } from './registry.types';

// Which workflows the dashboard reads, and where their Redis is. On Docker `canyonos deploy`
// registers each workflow group (PUT /v1/workflow-groups/:id/dashboard) before its Global
// Controller starts, and a dashboard started next to one controller registers that one's
// workflows itself (bootstrap_registry). On Kubernetes the operator lists the workflow groups
// (registry.listed.ts) and the dashboard stores the workflows each group's Redis names. A tick
// then runs the background jobs on every registered workflow that runs.

/** How often the operator's list (Kubernetes) is brought into the dashboard. */
const SYNC_MS = 10_000;

const registry_logger = logger.child({ domain: LOG_DOMAINS.DB });
const jobs_logger = logger.child({ domain: LOG_DOMAINS.WORKER });

/** What a controller published as its identity, before it is checked. */
interface PublishedIdentity {
  readonly workflow_group_id: string | null;
  readonly workflows: Record<string, string>;
}

/** How the api reaches and signs in to a workflow group's Redis, as the registration has it. */
type RegisteredRedis = Omit<WorkflowGroupRegistration, 'workflow_group_id' | 'workflows'>;

async function read_identity(redis: RedisClient): Promise<PublishedIdentity> {
  return {
    workflow_group_id: await redis.hget(CONTROLLER_IDENTITY_KEY, 'workflow_group_id'),
    workflows: await running_workflows(redis),
  };
}

/** Registers the workflows `canyonos deploy` sends for a Docker workflow group, with the
 * group's Redis, before its Global Controller starts: nothing connects to that Redis here. */
export async function register_workflow_group(
  workflow_group_id: string,
  registration: Omit<WorkflowGroupRegistration, 'workflow_group_id'>
): Promise<RegisteredWorkflow[]> {
  return registry_repo.save_registration({ workflow_group_id, ...registration });
}

/** Stores each workflow of the identity, or gives an existing one the workflow group and the
 * new Redis, its password and its client certificate. */
export async function save_controller_workflows(
  { workflow_group_id, workflows }: PublishedIdentity,
  redis: RegisteredRedis
): Promise<RegisteredWorkflow[]> {
  const group = z.string().uuid().safeParse(workflow_group_id);
  if (!group.success) {
    throw unprocessable(
      'registry.identity_unusable',
      `The controller on Redis port ${redis.redis_port} published no usable workflow group id`
    );
  }
  return registry_repo.save_registration({ workflow_group_id: group.data, workflows, ...redis });
}

/** Registers the workflows of a controller on the configured Redis (CANYONOS_REDIS_HOST and
 * CANYONOS_REDIS_PORT), for a dashboard run beside one that no `canyonos deploy` registers, as
 * self-host does. Docker deploys register themselves (register_workflow_group), so no controller
 * there, or none that published its identity, is the usual case and only logged at debug; the
 * dashboard starts either way. */
export async function bootstrap_registry(): Promise<void> {
  const redis: RegisteredRedis = {
    redis_host: config.canyonos.redisHost,
    redis_port: config.canyonos.redisPort,
    redis_password: '',
    redis_tls: null,
  };
  try {
    const identity = await with_redis_target(
      registered_target(redis.redis_host, redis.redis_port, ''),
      read_identity
    );
    if (identity.workflow_group_id === null) {
      registry_logger.debug('No controller identity on the configured Redis to register');
      return;
    }
    await save_controller_workflows(identity, redis);
  } catch (error) {
    if (error instanceof AppError && error.code === 'registry.controller_unreachable') {
      registry_logger.debug('No controller on the configured Redis to register', { error });
      return;
    }
    registry_logger.warn('Could not register the configured controller workflows', { error });
  }
}

// On Kubernetes nothing posts registrations: the dashboard stores the workflows each listed
// workflow group's Global Controller publishes in its Redis (`controller:identity` `workflows`),
// by workflow id, with their workflow group, so each workflow's routes reach the
// group's Redis through it.

// The name and workflow group stored for each workflow, so an unchanged one costs no query.
const stored = new Map<string, string>();

/** Stores each workflow the listed workflow group's Redis names, and removes the row an older
 * dashboard stored for the group itself. */
async function sync_listed_group(entry: ListedWorkflowGroup): Promise<void> {
  const workflows = await with_redis_target(entry.redis, running_workflows);
  if (!stored.has(entry.project_id)) {
    await registry_repo.remove_group_row(entry.project_id);
    stored.set(entry.project_id, '');
  }
  for (const [workflow_id, name] of Object.entries(workflows)) {
    const record = `${entry.project_id}/${name}`;
    if (stored.get(workflow_id) === record) continue;
    await registry_repo.save_listed_workflow({
      workflow_id,
      name,
      workflow_group_id: entry.project_id,
    });
    stored.set(workflow_id, record);
  }
}

/** Stores every workflow of each listed workflow group, read from its Redis each time, so a
 * workflow added to a running group shows up; a group whose Redis cannot be read is skipped
 * until the next sync. */
export async function sync_listed_workflows(
  path: string | null = config.canyonos.workflowsFile
): Promise<void> {
  for (const entry of (await listed_workflow_groups(path)).values()) {
    await sync_listed_group(entry).catch((error: unknown) =>
      registry_logger.warn("Could not store a listed workflow group's workflows", {
        error,
        workflow_group_id: entry.project_id,
      })
    );
  }
}

/** Syncs the operator's list now, then every SYNC_MS. */
export async function start_listed_workflows_sync(): Promise<{ stop(): void }> {
  await sync_listed_workflows();
  const timer = setInterval(() => void sync_listed_workflows(), SYNC_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** For tests: forget what was stored, so the next sync stores everything again. */
export function forget_synced_workflows(): void {
  stored.clear();
}

/** What a background job does with one running workflow, on its workflow group's Redis:
 * `workflow` is its name, as the running controller has it. */
export type RegisteredWorkflowJob = (
  redis: RedisClient,
  workflow_id: string,
  workflow: string
) => Promise<void>;

/** A job the tick runs on every running workflow, and how a workflow's failure is logged. */
export interface RegisteredWorkflowsJob {
  readonly job: RegisteredWorkflowJob;
  readonly failure_message: string;
}

/** What the tick runs: the governed spend the LLM gateway enforces, and the prompts made live in
 * the dashboard, which a redeployed controller does not have. */
const REGISTERED_WORKFLOW_JOBS: readonly RegisteredWorkflowsJob[] = [
  { job: publish_spend, failure_message: PUBLISH_SPEND_FAILED },
  { job: reconcile_live_prompts, failure_message: RECONCILE_PROMPTS_FAILED },
];

/** Runs job on workflow_id's Redis while the controller there runs it. On Kubernetes a workflow
 * whose workflow group the operator no longer lists is skipped too. */
async function run_on_running_workflow(
  workflow_id: string,
  job: RegisteredWorkflowJob
): Promise<void> {
  if (config.canyonos.workflowsFile && !(await listed_workflow_group(workflow_id))) return;
  await with_redis(workflow_id, async (redis) => {
    const workflow = (await running_workflows(redis))[workflow_id];
    if (workflow !== undefined) await job(redis, workflow_id, workflow);
  });
}

/** Runs job on every registered workflow that runs: the workflow groups at once, the workflows
 * of one group one after the other, since they share its Redis keys. A workflow whose job fails
 * is logged with failure_message and skips only that workflow. */
export async function for_each_registered_workflow(
  job: RegisteredWorkflowJob,
  failure_message: string
): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const { workflow_id, workflow_group_id } of await registry_repo.list_registrations()) {
    const group = workflow_group_id ?? workflow_id;
    groups.set(group, [...(groups.get(group) ?? []), workflow_id]);
  }
  await Promise.all(
    [...groups.values()].map(async (workflow_ids) => {
      for (const workflow_id of workflow_ids) {
        await run_on_running_workflow(workflow_id, job).catch((error: unknown) =>
          jobs_logger.warn(failure_message, { workflow_id, error })
        );
      }
    })
  );
}

/** Runs the registered-workflow jobs on every running workflow at once, then every
 * `interval_ms`, one job after the other, re-arming after each round ends so a slow round never
 * overlaps the next. The first round is not left for an interval: until it runs, a controller
 * that started from prompts.yaml serves those prompts instead of the ones live in the dashboard. */
export function start_registered_workflows_tick(
  interval_ms: number = config.registry.tickIntervalMs,
  jobs: readonly RegisteredWorkflowsJob[] = REGISTERED_WORKFLOW_JOBS
): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const round = async () => {
    for (const { job, failure_message } of jobs) {
      await for_each_registered_workflow(job, failure_message);
    }
  };
  const run = () => {
    round()
      .catch((error: unknown) =>
        jobs_logger.warn('Could not list the registered workflows', { error })
      )
      .finally(arm);
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(run, interval_ms);
    timer.unref();
  };
  run();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
