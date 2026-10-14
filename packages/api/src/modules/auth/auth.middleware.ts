// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { unauthorized } from '@core/errors';

import { jwtManager } from './lib/jwt';
import type { TokenPayload } from './lib/jwt';

export async function resolveAuth(request: Request): Promise<TokenPayload> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('auth.missing_token', 'Authorization header required');
  }
  return jwtManager.verify(header.slice(7));
}
