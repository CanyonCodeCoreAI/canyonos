// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto';

import { Elysia } from 'elysia';
import type { Context } from 'elysia';

import { config } from '@core/env';
import { early_refusal, unauthorized } from '@core/errors';

// /v1 drives the Global Controller containers through the Docker socket, so it always needs the
// control key the CLI made, never the dashboard's API key, and serves no browser: no CORS.

export const CONTROL_PATH_PREFIX = '/v1/workflow-groups';

const BEARER = /^bearer\s+(.+)$/i;

const expected_hash = config.auth.controlKeyHash
  ? Buffer.from(config.auth.controlKeyHash, 'hex')
  : null;

const hash_of = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

type Guarded = Pick<Context, 'request' | 'set'>;

export function is_control_path(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === CONTROL_PATH_PREFIX || pathname.startsWith(`${CONTROL_PATH_PREFIX}/`);
}

/** Drops what the CORS plugin added: a browser on another origin may not read /v1 answers. */
function drop_cors_headers(set: Guarded['set']): void {
  for (const name of Object.keys(set.headers)) {
    if (name.startsWith('access-control-') || name === 'vary') delete set.headers[name];
  }
}

function refuse(set: Guarded['set'], code: string, message: string) {
  set.headers['www-authenticate'] = 'Bearer';
  return early_refusal(set, unauthorized(code, message));
}

/**
 * Lets a /v1 request through only when it sends `Authorization: Bearer <key>` whose sha256 is
 * `CANYONOS_CONTROL_KEY_HASH`, and refuses every one when that is unset; 401 otherwise. Runs as
 * the request arrives, before its body is read or checked.
 */
export function requireControlKey({ request, set }: Guarded) {
  if (!is_control_path(request)) return;
  drop_cors_headers(set);
  if (!expected_hash) {
    return refuse(
      set,
      'auth.control_key_unset',
      'This API was started without CANYONOS_CONTROL_KEY_HASH, so it takes no /v1 request'
    );
  }
  const key = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!key) {
    return refuse(
      set,
      'auth.missing_key',
      'Send the control key in ~/.canyonos/control_key as `Authorization: Bearer <key>`'
    );
  }
  if (!timingSafeEqual(hash_of(key), expected_hash)) {
    return refuse(
      set,
      'auth.invalid_key',
      'This control key is not the one this API was started with'
    );
  }
}

/** Checks the control key of every /v1 request; mount it before the CORS plugin, so a /v1
 * preflight gets no CORS answer. */
export const controlKeyGuard = new Elysia({ name: 'auth.control-key' }).onRequest(
  requireControlKey
);

/** Takes back the CORS headers the CORS plugin gave a /v1 request; mount it after that plugin. */
export const noCorsOnControlPaths = new Elysia({ name: 'auth.control-key.no-cors' }).onRequest(
  ({ request, set }) => {
    if (is_control_path(request)) drop_cors_headers(set);
  }
);
