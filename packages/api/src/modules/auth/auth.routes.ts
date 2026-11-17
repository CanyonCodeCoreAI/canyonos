// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { config } from '@core/env';

import { authPlugin, requireScope } from './auth.middleware';
import { AuthStatusSchema, TokenInfoSchema } from './types';
import type { Auth } from './auth.middleware';
import type { TokenInfo } from './types';

const doc = { tags: ['Auth'], security: [{ bearerAuth: [] }] };

/** With verification off there is no token; the UI gets the answer a write token would. */
const tokenInfo = (auth: Auth | null): TokenInfo =>
  auth
    ? { scope: auth.scope, expires_at: auth.exp ? new Date(auth.exp * 1000).toISOString() : null }
    : { scope: 'write', expires_at: null };

export const authRoutes = new Elysia({ prefix: '/auth', name: 'auth.routes' })
  .get('/status', () => ({ disabled: config.auth.disabled }), {
    response: { 200: AuthStatusSchema },
    detail: { tags: ['Auth'], summary: 'Whether the API verifies tokens; asked before sign-in' },
  })
  .use(authPlugin)
  // Either scope: the dashboard checks the read and the write token it was given through here.
  .get('/token', ({ auth }) => tokenInfo(auth), {
    beforeHandle: requireScope('read', 'write'),
    response: { 200: TokenInfoSchema },
    detail: { ...doc, summary: "The bearer's scope and expiry" },
  });
