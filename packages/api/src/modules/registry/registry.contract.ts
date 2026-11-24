// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { parse_json } from '@core/json';

// The Redis keys a workflow group's Global Controller, reconciler and LLM gateway write, and
// the dashboard reads or writes, in one place. The Python side owns them:
// packages/core/canyonos_core/endpoint/__init__.py (IDENTITY_KEY, ADDRESS_KEY),
// reconciler/state.py (LAUNCH_ERRORS_KEY, MACHINE_ERRORS_KEY, desired_key),
// controller/utils/config_specs.py (agents:active, agent:<name>:spec),
// controller/controller_context.py (list_replicas: agent:<name>:instances, agent_instance:<id>),
// scaling/contract.py (agent:<name>:samples), reconciler/routing.py (routing_table:up),
// controller/governance.py (governance:config, governance:spend) and
// llm_gateway/prompts.py, llm_gateway/llms.py (prompts:*, llms:config).

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';
/** The sha256 of the workflow group's API key, "" for none, as its Global Controller publishes
 * it (canyonos_core/auth.py API_KEY_HASH_KEY) for the endpoint to check requests against. */
export const API_KEY_HASH_KEY = 'auth:api_key_hash';
export const ENDPOINT_KEY = 'endpoint:address';
export const ACTIVE_AGENTS_KEY = 'agents:active';
export const LAUNCH_ERRORS_KEY = 'reconciler:launch_errors';
export const MACHINE_ERRORS_KEY = 'reconciler:machine_errors';
export const SCALING_CONFIG_KEY = 'scaling:config';
export const GOVERNANCE_CONFIG_KEY = 'governance:config';
export const GOVERNANCE_SPEND_KEY = 'governance:spend';
export const LLMS_CONFIG_KEY = 'llms:config';
/** Written by the reconciler (on Kubernetes, the operator) from replica health. */
export const UP_AGENTS_KEY = 'routing_table:up';
export const PROMPTS_CONFIG_KEY = 'prompts:config';
export const PROMPTS_YAML_KEY = 'prompts:yaml';

export const agent_spec_key = (name: string): string => `agent:${name}:spec`;
export const desired_replicas_key = (name: string): string => `agent:${name}:desired_replicas`;
export const agent_samples_key = (name: string): string => `agent:${name}:samples`;
export const agent_replicas_key = (name: string): string => `agent:${name}:instances`;
export const replica_key = (replica_id: string): string => `agent_instance:${replica_id}`;

/** A JSON string field of a Redis hash, parsed, then checked by `schema`. */
const json_field = <T extends z.ZodTypeAny>(schema: T, name: string) =>
  z
    .string()
    .transform((raw, ctx) => {
      const parsed = parse_json(raw);
      if (parsed === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} is not JSON` });
        return z.NEVER;
      }
      return parsed;
    })
    .pipe(schema);

/** Each workflow's name by its workflow_id, as controller:identity's `workflows` holds them. */
export const IdentityWorkflowsSchema = z.record(z.string().uuid(), z.string());

/** The controller:identity hash: the workflow group the Global Controller on this Redis runs,
 * and its workflows. */
export const ControllerIdentitySchema = z.object({
  workflow_group_id: z.string().uuid(),
  workflows: json_field(IdentityWorkflowsSchema, 'workflows'),
});

/** One route of the endpoint:address hash; a controller from before workflow ids gives none. */
export const EndpointRouteRecordSchema = z.object({
  workflow: z.string().min(1),
  workflow_id: z.string().nullable().default(null),
  agent: z.string().min(1),
  method: z.string().min(1),
  arguments: z.array(z.string()),
  url: z.string().url(),
});

/** The endpoint:address hash as the Global Controller writes it while the endpoint runs. */
export const EndpointAddressSchema = z.object({
  public_host: z.string().min(1),
  api_port: z.string().regex(/^\d+$/).transform(Number),
  routes: json_field(z.array(EndpointRouteRecordSchema).min(1), 'routes'),
});

export type ControllerIdentity = z.infer<typeof ControllerIdentitySchema>;
export type EndpointAddress = z.infer<typeof EndpointAddressSchema>;
