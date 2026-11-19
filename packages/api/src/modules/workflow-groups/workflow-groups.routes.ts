// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';
import type { Context } from 'elysia';

import { early_refusal, payloadTooLarge } from '@core/errors';

import { upload_started } from './workflow-groups.apply';
import { check_settings_caller } from './workflow-groups.caller';
import {
  agent_logs,
  check_health,
  controller_log,
  delete_workflow,
  delete_workflow_group,
  get_status,
  get_workflow,
  list_workflow_groups,
  list_workflows,
  put_workflow,
  put_workflow_group,
  register_dashboard,
} from './workflow-groups.service';
import {
  AgentParams,
  LogsQuery,
  TailQuery,
  WORKFLOW_GROUP_MODELS,
  WorkflowGroupParams,
  WorkflowParams,
} from './workflow-groups.types';

/** The largest workflow archive a PUT takes, as the Kubernetes receiver
 * (canyonos_core/kubernetes/receiver.py `MAX_UPLOAD_BYTES`). */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const PREFIX = '/v1/workflow-groups';
// The PUTs that change an upload, counted from before their body is read.
const UPLOAD_PATH = /^\/v1\/workflow-groups\/([^/]+)(?:\/workflows\/[^/]+)?$/;

// The control key on Docker, the caller's own Kubernetes login on Kubernetes.
const security: Record<string, string[]>[] = [{ controlKey: [] }, { kubernetesToken: [] }];
const doc = { tags: ['WorkflowGroups'], security };

const refused = 'WorkflowGroupError' as const;
// Every route: not signed in (401), not allowed in the workflow group's namespace (403, on
// Kubernetes), a request it cannot read (422), the Kubernetes API failing (502), Docker out of
// reach (503).
const refusals = { 401: refused, 403: refused, 422: refused, 502: refused, 503: refused } as const;

const GZIP_BODY = {
  required: true,
  description: "A gzip tar of the workflow's folder, paths relative to it, with its `.env`",
  content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } },
} as const;

/** Bun cuts a request its handler leaves silent for 30 s; a stop, an upload's check or a log
 * read can take longer, each bounded by its own timeout instead. */
function lift_idle_timeout({ server, request }: Pick<Context, 'server' | 'request'>): void {
  server?.timeout(request, 0);
}

const upload_releases = new WeakMap<Request, () => void>();

export const workflowGroupsRoutes = new Elysia({ prefix: PREFIX, name: 'workflow-groups.routes' })
  .model(WORKFLOW_GROUP_MODELS)
  // After the control key check, which the app mounts first: only an accepted PUT counts.
  .onRequest(({ request, set }) => {
    if (request.method !== 'PUT') return;
    const match = UPLOAD_PATH.exec(new URL(request.url).pathname);
    if (!match) return;
    if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
      return early_refusal(
        set,
        payloadTooLarge(
          'workflow_groups.upload_too_large',
          `An upload takes at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB`
        )
      );
    }
    const release = upload_started(decodeURIComponent(match[1]!));
    upload_releases.set(request, release);
    request.signal.addEventListener('abort', release, { once: true });
  })
  .onAfterResponse(({ request }) => upload_releases.get(request)?.())
  .get('', () => list_workflow_groups(), {
    response: { 200: 'WorkflowGroups', 401: refused, 502: refused, 503: refused },
    detail: {
      ...doc,
      operationId: 'listWorkflowGroups',
      summary: 'List the workflow groups',
      description:
        'Every workflow group with an upload here or a deploy (a Global Controller container on ' +
        'Docker, a CanyonProject on Kubernetes), with the name its last PUT gave it, empty ' +
        'before one.',
    },
  })
  .put(
    '/:workflow_group_id',
    async (context) => {
      lift_idle_timeout(context);
      await check_settings_caller(context.request, context.body.config);
      return put_workflow_group(context.params.workflow_group_id, context.body);
    },
    {
      params: WorkflowGroupParams,
      parse: 'json',
      body: 'WorkflowGroupBody',
      response: { 200: 'Uploaded', ...refusals, 409: refused },
      detail: {
        ...doc,
        operationId: 'putWorkflowGroup',
        summary: 'Upload workflow_group.yaml and its .env',
        description:
          "Writes `workflow_group.yaml` and the `.env` beside it into the workflow group's " +
          'workspace, removing that `.env` when `env` is null, and keeps `name` as the workflow ' +
          "group's name. With `workflows`, removes the uploaded workflows it leaves out; with " +
          '`api_key_hash`, keeps it as the API key its endpoint checks, none when it is empty. ' +
          'On Docker, 409 `controller_missing` when the CLI has not created the Global ' +
          'Controller container. On Kubernetes, 403 unless the caller may update CanyonProjects ' +
          'in the namespace `config` names, and 409 `reupload_needed` for a PUT without ' +
          '`workflows` while the API holds none of the workflows, as after it restarted.',
      },
    }
  )
  .delete(
    '/:workflow_group_id',
    (context) => {
      lift_idle_timeout(context);
      return delete_workflow_group(context.params.workflow_group_id);
    },
    {
      params: WorkflowGroupParams,
      response: { 200: 'Generation', ...refusals, 404: refused, 500: refused, 504: refused },
      detail: {
        ...doc,
        operationId: 'deleteWorkflowGroup',
        summary: 'Stop the deploy and forget the upload',
        description:
          'Waits for the apply loop to stop the deploy, then forgets the upload; 504 when it did ' +
          'not stop in time and 500 when stopping it failed, keeping the upload. A deploy this ' +
          'API holds no upload for is stopped all the same.',
      },
    }
  )
  .get('/:workflow_group_id', ({ params }) => get_status(params.workflow_group_id), {
    params: WorkflowGroupParams,
    response: { 200: 'WorkflowGroupStatus', ...refusals, 404: refused },
    detail: {
      ...doc,
      operationId: 'getWorkflowGroupStatus',
      summary: "Read the workflow group's status",
      description:
        "The workflow group's name and `workflow_group.yaml` as last uploaded, how far the apply " +
        "loop got, the deploy's phase, progress and verdict, and while it runs, its endpoint, " +
        'agents and machine errors; a part that could not be read is left null and named under ' +
        '`errors`.',
    },
  })
  .put(
    '/:workflow_group_id/workflows/:name',
    (context) => {
      lift_idle_timeout(context);
      const { params, request } = context;
      return put_workflow(params.workflow_group_id, params.name, request.body);
    },
    {
      params: WorkflowParams,
      // Read by the target: on Kubernetes it is streamed to disk, never held in memory.
      parse: 'none',
      response: {
        200: 'Uploaded',
        ...refusals,
        400: refused,
        404: refused,
        409: refused,
        413: refused,
      },
      detail: {
        ...doc,
        operationId: 'putWorkflow',
        summary: 'Upload a workflow',
        description:
          'Checks the gzip tar of workflow `name` as `canyonos validate` does, then unpacks it ' +
          "into the workflow group's workspace, removing what its last upload had and this one " +
          'lacks; on a 400 (bad archive, unsafe path or findings) the old files stay.',
        requestBody: GZIP_BODY,
      },
    }
  )
  .delete(
    '/:workflow_group_id/workflows/:name',
    (context) => {
      lift_idle_timeout(context);
      return delete_workflow(context.params.workflow_group_id, context.params.name);
    },
    {
      params: WorkflowParams,
      response: { 200: 'Generation', ...refusals, 404: refused },
      detail: {
        ...doc,
        operationId: 'deleteWorkflow',
        summary: 'Remove a workflow',
        description:
          "Removes from the workflow group's workspace what workflow `name`'s last upload put " +
          'there; 404 if it was never uploaded.',
      },
    }
  )
  .get('/:workflow_group_id/workflows', ({ params }) => list_workflows(params.workflow_group_id), {
    params: WorkflowGroupParams,
    response: { 200: 'Workflows', ...refusals, 404: refused },
    detail: {
      ...doc,
      operationId: 'listWorkflows',
      summary: 'List the uploaded workflows',
      description: 'Every uploaded workflow, by name.',
    },
  })
  .get(
    '/:workflow_group_id/workflows/:name',
    ({ params }) => get_workflow(params.workflow_group_id, params.name),
    {
      params: WorkflowParams,
      response: { 200: 'Workflow', ...refusals, 404: refused },
      detail: {
        ...doc,
        operationId: 'getWorkflow',
        summary: 'Read a workflow',
        description: 'Uploaded workflow `name`; 404 if it was never uploaded.',
      },
    }
  )
  .get(
    '/:workflow_group_id/logs/controller',
    (context) => {
      lift_idle_timeout(context);
      const { params, query, request } = context;
      return controller_log(params.workflow_group_id, query.tail, query.follow, request.signal);
    },
    {
      params: WorkflowGroupParams,
      query: LogsQuery,
      // Text: the handler answers a stream of the log's lines.
      response: { 200: z.string(), ...refusals, 404: refused },
      detail: {
        ...doc,
        operationId: 'getControllerLog',
        summary: 'Read the controller log',
        description:
          "The deploy's log, the last `tail` lines of it, as text; with `follow=true`, keeps " +
          'streaming new lines until the deploy stops. On Docker, the Global Controller ' +
          "container's log since it last started; on Kubernetes, the build pod's while it " +
          "builds, then the Global Controller pod's. Empty before there is one.",
      },
    }
  )
  .get(
    '/:workflow_group_id/logs/agents/:name',
    (context) => {
      lift_idle_timeout(context);
      const { params, query } = context;
      return agent_logs(params.workflow_group_id, params.name, query.tail);
    },
    {
      params: AgentParams,
      query: TailQuery,
      response: { 200: 'ReplicaLogs', ...refusals, 404: refused, 409: refused },
      detail: {
        ...doc,
        operationId: 'getAgentLogs',
        summary: "Read an agent's replica logs",
        description:
          'The last `tail` lines of each running replica of agent `name`, or of the one replica ' +
          'whose ID is `name`, read on its machine; 409 if the deploy is not running, 404 naming ' +
          'the agents when `name` is neither, 503 when its Redis cannot be read.',
      },
    }
  )
  .get(
    '/:workflow_group_id/health',
    (context) => {
      lift_idle_timeout(context);
      return check_health(context.params.workflow_group_id);
    },
    {
      params: WorkflowGroupParams,
      response: { 200: 'Health', ...refusals, 404: refused, 409: refused },
      detail: {
        ...doc,
        operationId: 'getWorkflowGroupHealth',
        summary: 'Check the running deploy',
        description:
          "Checks the running deploy's Global Controller, Redis, each agent's replica count and " +
          'its endpoint, each with how to fix it when it fails; 409 if it is not running.',
      },
    }
  )
  .put(
    '/:workflow_group_id/dashboard',
    (context) => {
      lift_idle_timeout(context);
      return register_dashboard(context.params.workflow_group_id);
    },
    {
      params: WorkflowGroupParams,
      response: { 200: 'DashboardWorkflows', ...refusals, 404: refused, 409: refused },
      detail: {
        ...doc,
        operationId: 'putWorkflowGroupDashboard',
        summary: "Register the workflow group's workflows with this dashboard",
        description:
          "Registers the running deploy's Redis, and a client certificate its CA signs when its " +
          'Redis takes only TLS, so the dashboard reads its workflows; returns them. Failures ' +
          'that may pass are retried for a minute; 502 when it is refused or never answers. On ' +
          "Kubernetes the operator's registry already lists the workflow group: returns the " +
          'workflows the dashboard knows of it.',
      },
    }
  );
