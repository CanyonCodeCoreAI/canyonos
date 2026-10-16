// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRequestContext, Page } from '@playwright/test';

import type { AuthToken } from '@canyonos/api/auth';

const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';

/** The account the API's dev seed creates when it starts with `SEED_DEV_DATA=true`. */
export const TEST_EMAIL = 'e2e@canyonos.test';
export const TEST_PASSWORD = 'e2e-password-1';

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

const makeToken = (expSeconds: number) =>
  `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url({ exp: expSeconds })}.signature`;

const nowSeconds = Math.floor(Date.now() / 1000);

/** Unexpired but unsigned: the client-side guard accepts it, the API's profile check does not. */
export const validToken = makeToken(nowSeconds + 3600);

export const setToken = (token: string) =>
  localStorage.setItem(
    'cc-auth-storage',
    JSON.stringify({ state: { user: { id: '1', email: 'test@canyonos.test' }, token }, version: 0 })
  );

const persistAuth = (session: AuthToken) =>
  localStorage.setItem('cc-auth-storage', JSON.stringify({ state: session, version: 0 }));

export async function signIn(request: APIRequestContext): Promise<AuthToken> {
  const response = await request.post(`${apiBaseUrl}/auth/login`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(`Test sign-in failed (${response.status()}): ${await response.text()}`);
  }
  return (await response.json()) as AuthToken;
}

/** Sign the seeded user in through the real API and boot the app with that session stored. */
export async function authenticate(page: Page): Promise<AuthToken> {
  const session = await signIn(page.request);
  await page.addInitScript(persistAuth, session);
  return session;
}
