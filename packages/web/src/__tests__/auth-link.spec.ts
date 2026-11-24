// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { keyRefusal, readStoredApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import {
  expectPath,
  stubFleetSpend,
  stubWorkflowDashboard,
  stubWorkflowsList,
  WORKFLOW,
} from './helpers/session';

/** The link `canyonos dashboard` opens: the key rides percent-encoded in the fragment. */
const signInLink = (apiKey: string, path = '/login') => `${path}#key=${encodeURIComponent(apiKey)}`;

/** What a server received of each URL the page requested: all but the fragment. */
function requestedUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    url.hash = '';
    urls.push(url.href);
  });
  return urls;
}

test('@smoke a dashboard link signs in with its key, stores it and strips it from the address', async ({
  page,
}) => {
  const urls = requestedUrls(page);

  await page.goto(signInLink(TEST_API_KEY));

  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  expect(new URL(page.url()).hash).toBe('');
  expect(urls.filter((url) => url.includes(encodeURIComponent(TEST_API_KEY)))).toEqual([]);
});

test('a dashboard link goes on to where the visitor was going', async ({ page }) => {
  const workflow = `/workflows/${WORKFLOW.id}`;
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);

  await page.goto(signInLink(TEST_API_KEY, `/login?redirect=${workflow}`));

  await expectPath(page, workflow);
  await expect(page.getByTestId('workflow-screen')).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
});

test('a dashboard link whose key the API refuses stays on sign-in, says why and keeps nothing', async ({
  page,
  request,
}) => {
  const wrongKey = 'not-the-api-key';
  const refusal = await keyRefusal(request, wrongKey);

  await page.goto(signInLink(wrongKey));

  await expectPath(page, '/login');
  await expect(page.getByTestId('auth-error')).toHaveText(refusal);
  await expect(page.getByTestId('auth-api-key')).toHaveAttribute(
    'aria-describedby',
    /\bauth-error\b/
  );
  expect(new URL(page.url()).hash).toBe('');
  expect(await readStoredApiKey(page)).toBeNull();
});
