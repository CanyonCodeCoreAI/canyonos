import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { get_prompts, save_prompt } from './prompts.service';
import { PromptEditSchema, PromptItemSchema, PromptsResponseSchema } from './prompts.types';

const doc = { tags: ['Prompts'], security: [{ bearerAuth: [] }] };
const ProjectParams = z.object({ project_id: z.string().uuid() });
const ProjectPromptParams = ProjectParams.extend({ name: z.string().min(1) });

export const promptsRoutes = new Elysia({ name: 'prompts.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/prompts', ({ params }) => get_prompts(params.project_id), {
    params: ProjectParams,
    response: { 200: PromptsResponseSchema },
    detail: { ...doc, summary: 'Get prompts from the running project config' },
  })
  .put(
    '/:project_id/prompts/:name',
    ({ params, body }) => save_prompt(params.project_id, params.name, body),
    {
      params: ProjectPromptParams,
      body: PromptEditSchema,
      response: { 200: PromptItemSchema },
      detail: { ...doc, summary: 'Save a new version of one prompt' },
    }
  );
