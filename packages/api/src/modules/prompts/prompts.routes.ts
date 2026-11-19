// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { authPlugin } from '../auth/auth.middleware';
import { resolveWorkflowAccess } from '../auth/workflow-access';
import { create_system_prompt, get_prompt, list_prompts, set_live } from './prompts.service';
import {
  PromptListItemSchema,
  PromptLiveSchema,
  PromptSchema,
  SystemPromptCreateSchema,
  SystemPromptSchema,
} from './prompts.types';

const doc = { tags: ['Prompts'], security: [{ bearerAuth: [] }] };
const WorkflowParams = z.object({ workflow_id: z.string().uuid() });
const PromptParams = WorkflowParams.extend({ name: z.string().min(1) });

export const promptsRoutes = new Elysia({ name: 'prompts.routes' })
  .use(authPlugin)
  .resolve(resolveWorkflowAccess)
  .get('/:workflow_id/prompts', ({ params }) => list_prompts(params.workflow_id), {
    params: WorkflowParams,
    response: { 200: z.array(PromptListItemSchema) },
    detail: {
      ...doc,
      summary: 'List the prompts of the running workflow with the system prompt agents get',
    },
  })
  .get('/:workflow_id/prompts/:name', ({ params }) => get_prompt(params.workflow_id, params.name), {
    params: PromptParams,
    response: { 200: PromptSchema },
    detail: { ...doc, summary: 'Get one prompt with every stored system prompt' },
  })
  .post(
    '/:workflow_id/prompts/:name/versions',
    async ({ params, body, set }) => {
      const created = await create_system_prompt(params.workflow_id, params.name, body);
      set.status = 201;
      return created;
    },
    {
      params: PromptParams,
      body: SystemPromptCreateSchema,
      response: { 201: SystemPromptSchema },
      detail: { ...doc, summary: 'Store a new system prompt for a prompt without making it live' },
    }
  )
  .put(
    '/:workflow_id/prompts/:name/live',
    ({ params, body }) => set_live(params.workflow_id, params.name, body),
    {
      params: PromptParams,
      body: PromptLiveSchema,
      response: { 200: PromptListItemSchema },
      detail: { ...doc, summary: 'Make one stored system prompt the live one' },
    }
  );
