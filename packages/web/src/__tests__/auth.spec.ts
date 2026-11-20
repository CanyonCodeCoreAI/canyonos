// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

import type { ScalingAgentsResponse, ScalingPolicy, ScalingResponse } from '@canyonos/api/scaling';

import { readStoredApiKey, setApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import {
  expectPath,
  stubFleetSpend,
  stubWorkflowDashboard,
  stubWorkflowsList,
  WORKFLOW,
  WORKFLOW_API,
} from './helpers/session';
import { apiBaseUrl, fulfillJson } from './helpers/workflows';
import type { ApiErrorBody } from './helpers/workflows';

const apiOrigin = new URL(apiBaseUrl).origin;
const WRONG_KEY = 'not-the-api-key';
const INVALID_KEY =
  'This API key is not the one this API was started with. Use that key, or start it with yours: `canyonos serve --api-key <key>`';
const SCALING = `/workflows/${WORKFLOW.id}/scaling`;
const SCALING_API = `${WORKFLOW_API}/scaling`;
const NO_POLICY = { workflows: { app: { status: 'none' } } } satisfies ScalingResponse;

const keyField = (page: Page) => page.getByTestId('auth-api-key');
const submit = (page: Page) => page.getByTestId('auth-submit');
const formError = (page: Page) => page.getByTestId('auth-error');

const isApiCall = (request: Request) => new URL(request.url()).origin === apiOrigin;
const isKeyCheck = (request: Request) =>
  isApiCall(request) && new URL(request.url()).pathname === '/v1/auth/check';

function countKeyChecks(page: Page): () => number {
  let checks = 0;
  page.on('request', (request) => {
    if (isKeyCheck(request)) checks += 1;
  });
  return () => checks;
}

async function stubWorkflow(page: Page): Promise<void> {
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);
}

test('@smoke a signed-out visit asks for one API key, and nothing about an account', async ({
  page,
}) => {
  await page.goto('/workflows');

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

  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  await page.reload();
  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
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

  await expectPath(page, '/workflows');
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
  await stubWorkflow(page);

  await page.goto(`/workflows/${WORKFLOW.id}`);
  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toMatch(
    new RegExp(`^/workflows/${WORKFLOW.id}`)
  );

  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();

  await expectPath(page, `/workflows/${WORKFLOW.id}`);
  await expect(page.getByTestId('workflow-screen')).toBeVisible();
});

test('a redirect to another origin is dropped after sign-in', async ({ page }) => {
  await page.goto('/login?redirect=https://example.com/steal');

  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();

  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
});

test('a stored key the API refuses is dropped once, with no redirect loop', async ({ page }) => {
  const keyChecks = countKeyChecks(page);
  await setApiKey(page, WRONG_KEY);

  await page.goto('/workflows');

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
    (url) => url.origin === apiOrigin && url.pathname === '/v1/workflows',
    (route) =>
      refuse
        ? fulfillJson(
            route,
            { error: 'auth.invalid_key', message: INVALID_KEY } satisfies ApiErrorBody,
            401
          )
        : fulfillJson(route, [WORKFLOW])
  );
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/workflows');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/workflows');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(null));
  refuse = false;
  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();
  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toContainText(WORKFLOW.name);
});

test('every API call carries the API key, reads and writes alike', async ({ page }) => {
  const calls: Request[] = [];
  page.on('request', (request) => {
    if (isApiCall(request) && !isKeyCheck(request)) calls.push(request);
  });
  await stubWorkflow(page);
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING_API,
    (route) =>
      fulfillJson(
        route,
        route.request().method() === 'PUT'
          ? (route.request().postDataJSON() as ScalingPolicy)
          : NO_POLICY
      )
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `${SCALING_API}/agents`,
    (route) => fulfillJson(route, { agents: [] } satisfies ScalingAgentsResponse)
  );
  await page.goto('/login');
  await keyField(page).fill(TEST_API_KEY);
  await submit(page).click();
  await expectPath(page, '/workflows');
  const signedIn = calls.length;

  await page.goto(SCALING);
  await page.getByTestId('scaling-policy-none').getByTestId('policy-add').click();
  await page.getByTestId('policy-save').click();
  await expect(page.getByTestId('app-toast')).toBeVisible();

  const session = calls
    .slice(signedIn)
    .filter((call) => new URL(call.url()).pathname !== '/v1/auth/status');
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
  await page.goto('/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();

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
    (url) => url.origin === apiOrigin && url.pathname === '/v1/auth/check',
    (route) =>
      down
        ? fulfillJson(
            route,
            {
              error: 'database.unavailable',
              message: "The dashboard's database is not ready yet; try again shortly.",
            } satisfies ApiErrorBody,
            503
          )
        : route.continue()
  );
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/workflows');

  await expect(page.getByTestId('dashboard-error')).toBeVisible();
  await expectPath(page, '/workflows');
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  down = false;
  await page.getByTestId('dashboard-retry').click();
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
  await expectPath(page, '/workflows');
});
