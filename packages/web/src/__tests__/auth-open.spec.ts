// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import type { AuthStatus } from '@canyonos/api/auth';

import { readStoredApiKey, setApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import { apiBaseUrl, fulfillJson, noAuthApiBaseUrl } from './helpers/projects';
import { expectPath } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const SEEDED_PROJECT_NAME = 'Canyon Code Demo Flow';

/** The dashboard is built against the API that needs a key; send its calls to the keyless one. */
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.origin === apiOrigin,
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/auth/status') {
        return fulfillJson(route, { api_key_required: false } satisfies AuthStatus);
      }
      return route.continue({ url: `${noAuthApiBaseUrl}${url.pathname}${url.search}` });
    }
  );
});

test('home opens the projects overview with no sign-in screen', async ({ page }) => {
  await page.goto('/');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toContainText(SEEDED_PROJECT_NAME);
});

test('the sign-in screen and the old sign-up page send visitors to the projects overview', async ({
  page,
}) => {
  await page.goto('/login');
  await expectPath(page, '/projects');

  await page.goto('/register');
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('a key stored by an earlier visit is dropped and no request carries it', async ({ page }) => {
  const authorizations: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers()['authorization'];
    if (authorization) authorizations.push(`${request.method()} ${request.url()}`);
  });
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/projects');

  await expect(page.getByTestId('projects-overview')).toContainText(SEEDED_PROJECT_NAME);
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.getByTestId('sidebar-user-menu')).toHaveCount(0);
  await expect.poll(() => readStoredApiKey(page)).toEqual(storedApiKey(null));
  expect(authorizations).toEqual([]);
});
