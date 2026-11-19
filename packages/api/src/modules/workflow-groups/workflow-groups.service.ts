// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { StoredWorkflow } from '@api/db/schema';
import * as docker from '@core/docker';
import {
  AppError,
  badGateway,
  badRequest,
  gatewayTimeout,
  internalError,
  notFound,
  serviceUnavailable,
} from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { Container } from '@core/docker';

import { register_workflows_at } from '../canyonos/canyonos.bootstrap';
import { RedisClientTlsSchema } from '../canyonos/canyonos.types';
import {
  applied,
  applying,
  env_digest,
  fingerprints,
  record_change,
  with_group_lock,
} from './workflow-groups.apply';
import {
  controller_missing,
  core_answer,
  core_error,
  find_controller,
  list_controllers,
  not_running,
  read_progress,
  run_in_controller,
  run_job,
  stop_controller,
} from './workflow-groups.controller';
import { workflow_groups_repo } from './workflow-groups.repo';
import {
  AgentStatusSchema,
  DEPLOY_PHASES,
  EndpointSchema,
  HealthCheckSchema,
  ReplicaLogsSchema,
} from './workflow-groups.types';
import type { CoreReply } from './workflow-groups.controller';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type {
  DashboardWorkflows,
  Generation,
  Health,
  ReplicaLogs,
  Uploaded,
  Workflow,
  WorkflowGroupBodyInput,
  WorkflowGroups,
  WorkflowGroupStatus,
  Workflows,
} from './workflow-groups.types';

const workflow_groups_logger = logger.child({ domain: LOG_DOMAINS.WORKFLOW_GROUPS });

const UPLOAD_ARCHIVE = 'upload.tar.gz';
const GROUP_FILES = 'group.json';
const EXPLAINED_FAILURE_EXIT_CODE = 1;
const UNKNOWN_AGENT_EXIT_CODE = 3;
// Past the 180 s an SSH read of one replica's log takes at most.
const AGENT_LOGS_TIMEOUT_MS = 190_000;
const RUNTIME_STATUS_CACHE_MS = 2_000;
// Just after a deploy its Redis can refuse connections for a moment.
const DASHBOARD_RETRY_MS = 60_000;
const DASHBOARD_RETRY_DELAY_MS = 2_000;

const OkSchema = z.object({ ok: z.literal(true) });
const RemovedSchema = z.object({ removed: z.array(z.string()) });
const PutWorkflowAnswerSchema = z.object({
  digests: z.record(z.string()),
  warnings: z.array(z.string()),
  test_query: z.string().nullable(),
});
const PutWorkflowRefusalSchema = z.object({
  error: z.string(),
  code: z.enum(['bad_archive', 'workflow_invalid']),
  findings: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
const RuntimeStatusSchema = z.object({
  endpoint: EndpointSchema.nullable(),
  agents: z.record(AgentStatusSchema).nullable(),
  machine_errors: z.record(z.string()).nullable(),
  errors: z.array(z.string()),
});
const HealthAnswerSchema = z.object({ checks: z.array(HealthCheckSchema) });
const DashboardCredentialsSchema = z.object({
  redis_host: z.string(),
  redis_port: z.number().int(),
  redis_password: z.string(),
  redis_tls: RedisClientTlsSchema.nullable(),
});

type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

function unknown_workflow_group(workflow_group_id: string): AppError {
  return notFound(
    'workflow_groups.unknown_workflow_group',
    `No workflow group has the id ${workflow_group_id}`
  );
}

function unknown_workflow(name: string): AppError {
  return notFound('workflow_groups.unknown_workflow', `No workflow is named ${name}`);
}

/** The workflow group's row and Global Controller container; 404 when it has neither. */
async function locate(
  workflow_group_id: string
): Promise<{ row: WorkflowGroupRow | null; controller: Container | null }> {
  const [controller, row] = await Promise.all([
    find_controller(workflow_group_id),
    workflow_groups_repo.find(workflow_group_id),
  ]);
  if (!row && !controller) throw unknown_workflow_group(workflow_group_id);
  return { row, controller };
}

async function running_controller(workflow_group_id: string): Promise<Container> {
  const { controller } = await locate(workflow_group_id);
  if (!controller?.running) throw not_running();
  return controller;
}

/** The workflows uploaded into this controller's volume; an upload into an earlier one's
 * volume is not there. */
function uploaded_workflows(
  row: WorkflowGroupRow | null,
  controller: Container | null
): Record<string, StoredWorkflow> {
  if (!row || (controller && row.controller_container_id !== controller.id)) return {};
  return row.workflows;
}

function workflow_view(name: string, workflow: StoredWorkflow): Workflow {
  return { name, fingerprints: fingerprints(workflow.digests), test_query: workflow.test_query };
}

export async function list_workflow_groups(): Promise<WorkflowGroups> {
  const [controllers, rows] = await Promise.all([list_controllers(), workflow_groups_repo.list()]);
  const names = new Map<string, string>(rows.map(({ id, name }) => [id, name]));
  for (const workflow_group_id of controllers.keys()) {
    if (!names.has(workflow_group_id)) names.set(workflow_group_id, '');
  }
  return {
    workflow_groups: [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workflow_group_id, name]) => ({ workflow_group_id, name })),
  };
}

/** Writes workflow_group.yaml and its .env into /workspace now, removes the uploaded workflows
 * `workflows` leaves out, and keeps the rest for the apply loop. */
export async function put_workflow_group(
  workflow_group_id: string,
  body: WorkflowGroupBodyInput
): Promise<Uploaded> {
  const controller = await find_controller(workflow_group_id);
  if (!controller) throw controller_missing(workflow_group_id);
  const generation = await with_group_lock(workflow_group_id, async () => {
    const row = await workflow_groups_repo.claim(workflow_group_id, controller.id);
    core_answer(
      await run_job(controller, ['write-group-files'], {
        [GROUP_FILES]: JSON.stringify({ config: body.config, env: body.env }),
      }),
      OkSchema
    );
    const listed = body.workflows ? new Set(body.workflows) : null;
    const removed_workflows = listed
      ? Object.keys(row.workflows).filter((name) => !listed.has(name))
      : [];
    if (removed_workflows.length > 0) {
      core_answer(
        await run_job(controller, ['remove-workflows', ...removed_workflows]),
        RemovedSchema
      );
    }
    return workflow_groups_repo.save_settings(workflow_group_id, {
      name: body.name,
      config: body.config,
      env_digest: env_digest(body.env),
      // Null keeps the API key hash it has, "" removes it.
      api_key_hash: body.api_key_hash == null ? undefined : body.api_key_hash || null,
      removed_workflows,
    });
  });
  if (generation === null) throw unknown_workflow_group(workflow_group_id);
  record_change(workflow_group_id);
  return { generation, warnings: [] };
}

/** Stops the deploy, then forgets the upload: 504 when it did not stop in time, 500 when it
 * stopped with an error, and the row stays. A Global Controller this API holds no upload for
 * is stopped all the same. */
export async function delete_workflow_group(workflow_group_id: string): Promise<Generation> {
  const { row, controller } = await locate(workflow_group_id);
  if (!row) {
    const failure = await with_group_lock(workflow_group_id, async () =>
      controller?.running ? stop_controller(controller) : null
    );
    if (failure) throw stop_refusal(failure);
    return { generation: 0 };
  }
  const generation = await workflow_groups_repo.clear_upload(workflow_group_id);
  if (generation === null) throw unknown_workflow_group(workflow_group_id);
  record_change(workflow_group_id);
  const last_apply = await applied(workflow_group_id, generation);
  if (last_apply && !last_apply.ok) {
    throw stop_refusal({ error: last_apply.error ?? 'The stop failed', code: last_apply.code });
  }
  await workflow_groups_repo.remove(workflow_group_id);
  return { generation };
}

function stop_refusal({ error, code }: { error: string; code: string | null }): AppError {
  if (code === 'stop_timeout') return gatewayTimeout('workflow_groups.stop_timeout', error);
  return internalError('workflow_groups.stop_failed', error);
}

/** Checks the uploaded gzip tar of workflow `name` as `canyonos validate` does, then unpacks it
 * into /workspace/<name>, removing what its last upload had and this one lacks; on a 400 (bad
 * archive, unsafe path or findings) the old files stay. */
export async function put_workflow(
  workflow_group_id: string,
  name: string,
  archive: Uint8Array
): Promise<Uploaded> {
  if (!(await workflow_groups_repo.find(workflow_group_id))) {
    throw unknown_workflow_group(workflow_group_id);
  }
  const controller = await find_controller(workflow_group_id);
  if (!controller) throw controller_missing(workflow_group_id);
  const { generation, warnings } = await with_group_lock(workflow_group_id, async () => {
    await workflow_groups_repo.claim(workflow_group_id, controller.id);
    const reply = await run_job(
      controller,
      ['put-workflow', name, '--archive', `/tmp/${UPLOAD_ARCHIVE}`],
      { [UPLOAD_ARCHIVE]: archive }
    );
    throw_upload_refusal(reply);
    const answer = core_answer(reply, PutWorkflowAnswerSchema);
    const generation = await workflow_groups_repo.save_workflow(workflow_group_id, name, {
      digests: answer.digests,
      test_query: answer.test_query,
    });
    return { generation, warnings: answer.warnings };
  });
  if (generation === null) throw unknown_workflow_group(workflow_group_id);
  record_change(workflow_group_id);
  return { generation, warnings };
}

function throw_upload_refusal(reply: CoreReply): void {
  if (reply.exit_code !== EXPLAINED_FAILURE_EXIT_CODE) return;
  const refusal = PutWorkflowRefusalSchema.safeParse(reply.answer);
  if (!refusal.success) return;
  const { error, code, findings, warnings } = refusal.data;
  throw badRequest(`workflow_groups.${code}`, error, {
    retryable: false,
    extra: code === 'workflow_invalid' ? { findings, warnings } : undefined,
  });
}

/** Removes from /workspace what workflow `name`'s last upload put there. */
export async function delete_workflow(
  workflow_group_id: string,
  name: string
): Promise<Generation> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  if (!row) throw unknown_workflow_group(workflow_group_id);
  const controller = await find_controller(workflow_group_id);
  if (!(name in uploaded_workflows(row, controller))) throw unknown_workflow(name);
  const generation = await with_group_lock(workflow_group_id, async () => {
    if (controller) {
      core_answer(await run_job(controller, ['remove-workflows', name]), RemovedSchema);
    }
    return workflow_groups_repo.remove_workflow(workflow_group_id, name);
  });
  if (generation === null) throw unknown_workflow_group(workflow_group_id);
  record_change(workflow_group_id);
  return { generation };
}

export async function list_workflows(workflow_group_id: string): Promise<Workflows> {
  const { row, controller } = await locate(workflow_group_id);
  const workflows = uploaded_workflows(row, controller);
  return {
    workflows: Object.keys(workflows)
      .sort()
      .map((name) => workflow_view(name, workflows[name]!)),
  };
}

export async function get_workflow(workflow_group_id: string, name: string): Promise<Workflow> {
  const { row, controller } = await locate(workflow_group_id);
  const workflow = uploaded_workflows(row, controller)[name];
  if (!workflow) throw unknown_workflow(name);
  return workflow_view(name, workflow);
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
  const read = run_in_controller(controller, ['runtime-status'])
    .then((reply) => core_answer(reply, RuntimeStatusSchema))
    .catch(
      (error: unknown): RuntimeStatus => ({
        endpoint: null,
        agents: null,
        machine_errors: null,
        errors: [
          `Could not read the deploy's state: ${error instanceof Error ? error.message : String(error)}`,
        ],
      })
    );
  runtime_statuses.set(workflow_group_id, { container_id: controller.id, at: Date.now(), read });
  return read;
}

/** The workflow group's name and workflow_group.yaml as last uploaded, how far the apply loop
 * got, the deploy's phase, progress and verdict, and while it runs, its endpoint, agents and
 * machine errors; a part that could not be read is left null and named under `errors`. */
export async function get_status(workflow_group_id: string): Promise<WorkflowGroupStatus> {
  const { row, controller } = await locate(workflow_group_id);
  const progress = controller ? await read_progress(controller) : null;
  const running = controller?.running ?? false;
  const phase = progress?.phase ?? null;
  const runtime =
    controller && running && (phase === 'up' || phase === 'failed')
      ? await runtime_status(workflow_group_id, controller)
      : null;
  return {
    version: progress?.version ?? null,
    name: row?.name ?? '',
    config: row?.config ?? null,
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
    generation: row?.generation ?? 0,
    applied_generation: row?.applied_generation ?? 0,
    applying: applying(workflow_group_id),
    last_apply: row?.last_apply ?? null,
    errors: [
      ...(progress?.problem ? [`Could not read the deploy's progress: ${progress.problem}`] : []),
      ...(runtime?.errors ?? []),
    ],
  };
}

/** The controller log of the container's current run, the last `tail` lines of it, as text; with
 * `follow`, it keeps streaming new lines until the container stops. Empty before a first start. */
export async function controller_log(
  workflow_group_id: string,
  tail: string,
  follow: boolean,
  signal: AbortSignal
): Promise<Response> {
  const { controller } = await locate(workflow_group_id);
  const text = (body: BodyInit | null) =>
    new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!controller || controller.started_at_ms === null) return text('');
  return text(
    await docker.log_stream(
      controller.id,
      { tail, since_ms: controller.started_at_ms, follow },
      signal
    )
  );
}

/** Checks the running deploy's Global Controller, Redis, each agent's replica count and its
 * endpoint, each with how to fix it when it fails. */
export async function check_health(workflow_group_id: string): Promise<Health> {
  const controller = await running_controller(workflow_group_id);
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
}

/** The last `tail` lines of each running replica of agent `name`, or of the replica whose ID is
 * `name`, read on its machine. */
export async function agent_logs(
  workflow_group_id: string,
  name: string,
  tail: string
): Promise<ReplicaLogs> {
  const controller = await running_controller(workflow_group_id);
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
}

/** Registers the running deploy's workflows with this dashboard: its Redis host, port and
 * password, plus a client certificate its CA signs when its Redis takes only TLS. Failures that
 * may pass, such as its Redis not answering yet, are retried for a minute. */
export async function register_dashboard(workflow_group_id: string): Promise<DashboardWorkflows> {
  const controller = await running_controller(workflow_group_id);
  const credentials = core_answer(
    await run_in_controller(controller, ['dashboard-credentials']),
    DashboardCredentialsSchema
  );
  const deadline = Date.now() + DASHBOARD_RETRY_MS;
  for (;;) {
    try {
      const workflows = await register_workflows_at(
        credentials.redis_host,
        credentials.redis_port,
        credentials.redis_password,
        credentials.redis_tls ?? undefined
      );
      return { workflows };
    } catch (error) {
      const app_error = error instanceof AppError ? error : null;
      const transient = !app_error || app_error.status >= 500;
      if (!transient || Date.now() + DASHBOARD_RETRY_DELAY_MS > deadline) {
        const message = error instanceof Error ? error.message : String(error);
        workflow_groups_logger.warn('Could not register the workflow group with the dashboard', {
          workflow_group_id,
          error,
        });
        throw badGateway(
          app_error?.code === 'canyonos.controller_unreachable'
            ? 'workflow_groups.dashboard_unreachable'
            : 'workflow_groups.dashboard_refused',
          message,
          { cause: error }
        );
      }
      await Bun.sleep(DASHBOARD_RETRY_DELAY_MS);
    }
  }
}
