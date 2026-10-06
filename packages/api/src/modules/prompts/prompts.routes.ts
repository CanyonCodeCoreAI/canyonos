import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { create_system_prompt, get_prompt, list_prompts, set_live } from './prompts.service';
import {
  PromptListItemSchema,
  PromptLiveSchema,
  PromptSchema,
  SystemPromptCreateSchema,
  SystemPromptSchema,
} from './prompts.types';

const doc = { tags: ['Prompts'], security: [{ bearerAuth: [] }] };
const ProjectParams = z.object({ project_id: z.string().uuid() });
const PromptParams = ProjectParams.extend({ name: z.string().min(1) });

export const promptsRoutes = new Elysia({ name: 'prompts.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/prompts', ({ params }) => list_prompts(params.project_id), {
    params: ProjectParams,
    response: { 200: z.array(PromptListItemSchema) },
    detail: {
      ...doc,
      summary: 'List the running project prompts with the system prompt agents get',
    },
  })
  .get('/:project_id/prompts/:name', ({ params }) => get_prompt(params.project_id, params.name), {
    params: PromptParams,
    response: { 200: PromptSchema },
    detail: { ...doc, summary: 'Get one prompt with every stored system prompt' },
  })
  .post(
    '/:project_id/prompts/:name/versions',
    async ({ params, body, set }) => {
      const created = await create_system_prompt(params.project_id, params.name, body);
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
    '/:project_id/prompts/:name/live',
    ({ params, body }) => set_live(params.project_id, params.name, body),
    {
      params: PromptParams,
      body: PromptLiveSchema,
      response: { 200: PromptListItemSchema },
      detail: { ...doc, summary: 'Make one stored system prompt the live one' },
    }
  );
