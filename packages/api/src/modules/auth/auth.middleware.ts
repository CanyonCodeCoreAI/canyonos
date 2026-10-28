// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { unauthorized } from '@core/errors';

import { authRepo } from './auth.repo';
import { jwtManager } from './lib/jwt';
import type { TokenPayload } from './lib/jwt';

/** Resolves the bearer token's caller; with `AUTH_MODE=none` there is no caller and every request passes. */
export async function resolveAuth(request: Request): Promise<TokenPayload | null> {
  if (config.auth.mode === 'none') return null;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('auth.missing_token', 'Authorization header required');
  }
  const payload = await jwtManager.verify(header.slice(7));
  if (!(await authRepo.findUserById(payload.sub))) {
    throw unauthorized('auth.invalid_token', 'Invalid or expired token');
  }
  return payload;
}
