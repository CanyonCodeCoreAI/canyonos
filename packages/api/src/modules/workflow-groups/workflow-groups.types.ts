// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { RedisClientTlsSchema, WorkflowGroupRegistrationSchema } from '../registry/registry.types';

// What /v1/workflow-groups takes and answers, the same on Docker and on Kubernetes; the CLI's
// models (packages/cli/canyonos/sdk/models.py) are generated from these.

export const WorkflowGroupParams = z.object({ workflow_group_id: z.string().uuid() });

// An agent's ID, or one of its replicas' ID; a replica's reaches the controller as one argument,
// never a shell.
export const AgentParams = WorkflowGroupParams.extend({ agent_id: z.string().min(1).max(200) });

export const TailQuery = z.object({
  tail: z
    .string()
    .regex(/^(\d+|all)$/, 'tail must be a number of lines or `all`')
    .default('all'),
});

export const LogsQuery = TailQuery.extend({
  follow: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((flag) => flag === 'true')])
    .default(false),
});

export const WorkflowGroupBody = z.object({
  name: z.string(),
  // `workflow_group.yaml`'s text.
  config: z.string(),
  // The `.env` beside it, null for none.
  env: z.string().nullable(),
  // Every workflow of the workflow group, by workflow_id; the uploaded ones it leaves out are
  // removed.
  workflows: z.array(z.string().uuid()).nullable().optional(),
  // The SHA-256 of the deploy's API key, "" for none; a change restarts the deploy.
  api_key_hash: z.string().nullable().optional(),
});

export const WorkflowGroupSchema = z.object({
  workflow_group_id: z.string(),
  // What the workflow group's PUT last sent, empty before one.
  name: z.string(),
});

export const WorkflowGroupsSchema = z.object({ workflow_groups: z.array(WorkflowGroupSchema) });

export const GenerationSchema = z.object({ generation: z.number().int() });

// `warnings` name problems in the upload that don't stop the deploy.
export const UploadedSchema = GenerationSchema.extend({ warnings: z.array(z.string()) });

export const SlowestStepSchema = z.object({ name: z.string(), seconds: z.number() });

export const EndpointRouteSchema = z.object({
  workflow: z.string(),
  workflow_id: z.string().nullable(),
  agent: z.string(),
  method: z.string(),
  arguments: z.array(z.string()),
  url: z.string(),
});

export const EndpointSchema = z.object({
  public_host: z.string(),
  api_port: z.number().int(),
  routes: z.array(EndpointRouteSchema),
});

export const AgentStatusSchema = z.object({
  // One per agent name in its workflow; null when the deploy publishes no workflow of that name.
  agent_id: z.string().nullable(),
  name: z.string(),
  desired_replicas: z.number().int(),
  running_replicas: z.number().int(),
  launch_error: z.string().nullable(),
});

export const APPLY_ACTIONS = ['none', 'start', 'restart', 'reload', 'stop'] as const;
export const APPLY_FAILURES = [
  'config_invalid',
  'reload_failed',
  'reload_timeout',
  'stop_timeout',
  'stop_failed',
  'start_failed',
] as const;

// What the apply loop last did to bring the deploy in line with `generation`.
export const LastApplySchema = z.object({
  generation: z.number().int(),
  action: z.enum(APPLY_ACTIONS),
  ok: z.boolean(),
  error: z.string().nullable(),
  code: z.enum(APPLY_FAILURES).nullable(),
});

export const DEPLOY_PHASES = ['starting', 'up', 'failed', 'stopped'] as const;
export const DEPLOY_ERRORS = [
  'deploy_failed',
  'deploy_incomplete',
  'deploy_stopped_early',
  'deploy_timeout',
  'controller_exited',
] as const;

// `name` and `config` are what the workflow group's PUT last sent, without the `.env`; `running`
// is whether the deploy runs (on Docker its Global Controller container; on Kubernetes from its
// start until it is stopped), so a failed deploy can still be running while it stops itself.
// `version` is the core version the deploy runs (on Kubernetes, the API's core sidecar's), null
// before it reported one.
export const WorkflowGroupStatusSchema = z.object({
  version: z.string().nullable(),
  name: z.string(),
  config: z.string().nullable(),
  running: z.boolean(),
  phase: z.enum(DEPLOY_PHASES).nullable(),
  message: z.string().nullable(),
  steps: z.array(z.string()),
  slowest_step: SlowestStepSchema.nullable(),
  idle_seconds: z.number().nullable(),
  error: z.string().nullable(),
  error_code: z.enum(DEPLOY_ERRORS).nullable(),
  root_cause: z.string().nullable(),
  endpoint: EndpointSchema.nullable(),
  agents: z.array(AgentStatusSchema).nullable(),
  machine_errors: z.record(z.string()).nullable(),
  generation: z.number().int(),
  applied_generation: z.number().int(),
  applying: z.enum(['start', 'restart', 'reload', 'stop']).nullable(),
  last_apply: LastApplySchema.nullable(),
  errors: z.array(z.string()),
});

export const HealthCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().nullable(),
});

export const HealthSchema = z.object({ ok: z.boolean(), checks: z.array(HealthCheckSchema) });

export const ReplicaLogsSchema = z.object({ logs: z.record(z.array(z.string())) });

// Digests over a workflow's uploaded files: `config` over its `config/` files and `.env`, which a
// reload applies, and `code` over the rest.
export const FingerprintsSchema = z.object({ code: z.string(), config: z.string() });

// `test_query` is its `config/test_query.txt`, null when it has none.
export const WorkflowSchema = z.object({
  workflow_id: z.string(),
  name: z.string(),
  fingerprints: FingerprintsSchema,
  test_query: z.string().nullable(),
});

export const WorkflowsSchema = z.object({ workflows: z.array(WorkflowSchema) });

// What `canyonos deploy` registers with the dashboard on Docker, before the Global Controller
// starts: each workflow's name by its workflow_id, and the Redis the dashboard reads them from.
export const DashboardRegistrationSchema = WorkflowGroupRegistrationSchema;

export const DashboardWorkflowSchema = z.object({ workflow_id: z.string(), name: z.string() });

export const DashboardWorkflowsSchema = z.object({
  workflows: z.array(DashboardWorkflowSchema),
});

export const WORKFLOW_GROUP_ERRORS = [
  'auth.control_key_unset',
  'auth.missing_key',
  'auth.invalid_key',
  'auth.unauthenticated',
  'auth.forbidden',
  'workflow_groups.bad_archive',
  'workflow_groups.workflow_invalid',
  'workflow_groups.upload_too_large',
  'workflow_groups.unknown_workflow_group',
  'workflow_groups.unknown_workflow',
  'workflow_groups.unknown_agent',
  'workflow_groups.not_running',
  'workflow_groups.replicas_unreadable',
  'workflow_groups.stop_timeout',
  'workflow_groups.stop_failed',
  'workflow_groups.controller_missing',
  'workflow_groups.controller_failed',
  'workflow_groups.reupload_needed',
  'workflow_groups.registration_required',
  'registry.registration_failed',
  'database.unavailable',
  'kubernetes.error',
  'docker.disabled',
  'docker.unavailable',
  'docker.timeout',
  'docker.error',
  'docker.not_found',
  'docker.conflict',
  'validation_error',
  'internal_error',
  'not_found',
] as const;

// Every error answer; `findings` and `warnings` only come with `workflow_groups.workflow_invalid`,
// `details` only with `validation_error`.
export const WorkflowGroupErrorSchema = z.object({
  error: z.enum(WORKFLOW_GROUP_ERRORS),
  message: z.string(),
  request_id: z.string().optional(),
  findings: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  details: z
    .array(z.object({ path: z.string(), summary: z.string(), message: z.string() }))
    .optional(),
});

// The Python models' names, so both servers' specs read alike; no dots, which the Python client's
// generator would take for modules. A model nested in another is a reference to its own.
export const WORKFLOW_GROUP_MODELS = {
  WorkflowGroupBody,
  WorkflowGroup: WorkflowGroupSchema,
  WorkflowGroups: WorkflowGroupsSchema,
  Generation: GenerationSchema,
  Uploaded: UploadedSchema,
  SlowestStep: SlowestStepSchema,
  EndpointRoute: EndpointRouteSchema,
  Endpoint: EndpointSchema,
  AgentStatus: AgentStatusSchema,
  LastApply: LastApplySchema,
  WorkflowGroupStatus: WorkflowGroupStatusSchema,
  HealthCheck: HealthCheckSchema,
  Health: HealthSchema,
  ReplicaLogs: ReplicaLogsSchema,
  Fingerprints: FingerprintsSchema,
  Workflow: WorkflowSchema,
  Workflows: WorkflowsSchema,
  RedisClientTls: RedisClientTlsSchema,
  DashboardRegistration: DashboardRegistrationSchema,
  DashboardWorkflow: DashboardWorkflowSchema,
  DashboardWorkflows: DashboardWorkflowsSchema,
  WorkflowGroupError: WorkflowGroupErrorSchema,
};

export type WorkflowGroupBodyInput = z.infer<typeof WorkflowGroupBody>;
export type WorkflowGroup = z.infer<typeof WorkflowGroupSchema>;
export type WorkflowGroups = z.infer<typeof WorkflowGroupsSchema>;
export type Generation = z.infer<typeof GenerationSchema>;
export type Uploaded = z.infer<typeof UploadedSchema>;
export type SlowestStep = z.infer<typeof SlowestStepSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type ApplyAction = (typeof APPLY_ACTIONS)[number];
export type ApplyFailureCode = (typeof APPLY_FAILURES)[number];
export type LastApply = z.infer<typeof LastApplySchema>;
export type DeployPhase = (typeof DEPLOY_PHASES)[number];
export type WorkflowGroupStatus = z.infer<typeof WorkflowGroupStatusSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type ReplicaLogs = z.infer<typeof ReplicaLogsSchema>;
export type Fingerprints = z.infer<typeof FingerprintsSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Workflows = z.infer<typeof WorkflowsSchema>;
export type DashboardRegistration = z.infer<typeof DashboardRegistrationSchema>;
export type DashboardWorkflows = z.infer<typeof DashboardWorkflowsSchema>;
export type WorkflowGroupError = z.infer<typeof WorkflowGroupErrorSchema>;
