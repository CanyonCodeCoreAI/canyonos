// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { DeployedFingerprints, StoredWorkflow } from '@api/db/schema';
import * as docker from '@core/docker';
import { config } from '@core/env';
import { notFound, serviceUnavailable, unprocessable } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { Container } from '@core/docker';

import { find_controller, join_group_networks } from '../registry/registry.network';
import { register_workflow_group } from '../registry/registry.service';
import {
  controller_missing,
  list_controllers,
  not_running,
  read_progress,
  run_in_controller,
  run_job,
  signal,
  stop_controller,
} from './workflow-groups.controller';
import { core_answer, core_error } from './workflow-groups.core';
import { unknown_workflow_group } from './workflow-groups.errors';
import { workflow_groups_repo } from './workflow-groups.repo';
import { read_runtime_status } from './workflow-groups.runtime';
import { DEPLOY_PHASES, HealthCheckSchema, ReplicaLogsSchema } from './workflow-groups.types';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type { RuntimeStatus } from './workflow-groups.runtime';
import type {
  ApplyFailure,
  ApplyPass,
  DeployReport,
  WorkflowGroupTarget,
} from './workflow-groups.target';

// The Docker target: each workflow group's Global Controller container, which the CLI creates.
// Its /workspace volume holds the upload, which one-shot job containers change; its `run-deploy`
// writes the progress file the status reads; its `canyonos_core.cli` commands check and read the
// running deploy (workflow-groups.controller.ts), and its Redis, which `canyonos deploy`
// registers here, holds the endpoint and agents (workflow-groups.runtime.ts).

const docker_logger = logger.child({ domain: LOG_DOMAINS.WORKFLOW_GROUPS });

const UPLOAD_ARCHIVE = 'upload.tar.gz';
const GROUP_FILES = 'group.json';
const EXPLAINED_FAILURE_EXIT_CODE = 1;
const UNKNOWN_AGENT_EXIT_CODE = 3;
// Past the 180 s an SSH read of one replica's log takes at most.
const AGENT_LOGS_TIMEOUT_MS = 190_000;
const RUNTIME_STATUS_CACHE_MS = 2_000;
const RELOAD_TIMEOUT_SECONDS = 60;
const RELOAD_POLL_MS = 500;

const OkSchema = z.object({ ok: z.literal(true) });
const RemovedSchema = z.object({ removed: z.array(z.string()) });
const HealthAnswerSchema = z.object({ checks: z.array(HealthCheckSchema) });

/** The workflow group's Global Controller container; 404 when it has neither that nor a row. */
async function locate(
  workflow_group_id: string,
  row: WorkflowGroupRow | null
): Promise<Container | null> {
  const controller = await find_controller(workflow_group_id);
  if (!row && !controller) throw unknown_workflow_group(workflow_group_id);
  return controller;
}

async function running_controller(
  workflow_group_id: string,
  row: WorkflowGroupRow | null
): Promise<Container> {
  const controller = await locate(workflow_group_id, row);
  if (!controller?.running) throw not_running();
  return controller;
}

async function existing_controller(workflow_group_id: string): Promise<Container> {
  const controller = await find_controller(workflow_group_id);
  if (!controller) throw controller_missing(workflow_group_id);
  return controller;
}

/** The workflows uploaded into this controller's volume; an upload into an earlier one's
 * volume is not there. */
function uploaded_into(
  row: WorkflowGroupRow | null,
  controller: Container | null
): Record<string, StoredWorkflow> {
  if (!row || (controller && row.controller_container_id !== controller.id)) return {};
  return row.workflows;
}

const runtime_statuses = new Map<
  string,
  { container_id: string; at: number; read: Promise<RuntimeStatus> }
>();

/** The running deploy's endpoint, agents and machine errors as its Redis holds them, read at
 * most every two seconds per workflow group. */
function runtime_status(workflow_group_id: string, controller: Container): Promise<RuntimeStatus> {
  const cached = runtime_statuses.get(workflow_group_id);
  if (
    cached &&
    cached.container_id === controller.id &&
    Date.now() - cached.at < RUNTIME_STATUS_CACHE_MS
  ) {
    return cached.read;
  }
  const read = read_runtime_status(workflow_group_id);
  runtime_statuses.set(workflow_group_id, { container_id: controller.id, at: Date.now(), read });
  return read;
}

const message_of = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Starts the container, having recorded what it runs first. */
async function start(
  row: WorkflowGroupRow,
  controller: Container | null,
  uploaded: DeployedFingerprints
): Promise<ApplyFailure | null> {
  if (!controller) {
    return {
      error: 'No Global Controller container to start: run `canyonos deploy` to create it',
      code: 'start_failed',
    };
  }
  await workflow_groups_repo.save_deployed(row.id, uploaded, controller.id);
  try {
    await docker.start(controller.id);
  } catch (error) {
    return {
      error: `Could not start the Global Controller: ${message_of(error)}`,
      code: 'start_failed',
    };
  }
  docker_logger.info('Global Controller started', { workflow_group_id: row.id });
  return null;
}

const CheckedSchema = z.object({ ok: z.literal(true) });

/** Has the running deploy reload the config in /workspace, without restarting the agents that
 * stay, and waits for its answer in the progress file. */
async function reload(
  row: WorkflowGroupRow,
  controller: Container,
  uploaded: DeployedFingerprints
): Promise<ApplyFailure | null> {
  const reply = await run_in_controller(controller, ['check']);
  const violations = core_error(reply, EXPLAINED_FAILURE_EXIT_CODE);
  if (violations !== null) return { error: violations, code: 'config_invalid' };
  core_answer(reply, CheckedSchema);
  const asked_seq = (await read_progress(controller)).reload?.seq ?? 0;
  const stopped: ApplyFailure = {
    error: 'The deploy stopped while reloading.',
    code: 'reload_failed',
  };
  if (!(await signal(controller, 'HUP'))) return stopped;
  const deadline = Date.now() + RELOAD_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(RELOAD_POLL_MS);
    const current = await docker.inspect(controller.id);
    const progress = await read_progress(current);
    if (progress.reload && progress.reload.seq > asked_seq) {
      // The status read before this reload holds the old replica counts.
      runtime_statuses.delete(row.id);
      if (progress.reload.ok === false) {
        return { error: progress.reload.error ?? 'Reload failed.', code: 'reload_failed' };
      }
      await workflow_groups_repo.save_deployed(
        row.id,
        { ...(row.deployed ?? uploaded), config: uploaded.config },
        controller.id
      );
      return null;
    }
    if (!current.running || progress.finished) return stopped;
  }
  return {
    error: `The Global Controller did not finish reloading within ${RELOAD_TIMEOUT_SECONDS} seconds.`,
    code: 'reload_timeout',
  };
}

export const docker_target: WorkflowGroupTarget = {
  resumes_apply_loops: config.docker.socket !== null,

  async workflow_group_ids() {
    return [...(await list_controllers()).keys()];
  },

  async put_group_files(workflow_group_id, body) {
    const controller = await existing_controller(workflow_group_id);
    const row = await workflow_groups_repo.claim(workflow_group_id, controller.id);
    core_answer(
      await run_job(controller, ['write-group-files'], {
        [GROUP_FILES]: JSON.stringify({ config: body.config, env: body.env }),
      }),
      OkSchema
    );
    const listed = body.workflows ? new Set(body.workflows) : null;
    const removed = Object.entries(row.workflows).filter(
      ([workflow_id]) => listed && !listed.has(workflow_id)
    );
    if (removed.length > 0) {
      core_answer(
        await run_job(controller, [
          'remove-workflows',
          ...removed.map(([, workflow]) => workflow.name),
        ]),
        RemovedSchema
      );
    }
    return { removed_workflows: removed.map(([workflow_id]) => workflow_id) };
  },

  async receive_archive(body) {
    return new Blob([await Bun.readableStreamToArrayBuffer(body)]);
  },

  async put_workflow(workflow_group_id, name, archive) {
    const controller = await existing_controller(workflow_group_id);
    await workflow_groups_repo.claim(workflow_group_id, controller.id);
    return run_job(controller, ['put-workflow', name, '--archive', `/tmp/${UPLOAD_ARCHIVE}`], {
      [UPLOAD_ARCHIVE]: new Uint8Array(await archive.arrayBuffer()),
    });
  },

  async remove_workflows(workflow_group_id, names) {
    const controller = await find_controller(workflow_group_id);
    if (controller) {
      core_answer(await run_job(controller, ['remove-workflows', ...names]), RemovedSchema);
    }
  },

  async uploaded_workflows(workflow_group_id, row) {
    return uploaded_into(row, await locate(workflow_group_id, row));
  },

  async stop_unlisted(workflow_group_id) {
    const controller = await locate(workflow_group_id, null);
    return controller?.running ? stop_controller(controller) : null;
  },

  async restore() {},

  async begin_apply(found): Promise<ApplyPass> {
    const controller = await find_controller(found.id);
    // An upload that went into another container's volume is not in this one's.
    const row =
      controller && found.controller_container_id !== controller.id
        ? await workflow_groups_repo.claim(found.id, controller.id)
        : found;
    return {
      row,
      running: controller?.running ?? false,
      start: (uploaded) => start(row, controller, uploaded),
      stop: async () => (controller ? stop_controller(controller) : null),
      reload: async (uploaded) => (controller ? reload(row, controller, uploaded) : null),
    };
  },

  async starting(workflow_group_id) {
    const controller = await find_controller(workflow_group_id);
    if (!controller?.running) return false;
    return (await read_progress(controller)).phase === 'starting';
  },

  async report(workflow_group_id, row): Promise<DeployReport> {
    const controller = await locate(workflow_group_id, row);
    const progress = controller ? await read_progress(controller) : null;
    const running = controller?.running ?? false;
    const phase = progress?.phase ?? null;
    const runtime =
      controller && running && (phase === 'up' || phase === 'failed')
        ? await runtime_status(workflow_group_id, controller)
        : null;
    return {
      version: progress?.version ?? null,
      running,
      phase: phase && (DEPLOY_PHASES as readonly string[]).includes(phase) ? phase : null,
      message: progress?.message ?? null,
      steps: progress?.steps ?? [],
      slowest_step: progress?.slowest_step ?? null,
      idle_seconds: progress?.idle_seconds ?? null,
      error: progress?.error ?? null,
      error_code: progress?.error_code ?? null,
      root_cause: progress?.root_cause ?? null,
      endpoint: runtime?.endpoint ?? null,
      agents: runtime?.agents ?? null,
      machine_errors: runtime?.machine_errors ?? null,
      errors: [
        ...(progress?.problem ? [`Could not read the deploy's progress: ${progress.problem}`] : []),
        ...(runtime?.errors ?? []),
      ],
    };
  },

  async controller_log(workflow_group_id, row, tail, follow, abort) {
    const controller = await locate(workflow_group_id, row);
    const text = (body: BodyInit | null) =>
      new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!controller || controller.started_at_ms === null) return text('');
    return text(
      await docker.log_stream(
        controller.id,
        { tail, since_ms: controller.started_at_ms, follow },
        abort
      )
    );
  },

  async health(workflow_group_id, row) {
    const controller = await running_controller(workflow_group_id, row);
    const { checks } = core_answer(
      await run_in_controller(controller, ['health']),
      HealthAnswerSchema
    );
    const all_checks = [
      {
        name: 'Global Controller',
        ok: true,
        detail: `container ${controller.name} is running`,
        fix: null,
      },
      ...checks,
    ];
    return { ok: all_checks.every(({ ok }) => ok), checks: all_checks };
  },

  async agent_logs(workflow_group_id, row, name, tail) {
    const controller = await running_controller(workflow_group_id, row);
    const reply = await run_in_controller(
      controller,
      ['agent-logs', name, '--tail', tail],
      AGENT_LOGS_TIMEOUT_MS
    );
    const unknown = core_error(reply, UNKNOWN_AGENT_EXIT_CODE);
    if (unknown !== null) throw notFound('workflow_groups.unknown_agent', unknown);
    const unreadable = core_error(reply, EXPLAINED_FAILURE_EXIT_CODE);
    if (unreadable !== null)
      throw serviceUnavailable('workflow_groups.replicas_unreadable', unreadable);
    return core_answer(reply, ReplicaLogsSchema);
  },

  /** Registers the workflow group's workflows and its Redis with this dashboard, as
   * `canyonos deploy` creates its Global Controller container and before that starts: nothing
   * connects to the Redis here, the status reads it once the deploy runs. This API's container
   * joins the container's networks now, so that read finds the Redis by name. 422 without it:
   * the body is optional only for Kubernetes. */
  async register_dashboard(workflow_group_id, row, registration) {
    if (registration === undefined) {
      throw unprocessable(
        'workflow_groups.registration_required',
        "Send the workflow group's workflows and its Redis: on Docker the dashboard has no " +
          'other way to know them'
      );
    }
    const controller = await locate(workflow_group_id, row);
    const workflows = await register_workflow_group(workflow_group_id, registration);
    if (controller) await join_group_networks(workflow_group_id, { fresh: true });
    return { workflows };
  },
};
