// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { readStoredApiKey, setApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import { expectPath } from './helpers/session';
import { apiBaseUrl, openApiBaseUrl, SEEDED_WORKFLOW_NAME } from './helpers/workflows';

const apiOrigin = new URL(apiBaseUrl).origin;

/** The dashboard is built against the API whose groups have a key; send its calls to the open one. */
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.origin === apiOrigin,
    (route) => {
      const url = new URL(route.request().url());
      return route.continue({ url: `${openApiBaseUrl}${url.pathname}${url.search}` });
    }
  );
});

test('home opens the workflows overview with no sign-in screen', async ({ page }) => {
  await page.goto('/');

  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toContainText(SEEDED_WORKFLOW_NAME);
});

test('the sign-in screen and the old sign-up page send visitors to the workflows overview', async ({
  page,
}) => {
  await page.goto('/login');
  await expectPath(page, '/workflows');

  await page.goto('/register');
  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
});

test('a key stored by an earlier visit is dropped and no request carries it', async ({ page }) => {
  const authorizations: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers()['authorization'];
    if (authorization) authorizations.push(`${request.method()} ${request.url()}`);
  });
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/workflows');

  await expect(page.getByTestId('workflows-overview')).toContainText(SEEDED_WORKFLOW_NAME);
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.getByTestId('sidebar-user-menu')).toHaveCount(0);
  await expect.poll(() => readStoredApiKey(page)).toEqual(storedApiKey(null));
  expect(authorizations).toEqual([]);
});
