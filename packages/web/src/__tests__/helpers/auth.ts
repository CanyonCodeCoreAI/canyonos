// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { apiBaseUrl } from './workflows';
import type { ApiErrorBody } from './workflows';

export const AUTH_STORAGE_KEY = 'cc-auth-storage';

/**
 * The API key of the workflow groups the API seeds (`SEED_DEV_API_KEY_HASH` in
 * `playwright.config.ts`). Its space, `+`, `&`, `=` and `%` make every sign-in link
 * percent-encode it, as `canyonos dashboard` does.
 */
export const TEST_API_KEY = 'canyonos e2e+key&=%2B';

/** The sha256 of `key` in lowercase hex, as the API stores a workflow group's key. */
export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

/** The persisted store as the dashboard writes it. */
export const storedApiKey = (apiKey: string | null) => ({ state: { apiKey }, version: 0 });

/** Stores `apiKey` once per tab, before the app boots, so a later sign-out or refusal sticks. */
export async function setApiKey(page: Page, apiKey: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('e2e-api-key-set')) return;
      sessionStorage.setItem('e2e-api-key-set', '1');
      localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, JSON.stringify(storedApiKey(apiKey))] as const
  );
}

export const readStoredApiKey = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTH_STORAGE_KEY);

/** Boots the app holding the API key. */
export async function authenticate(page: Page): Promise<void> {
  await setApiKey(page, TEST_API_KEY);
}

/** The message the API refuses `apiKey` with at the key check, which the sign-in screen shows. */
export async function keyRefusal(request: APIRequestContext, apiKey: string): Promise<string> {
  const response = await request.get(`${apiBaseUrl}/v1/auth/check`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(response.status()).toBe(401);
  return ((await response.json()) as ApiErrorBody).message;
}
