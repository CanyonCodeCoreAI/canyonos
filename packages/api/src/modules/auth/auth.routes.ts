// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { config } from '@core/env';

import { authPlugin } from './auth.middleware';
import { AuthCheckSchema, AuthStatusSchema } from './types';

export const authRoutes = new Elysia({ prefix: '/auth', name: 'auth.routes' })
  .get('/status', () => ({ api_key_required: config.auth.apiKeyHash !== null }), {
    response: { 200: AuthStatusSchema },
    detail: { tags: ['Auth'], summary: 'Whether the API needs a key; asked before sign-in' },
  })
  .use(authPlugin)
  .get('/check', () => ({ ok: true as const }), {
    response: { 200: AuthCheckSchema },
    detail: {
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      summary: 'Answers 200 when the request carries the API key; what sign-in checks a key with',
    },
  });
