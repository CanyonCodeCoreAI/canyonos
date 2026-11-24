// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { api_key_required, opened_by_key } from './auth.plugin';
import { AuthCheckSchema, AuthStatusSchema } from './auth.types';

// `/v1/auth/check` takes a workflow group's key, checked in `derive` before anything else of the
// request; `/v1/auth/status` takes none and reads no database when it is down.
const checkRoute = new Elysia({ name: 'auth.check.routes' })
  .derive(async ({ request }) => ({ opened: await opened_by_key(request) }))
  .get('/check', () => ({ ok: true as const }), {
    response: { 200: AuthCheckSchema },
    detail: {
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      summary: 'Answers 200 when the key opens a workflow group; what sign-in checks a key with',
      description:
        'Also 200 with no key while no workflow group has one; 401 `auth.missing_key` or ' +
        '`auth.invalid_key` otherwise.',
    },
  });

export const authRoutes = new Elysia({ prefix: '/v1/auth', name: 'auth.routes' })
  .get('/status', async () => ({ api_key_required: await api_key_required() }), {
    response: { 200: AuthStatusSchema },
    detail: {
      tags: ['Auth'],
      summary: 'Whether any workflow group needs a key; asked before sign-in',
      description: 'True too while the database is not ready to say.',
    },
  })
  .use(checkRoute);
