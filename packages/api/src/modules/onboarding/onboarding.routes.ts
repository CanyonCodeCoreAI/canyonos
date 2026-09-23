import { Elysia } from 'elysia';

import { resolveAuth } from '../auth/auth.middleware';
import { onboardingService } from './onboarding.service';
import { CompanyNameSchema, CompanySelectionSchema } from './types';

export const onboardingRoutes = new Elysia({ prefix: '/onboarding', name: 'onboarding.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .post('/join', ({ auth, body }) => onboardingService.join(auth.sub, body.company_id), {
    body: CompanySelectionSchema,
  })
  .post('/create', ({ auth, body }) => onboardingService.create(auth.sub, body.company_name), {
    body: CompanyNameSchema,
  });
