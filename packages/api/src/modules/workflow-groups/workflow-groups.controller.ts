// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import * as docker from '@core/docker';
import { AppError, conflict } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { Container } from '@core/docker';

import { CONTROLLER_ROLE, ROLE_LABEL, WORKFLOW_GROUP_LABEL } from '../registry/registry.network';
import { parse_answer } from './workflow-groups.core';
import { DEPLOY_ERRORS, DEPLOY_PHASES } from './workflow-groups.types';
import type { CoreReply } from './workflow-groups.core';
import type { DeployPhase, SlowestStep } from './workflow-groups.types';

// How /v1 reaches a workflow group's Global Controller container, which the CLI creates: the
// progress file its `run-deploy` writes, the one-shot job containers that change its /workspace
// volume, and the `canyonos_core.cli` commands run inside it. Finding it by its labels is
// registry.network.ts's, whose Redis reads need its networks too.

const controller_logger = logger.child({ domain: LOG_DOMAINS.DOCKER });

export const PROJECT_LABEL = 'com.docker.compose.project';
export const JOB_ROLE = 'job';

const CORE_CLI = ['python', '-m', 'canyonos_core.cli'];
const WORKSPACE_DIR = '/workspace';
const PROGRESS_FILE = '/var/lib/canyonos/progress.json';
const JOB_INPUT_DIR = '/tmp';
// The progress file's clock and Docker's may differ by a little; a file this much older than the
// container's start belongs to an earlier run.
const START_SLACK_MS = 2_000;
const RUNNER = "The Global Controller's core";
// Past the 240 s the Global Controller gives its replicas to stop, so its cleanup can finish.
export const STOP_TIMEOUT_SECONDS = 255;
const KILL_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 300_000;
export const EXEC_TIMEOUT_MS = 60_000;

/** What `run-deploy` writes to /var/lib/canyonos/progress.json; times are epoch seconds. */
const ProgressFileSchema = z.object({
  version: z.string(),
  started_at: z.number(),
  phase: z.enum(DEPLOY_PHASES),
  message: z.string().nullable(),
  steps: z.array(z.string()),
  slowest_step: z.object({ name: z.string(), started_at: z.number() }).nullable(),
  last_output_at: z.number().nullable(),
  error: z.string().nullable(),
  error_code: z.enum(DEPLOY_ERRORS).nullable(),
  root_cause: z.string().nullable(),
  reload: z.object({
    seq: z.number().int(),
    ok: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
  stopping: z.boolean(),
  finished: z.boolean(),
  exit_code: z.number().int().nullable(),
});

type ProgressFile = z.infer<typeof ProgressFileSchema>;

/** The deploy as the status reports it, from the container and the progress file of its
 * current run. */
export interface DeployProgress {
  version: string | null;
  phase: DeployPhase | null;
  message: string | null;
  steps: string[];
  slowest_step: SlowestStep | null;
  idle_seconds: number | null;
  error: string | null;
  error_code: (typeof DEPLOY_ERRORS)[number] | null;
  root_cause: string | null;
  /** The last reload the deploy answered, null before its run reported. */
  reload: ProgressFile['reload'] | null;
  finished: boolean;
  /** Why the progress file could not be read, if it could not. */
  problem: string | null;
}

const NO_PROGRESS: DeployProgress = {
  version: null,
  phase: null,
  message: null,
  steps: [],
  slowest_step: null,
  idle_seconds: null,
  error: null,
  error_code: null,
  root_cause: null,
  reload: null,
  finished: false,
  problem: null,
};

export function controller_missing(workflow_group_id: string): AppError {
  return conflict(
    'workflow_groups.controller_missing',
    `No Global Controller container is labelled ${WORKFLOW_GROUP_LABEL}=${workflow_group_id}; ` +
      'run `canyonos deploy` to create it'
  );
}

export function not_running(): AppError {
  return conflict('workflow_groups.not_running', 'The Global Controller is not running');
}

/** The Global Controller container of every workflow group, by workflow group id. */
export async function list_controllers(): Promise<Map<string, string>> {
  const containers = await docker.list_containers([`${ROLE_LABEL}=${CONTROLLER_ROLE}`]);
  const controllers = new Map<string, string>();
  // Oldest first, so the newest of a workflow group's containers wins.
  for (const { id, labels } of [...containers].reverse()) {
    const workflow_group_id = labels[WORKFLOW_GROUP_LABEL];
    if (workflow_group_id) controllers.set(workflow_group_id, id);
  }
  return controllers;
}

async function read_progress_file(container: Container): Promise<ProgressFile | string | null> {
  const archive = await docker.get_archive(container.id, PROGRESS_FILE);
  if (!archive) return null;
  try {
    const [file] = (await docker.untar(archive)).values();
    if (!file) return null;
    const parsed = ProgressFileSchema.safeParse(JSON.parse(await file.text()));
    if (parsed.success) return parsed.data;
    return `the progress file does not match its schema: ${parsed.error.message}`;
  } catch (error) {
    return `the progress file is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const round_tenth = (seconds: number) => Math.round(seconds * 10) / 10;

/** The progress of the container's current run. A file from an earlier run, or none yet, reads
 * as a deploy that is starting while the container runs; a run that ended without recording
 * its end, such as one SIGKILL stopped, failed unless it was asked to stop. */
export async function read_progress(container: Container): Promise<DeployProgress> {
  if (container.started_at_ms === null) return NO_PROGRESS;
  const read = await read_progress_file(container);
  const problem = typeof read === 'string' ? read : null;
  const file =
    read !== null &&
    typeof read !== 'string' &&
    read.started_at * 1000 >= container.started_at_ms - START_SLACK_MS
      ? read
      : null;
  const progress: DeployProgress = file
    ? {
        version: file.version,
        phase: file.phase,
        message: file.message,
        steps: file.steps,
        slowest_step: null,
        idle_seconds: null,
        error: file.error,
        error_code: file.error_code,
        root_cause: file.root_cause,
        reload: file.reload,
        finished: file.finished,
        problem,
      }
    : { ...NO_PROGRESS, phase: 'starting', problem };
  if (container.running) {
    const now = Date.now() / 1000;
    if (file?.slowest_step) {
      progress.slowest_step = {
        name: file.slowest_step.name,
        seconds: round_tenth(now - file.slowest_step.started_at),
      };
    }
    if (file?.last_output_at) progress.idle_seconds = round_tenth(now - file.last_output_at);
    return progress;
  }
  if (progress.finished || progress.phase === 'failed') return progress;
  if (file?.stopping) return { ...progress, phase: 'stopped' };
  return {
    ...progress,
    phase: 'failed',
    message: null,
    error: `The Global Controller exited with code ${container.exit_code}.`,
    error_code: 'controller_exited',
  };
}

/** Runs a `canyonos_core.cli` command in the running Global Controller container, which prints
 * one JSON object on stdout; anything else is a crash, explained on stderr, or a command Docker
 * could not start, which Docker explains on stdout. */
export async function run_in_controller(
  container: Container,
  args: string[],
  timeout_ms = EXEC_TIMEOUT_MS
): Promise<CoreReply> {
  const { exit_code, stdout, stderr } = await docker.exec(container.id, [...CORE_CLI, ...args], {
    working_dir: WORKSPACE_DIR,
    timeout_ms,
  });
  return parse_answer(RUNNER, args[0]!, exit_code, stdout, stderr);
}

function workspace_volume(controller: Container): string {
  const mount = controller.mounts.find(({ destination }) => destination === WORKSPACE_DIR);
  if (!mount) {
    throw conflict(
      'workflow_groups.controller_missing',
      `The Global Controller container ${controller.name} has no ${WORKSPACE_DIR} volume`
    );
  }
  return mount.source;
}

/** Runs a `canyonos_core.cli` command in a one-shot container of the controller's image that
 * shares only its /workspace volume, with no network, socket or environment; `files` are put in
 * its /tmp first. Returns what it printed on stdout once it exited, and removes it. */
export async function run_job(
  controller: Container,
  args: string[],
  files: Record<string, string | Uint8Array> = {}
): Promise<CoreReply> {
  const job_id = await docker.create({
    Image: controller.image_id,
    Entrypoint: CORE_CLI,
    Cmd: args,
    WorkingDir: WORKSPACE_DIR,
    Labels: {
      [PROJECT_LABEL]: controller.labels[PROJECT_LABEL] ?? '',
      [ROLE_LABEL]: JOB_ROLE,
      [WORKFLOW_GROUP_LABEL]: controller.labels[WORKFLOW_GROUP_LABEL] ?? '',
    },
    HostConfig: {
      Binds: [`${workspace_volume(controller)}:${WORKSPACE_DIR}`],
      NetworkMode: 'none',
    },
  });
  try {
    if (Object.keys(files).length > 0) {
      await docker.put_archive(job_id, JOB_INPUT_DIR, await docker.tar(files));
    }
    await docker.start(job_id);
    const exit_code = await docker.wait(job_id, JOB_TIMEOUT_MS);
    const { stdout, stderr } = await docker.logs(job_id);
    return parse_answer(RUNNER, args[0]!, exit_code, stdout, stderr);
  } finally {
    await docker
      .remove(job_id, { force: true })
      .catch((error: unknown) =>
        controller_logger.warn('Could not remove a job container', { job_id, error })
      );
  }
}

/** Sends `signal` to the deploy; false when the container was not running. */
export async function signal(container: Container, name: string): Promise<boolean> {
  try {
    await docker.kill(container.id, name);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'docker.conflict') return false;
    throw error;
  }
}

export interface StopFailure {
  error: string;
  code: 'stop_timeout' | 'stop_failed';
}

/** SIGTERMs the deploy and waits up to 255 s for the container to exit, then SIGKILLs it.
 * Returns why the stop failed: it did not stop in time, or exited with an error. A container
 * that had already exited, such as a failed deploy that stopped itself, needed no stop. */
export async function stop_controller(container: Container): Promise<StopFailure | null> {
  if (!(await signal(container, 'TERM'))) return null;
  let exit_code: number;
  try {
    exit_code = await docker.wait(container.id, STOP_TIMEOUT_SECONDS * 1000);
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'docker.timeout')) throw error;
    await signal(container, 'KILL');
    await docker.wait(container.id, KILL_TIMEOUT_MS).catch(() => undefined);
    return {
      error: `Global Controller did not stop within ${STOP_TIMEOUT_SECONDS} seconds`,
      code: 'stop_timeout',
    };
  }
  // 143 is 128 + SIGTERM: this TERM reached `run-deploy` before it set its handlers, which it
  // does before it starts `deploy`, so nothing had started that needed stopping.
  if (exit_code !== 0 && exit_code !== EXIT_ON_TERM_BEFORE_HANDLERS) {
    return { error: `Global Controller stopped with exit code ${exit_code}`, code: 'stop_failed' };
  }
  return null;
}

const EXIT_ON_TERM_BEFORE_HANDLERS = 128 + 15;
