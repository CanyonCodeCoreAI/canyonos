// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { setToken, validToken } from './helpers/auth';
import { apiBaseUrl, noAuthApiBaseUrl } from './helpers/projects';
import { expectPath } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const SEEDED_PROJECT_NAME = 'Canyon Code Demo Flow';

/** The dashboard is built against the password-mode API; send its calls to the sign-in-off one. */
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.origin === apiOrigin,
    (route) => {
      const url = new URL(route.request().url());
      return route.continue({ url: `${noAuthApiBaseUrl}${url.pathname}${url.search}` });
    }
  );
});

test('home opens the projects overview with no sign-in', async ({ page }) => {
  await page.goto('/');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toContainText(SEEDED_PROJECT_NAME);
});

test('the sign-in screens send visitors to the projects overview', async ({ page }) => {
  await page.goto('/login');
  await expectPath(page, '/projects');

  await page.goto('/register');
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('a session stored by an earlier password-mode visit shows no user', async ({ page }) => {
  await page.addInitScript(setToken, validToken);

  await page.goto('/projects');

  await expect(page.getByTestId('projects-overview')).toContainText(SEEDED_PROJECT_NAME);
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.getByTestId('sidebar-user-menu')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^Good (morning|afternoon|evening)$/
  );
});
