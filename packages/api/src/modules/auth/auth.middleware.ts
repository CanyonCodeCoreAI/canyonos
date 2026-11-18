// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto';

import { Elysia } from 'elysia';
import type { Context } from 'elysia';

import { config } from '@core/env';
import { unauthorized } from '@core/errors';

const BEARER = /^bearer\s+(.+)$/i;

const expectedHash = config.auth.apiKeyHash ? Buffer.from(config.auth.apiKeyHash, 'hex') : null;

const hashOf = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

type Guarded = Pick<Context, 'request' | 'set'>;

function refuse(set: Guarded['set'], code: string, message: string) {
  set.headers['www-authenticate'] = 'Bearer';
  return unauthorized(code, message);
}

/**
 * Lets a request through when the API runs with no `CANYONOS_API_KEY_HASH`, or when it sends
 * `Authorization: Bearer <key>` whose sha256 is that hash; 401 otherwise.
 */
export function requireApiKey({ request, set }: Guarded): void {
  if (!expectedHash) return;
  const key = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!key) {
    throw refuse(set, 'auth.missing_key', 'Send the API key as `Authorization: Bearer <key>`');
  }
  if (!timingSafeEqual(hashOf(key), expectedHash)) {
    throw refuse(set, 'auth.invalid_key', 'This API key is not the one this API was started with');
  }
}

/** Every route mounted after `.use(authPlugin)` needs the API key, or answers 401. */
export const authPlugin = new Elysia({ name: 'auth.plugin' }).onBeforeHandle(
  { as: 'scoped' },
  requireApiKey
);
