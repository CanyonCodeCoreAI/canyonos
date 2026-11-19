// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto';

import { Elysia } from 'elysia';
import type { Context } from 'elysia';

import { config } from '@core/env';
import { early_refusal, unauthorized } from '@core/errors';

/** The paths that need the dashboard's API key: each, and everything under it. */
export const API_KEY_PATHS = ['/workflows', '/resources', '/auth/check'] as const;

const BEARER = /^bearer\s+(.+)$/i;

const expectedHash = config.auth.apiKeyHash ? Buffer.from(config.auth.apiKeyHash, 'hex') : null;

const hashOf = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

type Guarded = Pick<Context, 'request' | 'set'>;

/** Whether `request` is for one of API_KEY_PATHS or under one; `/workflows-x` is not. */
export function needs_api_key(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return API_KEY_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function refuse(set: Guarded['set'], code: string, message: string) {
  set.headers['www-authenticate'] = 'Bearer';
  return early_refusal(set, unauthorized(code, message));
}

/**
 * Lets a request through when it is not under API_KEY_PATHS, when the API runs with no
 * `CANYONOS_API_KEY_HASH`, or when it sends `Authorization: Bearer <key>` whose sha256 is that
 * hash; 401 otherwise. Runs as the request arrives, before its body, params or query are read
 * or checked, so a request without the key learns nothing about what it sent.
 */
export function requireApiKey({ request, set }: Guarded) {
  if (!expectedHash || !needs_api_key(request)) return;
  const key = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!key) {
    return refuse(set, 'auth.missing_key', 'Send the API key as `Authorization: Bearer <key>`');
  }
  if (!timingSafeEqual(hashOf(key), expectedHash)) {
    return refuse(set, 'auth.invalid_key', 'This API key is not the one this API was started with');
  }
}

/** Checks the API key of every request under API_KEY_PATHS. Mount it after the CORS plugin, so
 * a preflight is answered without a key and a 401 carries the CORS headers a browser needs to
 * read it. */
export const apiKeyGuard = new Elysia({ name: 'auth.api-key' }).onRequest(requireApiKey);
