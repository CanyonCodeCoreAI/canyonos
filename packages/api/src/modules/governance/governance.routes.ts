// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { ProjectIdParams } from '../projects/projects.types';
import { get_governance, save_agent_rules, set_stopped } from './governance.service';
import { AgentRulesSchema, GovernanceResponseSchema, StoppedBodySchema } from './governance.types';

const doc = { tags: ['Governance'], security: [{ bearerAuth: [] }] };

const AgentParams = ProjectIdParams.extend({ agent: z.string().min(1) });

export const governanceRoutes = new Elysia({ name: 'governance.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/governance', ({ params }) => get_governance(params.project_id), {
    params: ProjectIdParams,
    response: { 200: GovernanceResponseSchema },
    detail: { ...doc, summary: 'Get every agent state, rules and spend, and who calls whom' },
  })
  .put(
    '/:project_id/governance/agents/:agent',
    ({ params, body }) => save_agent_rules(params.project_id, params.agent, body),
    {
      params: AgentParams,
      body: AgentRulesSchema,
      response: { 200: GovernanceResponseSchema },
      detail: { ...doc, summary: "Replace one agent's requirements and spend rules" },
    }
  )
  .put(
    '/:project_id/governance/agents/:agent/stopped',
    ({ params, body }) => set_stopped(params.project_id, params.agent, body.stopped),
    {
      params: AgentParams,
      body: StoppedBodySchema,
      response: { 200: GovernanceResponseSchema },
      detail: { ...doc, summary: 'Stop an agent, or start it again with its configured replicas' },
    }
  );
