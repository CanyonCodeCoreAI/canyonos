// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

import type { ScalingResponse } from '@canyonos/api/scaling';

import { readStoredApiKey, setApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const WRONG_KEY = 'not-the-api-key';
const INVALID_KEY = 'This API key is not the one this API was started with';
const SCALING = `/projects/${PROJECT.id}/scaling`;
const NO_POLICY = { projects: { app: { status: 'none' } } } satisfies ScalingResponse;

const keyField = (page: Page) => page.getByTestId('auth-api-key');
const submit = (page: Page) => page.getByTestId('auth-submit');
const formError = (page: Page) => page.getByTestId('auth-error');

const isApiCall = (request: Request) => new URL(request.url()).origin === apiOrigin;
const isKeyCheck = (request: Request) =>
  isApiCall(request) && new URL(request.url()).pathname === '/auth/check';

function countKeyChecks(page: Page): () => number {
  let checks = 0;
  page.on('request', (request) => {
    if (isKeyCheck(request)) checks += 1;
  });
  return () => checks;
}

async function stubProject(page: Page): Promise<void> {
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
}

test('@smoke a signed-out visit asks for one API key, and nothing about an account', async ({
  page,
}) => {
  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(page.getByLabel('API key')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.getByLabel(/token|email/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /create|register|account/i })).toHaveCount(0);
  await expect(submit(page)).toBeDisabled();
});

test('@smoke the API key sent with Enter signs in, is stored, and survives a reload', async ({
  page,
}) => {
  await page.goto('/login');

  await keyField(page).fill(TEST_API_KEY);
  await keyField(page).press('Enter');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  await page.reload();
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await page.getByTestId('sidebar-user-menu').click();
  await expect(page.getByTestId('sidebar-signed-in')).toHaveText('Signed in with the API key');
});

test('a wrong key shows the refusal against the field and keeps nothing', async ({ page }) => {
  await page.goto('/login');

  await keyField(page).fill(WRONG_KEY);
  await submit(page).click();

  await expect(formError(page)).toHaveText(INVALID_KEY);
  await expect(formError(page)).toHaveAttribute('role', 'alert');
  await expect(keyField(page)).toHaveAttribute('aria-describedby', /\bauth-error\b/);
  await expect(keyField(page)).toBeFocused();
  await expect(submit(page)).toBeEnabled();
  await expectPath(page, '/login');
  expect(await readStoredApiKey(page)).toBeNull();
});

test('a key pasted with surrounding whitespace signs in and is stored trimmed', async ({
  page,
}) => {
  await page.goto('/login');

  await keyField(page).fill(`  ${TEST_API_KEY}\n`);
  await submit(page).click();

  await expectPath(page, '/projects');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
});

test('an empty or blank field sends no key check and stays on the sign-in screen', async ({
  page,
}) => {
  const keyChecks = countKeyChecks(page);
  await page.goto('/login');

  await keyField(page).press('Enter');
  await keyField(page).fill('   ');
  await keyField(page).press('Enter');

  await expect(submit(page)).toBeDisabled();
  await expectPath(page, '/login');
  expect(keyChecks()).toBe(0);
});

test('a deep link survives the sign-in screen', async ({ page }) => {
  await stubProject(page);

  await page.goto(`/projects/${PROJECT.id}`);
  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toMatch(
    new RegExp(`^/projects/${PROJECT.id}`)
  );

  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();

  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('project-screen')).toBeVisible();
});

test('a redirect to another origin is dropped after sign-in', async ({ page }) => {
  await page.goto('/login?redirect=https://example.com/steal');

  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('a stored key the API refuses is dropped once, with no redirect loop', async ({ page }) => {
  const keyChecks = countKeyChecks(page);
  await setApiKey(page, WRONG_KEY);

  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(keyField(page)).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(null));
  await page.waitForLoadState('networkidle');
  await expectPath(page, '/login');
  expect(keyChecks()).toBe(1);
});

test('a 401 in a session signs out and comes back to the page after a new sign-in', async ({
  page,
}) => {
  await stubFleetSpend(page);
  let refuse = true;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/projects',
    (route) =>
      refuse
        ? fulfillJson(route, { error: 'auth.invalid_key', message: INVALID_KEY }, 401)
        : fulfillJson(route, [PROJECT])
  );
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/projects');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/projects');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(null));
  refuse = false;
  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toContainText(PROJECT.name);
});

test('every API call carries the API key, reads and writes alike', async ({ page }) => {
  const calls: Request[] = [];
  page.on('request', (request) => {
    if (isApiCall(request) && !isKeyCheck(request)) calls.push(request);
  });
  await stubProject(page);
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING,
    (route) => fulfillJson(route, NO_POLICY)
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `${SCALING}/app`,
    (route) => fulfillJson(route, route.request().postDataJSON())
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `${SCALING}/agents`,
    (route) => fulfillJson(route, { agents: [] })
  );
  await page.goto('/login');
  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();
  await expectPath(page, '/projects');
  const signedIn = calls.length;

  await page.goto(SCALING);
  await page.getByTestId('scaling-policy-none').getByTestId('policy-add').click();
  await page.getByTestId('policy-save').click();
  await expect(page.getByTestId('app-toast')).toBeVisible();

  const session = calls
    .slice(signedIn)
    .filter((call) => new URL(call.url()).pathname !== '/auth/status');
  const bearers = session.map((call) => ({
    method: call.method(),
    authorization: call.headers()['authorization'],
  }));
  expect(bearers.some(({ method }) => method === 'GET')).toBe(true);
  expect(bearers.some(({ method }) => method === 'PUT')).toBe(true);
  for (const { method, authorization } of bearers) {
    expect(authorization, method).toBe(`Bearer ${TEST_API_KEY}`);
  }
});

test('logging out forgets the key, and Back does not reopen the dashboard', async ({ page }) => {
  await setApiKey(page, TEST_API_KEY);
  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  await page.getByTestId('sidebar-user-menu').click();
  await page.getByTestId('sidebar-logout').click();

  await expectPath(page, '/login');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(null));
  await page.goBack();
  await expectPath(page, '/login');
  await expect(keyField(page)).toBeVisible();
});

test('an API that cannot answer the key check keeps the key and offers a retry', async ({
  page,
}) => {
  let down = true;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/auth/check',
    (route) =>
      down
        ? fulfillJson(route, { error: 'service.unavailable', message: 'Restarting' }, 503)
        : route.continue()
  );
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/projects');

  await expect(page.getByTestId('dashboard-error')).toBeVisible();
  await expectPath(page, '/projects');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  down = false;
  await page.getByTestId('dashboard-retry').click();
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});
