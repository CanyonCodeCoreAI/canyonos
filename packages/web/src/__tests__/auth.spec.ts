// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { AuthStatus } from '@canyonos/api/auth';

import { setToken, signIn, TEST_EMAIL, TEST_PASSWORD, validToken } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@canyonos.test`;

/** The dev database always holds the seeded user, so the "no users yet" branch is only reachable stubbed. */
async function stubEmptyInstall(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/auth/status',
    (route) => fulfillJson(route, { mode: 'password', has_users: false } satisfies AuthStatus)
  );
}

async function fillSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(password);
}

test('an empty install sends a deep link to the first-account form and back', async ({ page }) => {
  const session = await signIn(page.request);
  await stubEmptyInstall(page);
  const registerBodies: unknown[] = [];
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/auth/register',
    (route) => {
      registerBodies.push(route.request().postDataJSON());
      return fulfillJson(route, session, 201);
    }
  );
  const email = uniqueEmail('first');

  await page.goto('/projects');

  await expectPath(page, '/register');
  await expect(page.getByRole('heading', { name: 'Create the first account' })).toBeVisible();
  await fillSignIn(page, email, TEST_PASSWORD);
  await page.getByTestId('auth-password-confirmation').fill(TEST_PASSWORD);
  await page.getByTestId('auth-password-confirmation').press('Enter');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  expect(registerBodies).toEqual([
    { email, password: TEST_PASSWORD, password_confirmation: TEST_PASSWORD },
  ]);
});

test('@smoke an install with users shows login only, and the seeded user signs in and out', async ({
  page,
}) => {
  await page.goto('/projects');
  await expectPath(page, '/login');
  await expect(page.getByTestId('auth-submit')).toBeVisible();
  await expect(page.getByRole('link', { name: /create|register|account/i })).toHaveCount(0);

  await page.goto('/register');
  await expectPath(page, '/login');

  await fillSignIn(page, TEST_EMAIL, TEST_PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expectPath(page, '/projects');

  await page.getByTestId('sidebar-user-menu').click();
  await expect(page.getByTestId('sidebar-user-menu-content')).toContainText(TEST_EMAIL);
  await page.getByTestId('sidebar-logout').click();
  await expectPath(page, '/login');
});

test('a wrong password shows one error and stays on the form', async ({ page }) => {
  await page.goto('/login');
  await fillSignIn(page, TEST_EMAIL, 'not-the-password');
  await page.getByTestId('auth-submit').click();

  const error = page.getByTestId('auth-error');
  await expect(error).toHaveText('Invalid email or password');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('auth-password')).toHaveAttribute('aria-describedby', 'auth-error');
  await expect(page.getByTestId('auth-submit')).toBeEnabled();
  await expectPath(page, '/login');
});

test('a mismatched confirmation never reaches the API', async ({ page }) => {
  await stubEmptyInstall(page);
  let registerRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/auth/register') {
      registerRequests += 1;
    }
  });

  await page.goto('/register');
  await fillSignIn(page, uniqueEmail('mismatch'), TEST_PASSWORD);
  await page.getByTestId('auth-password-confirmation').fill('something-else-1');
  await page.getByTestId('auth-submit').click();

  await expect(page.getByTestId('auth-password-confirmation-error')).toHaveText(
    'Passwords do not match'
  );
  await expect(page.getByTestId('auth-password-confirmation')).toHaveAttribute(
    'aria-invalid',
    'true'
  );
  expect(registerRequests).toBe(0);
});

test('a deep link survives login', async ({ page }) => {
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);

  await page.goto(`/projects/${PROJECT.id}`);
  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toMatch(
    new RegExp(`^/projects/${PROJECT.id}`)
  );

  await fillSignIn(page, TEST_EMAIL, TEST_PASSWORD);
  await page.getByTestId('auth-submit').click();

  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('project-screen')).toBeVisible();
});

test('a redirect to another origin is dropped after login', async ({ page }) => {
  await page.goto('/login?redirect=https://example.com/steal');
  await fillSignIn(page, TEST_EMAIL, TEST_PASSWORD);
  await page.getByTestId('auth-submit').click();

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('a forged token is sent back to login', async ({ page }) => {
  await page.addInitScript(setToken, validToken);

  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(page.getByTestId('auth-email')).toBeVisible();
});
