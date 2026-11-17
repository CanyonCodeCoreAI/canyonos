// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { importPKCS8, SignJWT } from 'jose';

import type { Scope } from '@api/modules/auth/types';

const signingKey = await importPKCS8(Bun.env.E2E_SIGNING_KEY!, 'EdDSA');

/**
 * A token signed the way `canyonos token create` signs one, by the key `setup.ts` trusts unless
 * `key` says otherwise. `exp` is in seconds since the epoch; `iss: null` leaves the claim out.
 */
export async function signTestToken({
  scope,
  aud = ['canyonos-api'],
  exp,
  iss = 'canyonos',
  key = signingKey,
}: {
  scope: Scope;
  aud?: string[];
  exp?: number;
  iss?: string | null;
  key?: CryptoKey;
}): Promise<string> {
  const jwt = new SignJWT({ scope })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuedAt()
    .setJti(crypto.randomUUID().replaceAll('-', ''))
    .setAudience(aud);
  if (iss !== null) jwt.setIssuer(iss);
  if (exp !== undefined) jwt.setExpirationTime(exp);
  return jwt.sign(key);
}
