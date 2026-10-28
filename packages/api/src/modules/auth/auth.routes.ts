// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { config } from '@core/env';
import { notFound } from '@core/errors';

import { resolveAuth } from './auth.middleware';
import { authService } from './auth.service';
import {
  AuthStatusSchema,
  AuthTokenSchema,
  LoginSchema,
  RegisterSchema,
  UserSchema,
} from './types';

const signInDisabled = () =>
  notFound('auth.disabled', 'Sign-in is disabled; set AUTH_MODE=password to enable accounts');

export const authRoutes = new Elysia({ prefix: '/auth', name: 'auth.routes' })
  .get('/status', () => authService.status(), { response: { 200: AuthStatusSchema } })
  .onBeforeHandle(() => {
    if (config.auth.mode === 'none') throw signInDisabled();
  })
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
  .resolve(async ({ request }) => {
    const auth = await resolveAuth(request);
    if (!auth) throw signInDisabled();
    return { auth };
  })
  .get('/profile', ({ auth }) => authService.getProfile(auth.sub), {
    response: { 200: UserSchema },
  });
