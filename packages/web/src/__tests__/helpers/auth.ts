// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';

import type { Page } from '@playwright/test';

import type { ApiTokens } from '@/modules/auth/auth.store';

export const AUTH_STORAGE_KEY = 'cc-auth-storage';

/** The key `playwright.config.ts` made for this run and put in the API's trusted folder. */
const trustedKey = (): KeyObject => createPrivateKey(readFileSync(process.env.PRIVATE_KEY_PATH!));

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

interface TokenOptions {
  readonly aud?: readonly string[];
  readonly key?: KeyObject;
}

/**
 * A token signed the way `canyonos token create` signs one, by the trusted key unless `key` says
 * otherwise. `exp` is in seconds since the epoch.
 */
export function tokenFor(
  scope: string,
  exp?: number,
  { aud = ['canyonos-api'], key = trustedKey() }: TokenOptions = {}
): string {
  const header = base64Url({ alg: 'EdDSA', typ: 'JWT' });
  const payload = base64Url({
    iss: 'canyonos',
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID().replaceAll('-', ''),
    aud,
    scope,
    ...(exp === undefined ? {} : { exp }),
  });
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The persisted store as the dashboard writes it. */
export const storedTokens = ({ readToken = null, writeToken = null }: Partial<ApiTokens>) => ({
  state: { readToken, writeToken },
  version: 0,
});

/** Stores `tokens` once per tab, before the app boots, so a later sign-out or refusal sticks. */
export async function setTokens(page: Page, tokens: Partial<ApiTokens>): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('e2e-tokens-set')) return;
      sessionStorage.setItem('e2e-tokens-set', '1');
      localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, JSON.stringify(storedTokens(tokens))] as const
  );
}

export const readStoredTokens = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTH_STORAGE_KEY);

/** Boots the app holding a read and a write token, as a person who may do everything. */
export async function authenticate(
  page: Page
): Promise<{ readonly readToken: string; readonly writeToken: string }> {
  const tokens = { readToken: tokenFor('read'), writeToken: tokenFor('write') };
  await setTokens(page, tokens);
  return tokens;
}
