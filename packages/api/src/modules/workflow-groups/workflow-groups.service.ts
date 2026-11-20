// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { StoredWorkflow } from '@api/db/schema';
import { badRequest, gatewayTimeout, internalError } from '@core/errors';
import type { AppError } from '@core/errors';

import {
  applied,
  applying,
  env_digest,
  fingerprints,
  record_change,
} from './workflow-groups.apply';
import { core_answer } from './workflow-groups.core';
import { unknown_workflow, unknown_workflow_group } from './workflow-groups.errors';
import { workflow_ids } from './workflow-groups.kubernetes';
import { with_group_lock } from './workflow-groups.lock';
import { workflow_groups_repo } from './workflow-groups.repo';
import { target } from './workflow-groups.target';
import type { CoreReply } from './workflow-groups.core';
import type { ApplyFailure } from './workflow-groups.target';
import type {
  DashboardRegistration,
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

// What /v1/workflow-groups does, the same on every target: the rows, the apply loop and the
// answers are here, and the target (workflow-groups.target.ts) does what touches the deploy.

const EXPLAINED_FAILURE_EXIT_CODE = 1;

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

function workflow_view(workflow_id: string, workflow: StoredWorkflow): Workflow {
  return {
    workflow_id,
    name: workflow.name,
    fingerprints: fingerprints(workflow.digests),
    test_query: workflow.test_query,
  };
}

export async function list_workflow_groups(): Promise<WorkflowGroups> {
  const [running, rows] = await Promise.all([
    target.workflow_group_ids(),
    workflow_groups_repo.list(),
  ]);
  const names = new Map<string, string>(rows.map(({ id, name }) => [id, name]));
  for (const workflow_group_id of running) {
    if (!names.has(workflow_group_id)) names.set(workflow_group_id, '');
  }
  return {
    workflow_groups: [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workflow_group_id, name]) => ({ workflow_group_id, name })),
  };
}

/** Writes workflow_group.yaml and its .env where the workflow group runs, removes the uploaded
 * workflows `workflows` leaves out, and keeps the rest for the apply loop. */
export async function put_workflow_group(
  workflow_group_id: string,
  body: WorkflowGroupBodyInput
): Promise<Uploaded> {
  const generation = await with_group_lock(workflow_group_id, async () => {
    const { removed_workflows } = await target.put_group_files(workflow_group_id, body);
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
 * stopped with an error, and the row stays. A deploy this API holds no upload for is stopped
 * all the same. */
export async function delete_workflow_group(workflow_group_id: string): Promise<Generation> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  if (!row) {
    const failure = await with_group_lock(workflow_group_id, () =>
      target.stop_unlisted(workflow_group_id)
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

function stop_refusal({
  error,
  code,
}: {
  error: string;
  code: ApplyFailure['code'] | null;
}): AppError {
  if (code === 'stop_timeout') return gatewayTimeout('workflow_groups.stop_timeout', error);
  return internalError('workflow_groups.stop_failed', error);
}

/** Checks the uploaded gzip tar of the workflow as `canyonos validate` does, then unpacks it
 * where the workflow group runs, under the name the uploaded workflow_group.yaml gives its
 * workflow_id, removing what its last upload had and this one lacks; on a 400 (bad archive,
 * unsafe path or findings) the old files stay. */
export async function put_workflow(
  workflow_group_id: string,
  workflow_id: string,
  body: ReadableStream<Uint8Array> | null
): Promise<Uploaded> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  if (!row) throw unknown_workflow_group(workflow_group_id);
  const name = Object.entries(workflow_ids(row.config)).find(([, id]) => id === workflow_id)?.[0];
  if (!name) throw unknown_workflow(workflow_id);
  const archive = await target.receive_archive(body ?? new Blob([]).stream());
  const { generation, warnings } = await with_group_lock(workflow_group_id, async () => {
    // A workflow whose folder was renamed keeps its workflow_id: its old folder goes.
    const previous = row.workflows[workflow_id];
    if (previous && previous.name !== name) {
      await target.remove_workflows(workflow_group_id, [previous.name]);
    }
    const reply = await target.put_workflow(workflow_group_id, name, archive);
    throw_upload_refusal(reply);
    const answer = core_answer(reply, PutWorkflowAnswerSchema);
    const generation = await workflow_groups_repo.save_workflow(workflow_group_id, workflow_id, {
      name,
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

/** Removes what the workflow's last upload put where the workflow group runs. */
export async function delete_workflow(
  workflow_group_id: string,
  workflow_id: string
): Promise<Generation> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  if (!row) throw unknown_workflow_group(workflow_group_id);
  const workflow = (await target.uploaded_workflows(workflow_group_id, row))[workflow_id];
  if (!workflow) throw unknown_workflow(workflow_id);
  const generation = await with_group_lock(workflow_group_id, async () => {
    await target.remove_workflows(workflow_group_id, [workflow.name]);
    return workflow_groups_repo.remove_workflow(workflow_group_id, workflow_id);
  });
  if (generation === null) throw unknown_workflow_group(workflow_group_id);
  record_change(workflow_group_id);
  return { generation };
}

export async function list_workflows(workflow_group_id: string): Promise<Workflows> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  const workflows = await target.uploaded_workflows(workflow_group_id, row);
  return {
    workflows: Object.keys(workflows)
      .sort()
      .map((workflow_id) => workflow_view(workflow_id, workflows[workflow_id]!)),
  };
}

/** The workflow group's name and workflow_group.yaml as last uploaded, how far the apply loop
 * got, the deploy's phase, progress and verdict, and while it runs, its endpoint, agents and
 * machine errors; a part that could not be read is left null and named under `errors`. */
export async function get_status(workflow_group_id: string): Promise<WorkflowGroupStatus> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  const deploy = await target.report(workflow_group_id, row);
  return {
    version: deploy.version,
    name: row?.name ?? '',
    config: row?.config ?? null,
    running: deploy.running,
    phase: deploy.phase,
    message: deploy.message,
    steps: deploy.steps,
    slowest_step: deploy.slowest_step,
    idle_seconds: deploy.idle_seconds,
    error: deploy.error,
    error_code: deploy.error_code,
    root_cause: deploy.root_cause,
    endpoint: deploy.endpoint,
    agents: deploy.agents,
    machine_errors: deploy.machine_errors,
    generation: row?.generation ?? 0,
    applied_generation: row?.applied_generation ?? 0,
    applying: applying(workflow_group_id),
    last_apply: row?.last_apply ?? null,
    errors: deploy.errors,
  };
}

/** The deploy's log, the last `tail` lines of it, as text; with `follow`, it keeps streaming new
 * lines until the deploy stops. Empty before a first start. */
export async function controller_log(
  workflow_group_id: string,
  tail: string,
  follow: boolean,
  signal: AbortSignal
): Promise<Response> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  return target.controller_log(workflow_group_id, row, tail, follow, signal);
}

/** Checks the running deploy's Global Controller, Redis, each agent's replica count and its
 * endpoint, each with how to fix it when it fails. */
export async function check_health(workflow_group_id: string): Promise<Health> {
  return target.health(workflow_group_id, await workflow_groups_repo.find(workflow_group_id));
}

/** The last `tail` lines of each running replica of the agent whose ID is `agent_id`, or of the
 * one replica whose ID it is. */
export async function agent_logs(
  workflow_group_id: string,
  agent_id: string,
  tail: string
): Promise<ReplicaLogs> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  const { agents } = await target.report(workflow_group_id, row);
  const agent = agents?.find((listed) => listed.agent_id === agent_id);
  return target.agent_logs(workflow_group_id, row, agent?.name ?? agent_id, tail);
}

/** Registers the workflow group's workflows, which this dashboard then reads, and returns them. */
export async function register_dashboard(
  workflow_group_id: string,
  registration: DashboardRegistration | undefined
): Promise<DashboardWorkflows> {
  const row = await workflow_groups_repo.find(workflow_group_id);
  return target.register_dashboard(workflow_group_id, row, registration);
}
