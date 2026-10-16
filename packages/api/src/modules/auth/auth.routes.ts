// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { resolveAuth } from './auth.middleware';
import { authService } from './auth.service';
import {
  AuthStatusSchema,
  AuthTokenSchema,
  LoginSchema,
  RegisterSchema,
  UserSchema,
} from './types';

export const authRoutes = new Elysia({ prefix: '/auth', name: 'auth.routes' })
  .get('/status', () => authService.status(), { response: { 200: AuthStatusSchema } })
  .post(
    '/register',
    async ({ body, set }) => {
      const session = await authService.register(body.email, body.password);
      set.status = 201;
      return session;
    },
    { body: RegisterSchema, response: { 201: AuthTokenSchema } }
  )
  .post('/login', ({ body }) => authService.login(body.email, body.password), {
    body: LoginSchema,
    response: { 200: AuthTokenSchema },
  })
  .group('', (app) =>
    app
      .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
      .get('/profile', ({ auth }) => authService.getProfile(auth.sub), {
        response: { 200: UserSchema },
      })
  );
