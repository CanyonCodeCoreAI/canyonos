// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DeployedFingerprints, StoredWorkflow } from '@api/db/schema';
import { config } from '@core/env';

import { docker_target } from './workflow-groups.docker';
import { kubernetes_target } from './workflow-groups.kubernetes';
import type { OpenedWorkflowGroups } from '../auth/auth.plugin';
import type { CoreReply } from './workflow-groups.core';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type {
  ApplyFailureCode,
  DashboardRegistration,
  DashboardWorkflows,
  Health,
  ReplicaLogs,
  WorkflowGroupBodyInput,
  WorkflowGroupStatus,
} from './workflow-groups.types';

// Where /v1/workflow-groups runs workflow groups. The routes, the models, the rows, the apply loop's decisions
// and the status shape are the same on every target; a target only says how its deploys start,
// stop, update and report. One per API process, from CANYONOS_TARGET: Docker, a Global Controller container per workflow group (workflow-groups.docker.ts), or
// Kubernetes, a CanyonBuild and the CanyonProject it applies (workflow-groups.kubernetes.ts).

export interface ApplyFailure {
  error: string;
  code: ApplyFailureCode;
}

/** One pass of the apply loop over a workflow group, against what its target runs now. */
export interface ApplyPass {
  /** The row as the target takes it now: on Docker a new container's starts from nothing. */
  row: WorkflowGroupRow;
  /** Whether a deploy runs, so a stop or an update has something to act on. */
  running: boolean;
  start(uploaded: DeployedFingerprints): Promise<ApplyFailure | null>;
  stop(): Promise<ApplyFailure | null>;
  /** Brings the running deploy in line with the upload. A `config` change keeps its agents
   * running; a `code` change needs new images, which Docker gets by stopping the deploy and
   * starting it again, and Kubernetes by rolling them out while the deploy keeps serving. */
  update(uploaded: DeployedFingerprints, change: DeployChange): Promise<ApplyFailure | null>;
}

/** What changed since the deploy was applied: `config`, its workflow_group.yaml, `.env` files or
 * workflows' `config/` files; `code`, any other file, or its API key. */
export type DeployChange = 'config' | 'code';

/** The deploy's part of a workflow group's status. */
export type DeployReport = Pick<
  WorkflowGroupStatus,
  | 'version'
  | 'running'
  | 'phase'
  | 'message'
  | 'steps'
  | 'slowest_step'
  | 'idle_seconds'
  | 'error'
  | 'error_code'
  | 'root_cause'
  | 'endpoint'
  | 'agents'
  | 'machine_errors'
  | 'errors'
>;

/** Every method that takes a row throws 404 `unknown_workflow_group` when the row is null and
 * the target runs nothing of the workflow group either. */
export interface WorkflowGroupTarget {
  /** The workflow groups the target runs, those with no row here too. */
  workflow_group_ids(): Promise<string[]>;
  /** Takes a PUT of the workflow group's settings where it runs, making its row when it has
   * none, with the API key hash the PUT sets (`api_key_hash`; undefined keeps, null removes):
   * writes workflow_group.yaml and its `.env`, and removes the uploaded workflows
   * `body.workflows` leaves out, whose workflow_ids it returns. Runs holding the workflow
   * group's lock. */
  put_group_files(
    workflow_group_id: string,
    body: WorkflowGroupBodyInput,
    api_key_hash: string | null | undefined
  ): Promise<{ removed_workflows: string[] }>;
  /** Reads an upload's body, before the workflow group's lock is taken. */
  receive_archive(body: ReadableStream<Uint8Array>): Promise<Blob>;
  /** Checks and unpacks a workflow's archive where the workflow group runs, as the core
   * command `put-workflow` does. Runs holding the workflow group's lock. */
  put_workflow(workflow_group_id: string, name: string, archive: Blob): Promise<CoreReply>;
  /** Removes uploaded workflows where the workflow group runs. Holding its lock. */
  remove_workflows(workflow_group_id: string, names: string[]): Promise<void>;
  /** The workflows uploaded where the workflow group runs now. */
  uploaded_workflows(
    workflow_group_id: string,
    row: WorkflowGroupRow | null
  ): Promise<Record<string, StoredWorkflow>>;
  /** Stops what the target runs of a workflow group with no row here. Holding its lock. */
  stop_unlisted(workflow_group_id: string): Promise<ApplyFailure | null>;

  /** At API start, before any apply loop resumes: rebuilds what the API keeps in memory. */
  restore(): Promise<void>;
  /** Whether the apply loops of unapplied changes resume at API start. */
  readonly resumes_apply_loops: boolean;
  /** Starts a pass of the apply loop. Holding the workflow group's lock. */
  begin_apply(row: WorkflowGroupRow): Promise<ApplyPass>;
  /** Whether a deploy is still starting, which a change other than a stop waits for. */
  starting(workflow_group_id: string): Promise<boolean>;

  report(workflow_group_id: string, row: WorkflowGroupRow | null): Promise<DeployReport>;
  controller_log(
    workflow_group_id: string,
    row: WorkflowGroupRow | null,
    tail: string,
    follow: boolean,
    signal: AbortSignal
  ): Promise<Response>;
  health(workflow_group_id: string, row: WorkflowGroupRow | null): Promise<Health>;
  agent_logs(
    workflow_group_id: string,
    row: WorkflowGroupRow | null,
    name: string,
    tail: string
  ): Promise<ReplicaLogs>;
  /** Registers the workflow group's workflows with this dashboard, before its deploy starts;
   * `registration` is what the caller sent, which only Docker needs, and `opened` the workflow
   * groups the caller opens, out of which alone a workflow may move. */
  register_dashboard(
    workflow_group_id: string,
    row: WorkflowGroupRow | null,
    registration: DashboardRegistration | undefined,
    opened: OpenedWorkflowGroups
  ): Promise<DashboardWorkflows>;
}

/** This API process's target, from CANYONOS_TARGET: Kubernetes, else Docker. */
export const target: WorkflowGroupTarget =
  config.workflowGroups.target === 'kubernetes' ? kubernetes_target : docker_target;
