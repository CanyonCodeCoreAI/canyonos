import { Elysia } from 'elysia';

import { resolveAuth } from './auth.middleware';
import { authService } from './auth.service';
import { ChallengeRequestSchema, ChallengeVerifySchema } from './types';

export const authRoutes = new Elysia({ prefix: '/auth', name: 'auth.routes' })
  .post('/challenge', ({ body }) => authService.requestChallenge(body.email), {
    body: ChallengeRequestSchema,
  })
  .post('/verify', ({ body }) => authService.verifyChallenge(body.email, body.code), {
    body: ChallengeVerifySchema,
  })
  .group('', (app) =>
    app
      .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
      .get('/profile', ({ auth }) => authService.getProfile(auth.sub))
  );
