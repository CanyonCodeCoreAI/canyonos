// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';

import { resolve_group_workflow_access } from '../workflows/workflows.access';
import { GroupWorkflowParams } from '../workflows/workflows.types';
import { get_governance, save_agent_rules, set_stopped } from './governance.service';
import { AgentRulesSchema, GovernanceResponseSchema, StoppedBodySchema } from './governance.types';

const doc = { tags: ['Governance'], security: [{ bearerAuth: [] }] };

const AgentParams = GroupWorkflowParams.extend({ agent_id: z.string().uuid() });

export const governanceRoutes = new Elysia({ name: 'governance.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .get(
    '/:workflow_group_id/workflows/:workflow_id/governance',
    ({ params }) => get_governance(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: GovernanceResponseSchema },
      detail: { ...doc, summary: 'Get every agent state, rules and spend, and who calls whom' },
    }
  )
  .put(
    '/:workflow_group_id/workflows/:workflow_id/governance/agents/:agent_id',
    ({ params, body }) => save_agent_rules(params.workflow_id, params.agent_id, body),
    {
      params: AgentParams,
      body: AgentRulesSchema,
      response: { 200: GovernanceResponseSchema },
      detail: { ...doc, summary: "Replace one agent's requirements, spend rules and review gate" },
    }
  )
  .put(
    '/:workflow_group_id/workflows/:workflow_id/governance/agents/:agent_id/stopped',
    ({ params, body }) => set_stopped(params.workflow_id, params.agent_id, body.stopped),
    {
      params: AgentParams,
      body: StoppedBodySchema,
      response: { 200: GovernanceResponseSchema },
      detail: { ...doc, summary: 'Stop an agent, or start it again with its configured replicas' },
    }
  );
