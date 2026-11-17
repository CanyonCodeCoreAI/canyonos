// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { decodeJwt, errors, jwtVerify } from 'jose';

import { config } from '@core/env';
import { forbidden, unauthorized } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { loadTrustedKeys } from './lib/keys';
import { API_AUDIENCE, CLOCK_TOLERANCE_SECONDS, SCOPES, TOKEN_ISSUER } from './types';
import type { ApiScope, Scope } from './types';

export interface Auth {
  scope: Scope;
  exp: number | null;
}

const trustedKeys = config.auth.trustedKeysDir
  ? await loadTrustedKeys(config.auth.trustedKeysDir)
  : [];

if (config.auth.trustedKeysDir && trustedKeys.length === 0) {
  logger
    .child({ domain: LOG_DOMAINS.AUTH })
    .error(
      `AUTH_TRUSTED_KEYS_DIR ${config.auth.trustedKeysDir} holds no public key: every token is ` +
        'refused until one is added (`canyonos keys create`) and the API restarts'
    );
}

const invalidToken = (message: string) => unauthorized('auth.invalid_token', message);

/** The `aud` of a token whose signature was verified, when it is a list of strings. */
function audienceOf(token: string): string[] {
  const { aud } = decodeJwt(token);
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud) && aud.every((entry) => typeof entry === 'string')) return aud;
  return [];
}

function refusalOf(token: string, error: unknown) {
  if (error instanceof errors.JWTExpired) return invalidToken('This token expired');
  if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'aud') {
    return audienceOf(token).length > 0
      ? invalidToken('This token is for a workflow, not for the dashboard API')
      : invalidToken('This token is not for the dashboard API: its aud is not ["canyonos-api"]');
  }
  const reason = error instanceof Error ? error.message : String(error);
  return invalidToken(`This token is not valid: ${reason}`);
}

/** The scope and expiry of `token` once a trusted key signed it for this API; 401 otherwise. */
export async function verifyApiToken(token: string): Promise<Auth> {
  for (const key of trustedKeys) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: ['EdDSA'],
        issuer: TOKEN_ISSUER,
        audience: API_AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      if (error instanceof errors.JWSSignatureVerificationFailed) continue;
      throw refusalOf(token, error);
    }
    const { scope, exp } = payload;
    if (typeof scope !== 'string' || !(SCOPES as readonly string[]).includes(scope)) {
      throw invalidToken(`This token's scope is not one of ${SCOPES.join(', ')}`);
    }
    return { scope: scope as Scope, exp: exp ?? null };
  }
  throw invalidToken('This token is not signed by a key this API trusts');
}

const BEARER = /^bearer\s+(.+)$/i;

/** The bearer's scope and expiry; null only with `AUTH_DISABLED=true`, where everything passes. */
export async function resolveAuth(request: Request): Promise<Auth | null> {
  if (config.auth.disabled) return null;
  const token = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!token) {
    throw unauthorized(
      'auth.missing_token',
      'Send an API token as `Authorization: Bearer <token>`'
    );
  }
  return verifyApiToken(token);
}

const SCOPE_REFUSALS: Record<ApiScope, string> = {
  read: 'A write token reads only what it can change; send a read token for this',
  write: 'This token may read but not change anything',
};

function refuseScope(granted: Scope, accepted: readonly ApiScope[]) {
  const message =
    granted === 'query'
      ? 'This token is for a workflow query, not for the dashboard API'
      : SCOPE_REFUSALS[accepted[0]!];
  return forbidden('auth.insufficient_scope', message);
}

/**
 * The `beforeHandle` a route under `authPlugin` states the scopes it accepts with, beside its
 * handler: `requireScope('write')` on a write, `requireScope('read')` on a GET, and
 * `requireScope('read', 'write')` on a GET of something a write token can change (what you can
 * change, you can also read). A verified token of another scope is 403, and a route that reaches
 * it with no verified token (one not under `authPlugin`) is 401 unless `AUTH_DISABLED=true`. The
 * hook carries `scopes`, so a test can read from the route table what every route accepts.
 */
export function requireScope(...accepted: ApiScope[]) {
  const check = ({ auth }: { auth?: Auth | null }) => {
    if (config.auth.disabled) return;
    if (!auth) throw unauthorized('auth.missing_token', 'This route needs a verified API token');
    if (!(accepted as readonly Scope[]).includes(auth.scope)) {
      throw refuseScope(auth.scope, accepted);
    }
  };
  return Object.assign(check, { scopes: accepted });
}

/** Every route mounted after `.use(authPlugin)` needs a verified bearer, or answers 401. */
export const authPlugin = new Elysia({ name: 'auth.plugin' }).resolve(
  { as: 'scoped' },
  async ({ request }) => ({ auth: await resolveAuth(request) })
);
