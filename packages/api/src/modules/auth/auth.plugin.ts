// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto';

import { Elysia } from 'elysia';
import type { BunRequest } from 'bun';
import type { Context } from 'elysia';

import { config } from '@core/env';
import { early_refusal, unauthorized } from '@core/errors';

/** The paths that need the dashboard's API key: each, and everything under it. */
export const API_KEY_PATHS = ['/v1/workflows', '/v1/resources', '/v1/auth/check'] as const;

// What the dashboard reads and sets of one workflow, under its workflow group: these need the
// API key on Kubernetes too, where the other /v1/workflow-groups routes take the caller's
// Kubernetes login.
export const DASHBOARD_PATH =
  /^\/v1\/workflow-groups\/[^/]+\/workflows\/[^/]+\/(requests|metrics|monitoring|prompts|scaling|governance|history|sample-data)(\/|$)/;

// Where a Global Controller sends its workflow group's telemetry, which takes no key.
export const TELEMETRY_PATH = /^\/v1\/workflow-groups\/[^/]+\/(traces|metrics|logs)$/;

/** Whether the router answers `request` on a path `pattern` matches. */
export function is_routed_to(request: Request, pattern: RegExp): boolean {
  const { params } = request as Partial<BunRequest>;
  return (
    pattern.test(new URL(request.url).pathname) &&
    // request.url takes `\` for `/` and the router does not: such a path reached another route.
    !Object.values(params ?? {}).some((value) => value.includes('\\'))
  );
}

const BEARER = /^bearer\s+(.+)$/i;

const expectedHash = config.auth.apiKeyHash ? Buffer.from(config.auth.apiKeyHash, 'hex') : null;

const hashOf = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

type Guarded = Pick<Context, 'request' | 'set'>;

/** Whether `request` is for one of API_KEY_PATHS or under one (`/v1/resources-x` is not), or for
 * one of the dashboard's routes under a workflow group. */
export function needs_api_key(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    is_routed_to(request, DASHBOARD_PATH) ||
    API_KEY_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
  );
}

function refuse(set: Guarded['set'], code: string, message: string) {
  set.headers['www-authenticate'] = 'Bearer';
  return early_refusal(set, unauthorized(code, message));
}

/**
 * Lets `request` through when the API runs with no `CANYONOS_API_KEY_HASH`, or when it sends
 * `Authorization: Bearer <key>` whose sha256 is that hash; 401 otherwise.
 */
export function check_api_key({ request, set }: Guarded) {
  if (!expectedHash) return;
  const key = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!key) {
    return refuse(set, 'auth.missing_key', 'Send the API key as `Authorization: Bearer <key>`');
  }
  if (!timingSafeEqual(hashOf(key), expectedHash)) {
    return refuse(
      set,
      'auth.invalid_key',
      'This API key is not the one this API was started with. Use that key, or start it with yours: `canyonos serve --api-key <key>`'
    );
  }
}

/**
 * Lets a request through when it does not need the API key, else checks it (`check_api_key`).
 * Runs as the request arrives, before its body, params or query are read or checked, so a
 * request without the key learns nothing about what it sent.
 */
export function requireApiKey(guarded: Guarded) {
  if (!needs_api_key(guarded.request)) return;
  return check_api_key(guarded);
}

/** Checks the API key of every request that needs it. Mount it after the CORS plugin, so
 * a preflight is answered without a key and a 401 carries the CORS headers a browser needs to
 * read it. */
export const apiKeyGuard = new Elysia({ name: 'auth.api-key' }).onRequest(requireApiKey);
