// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

import type { ScalingResponse } from '@canyonos/api/scaling';

import { readStoredTokens, setTokens, storedTokens, tokenFor } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const READ_REFUSAL = 'A write token reads only what it can change; send a read token for this';
const WRITE_REFUSAL = 'This token may read but not change anything';
const UNTRUSTED = 'This token is not signed by a key this API trusts';
const SCALING = `/projects/${PROJECT.id}/scaling`;
const NO_POLICY = { projects: { app: { status: 'none' } } } satisfies ScalingResponse;

const readField = (page: Page) => page.getByTestId('auth-read-token');
const writeField = (page: Page) => page.getByTestId('auth-write-token');
const submit = (page: Page) => page.getByTestId('auth-submit');
const formError = (page: Page) => page.getByTestId('auth-error');

/** A token the API cannot trust: signed by a key pair made here and never put in its folder. */
const untrustedToken = (scope: string) =>
  tokenFor(scope, undefined, { key: generateKeyPairSync('ed25519').privateKey });

const isApiCall = (request: Request) => new URL(request.url()).origin === apiOrigin;
const isTokenCheck = (request: Request) =>
  isApiCall(request) && new URL(request.url()).pathname === '/auth/token';

function countTokenChecks(page: Page): () => number {
  let checks = 0;
  page.on('request', (request) => {
    if (isTokenCheck(request)) checks += 1;
  });
  return () => checks;
}

async function stubProject(page: Page): Promise<void> {
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
}

test('@smoke a signed-out visit asks for a read and a write token, and nothing about an account', async ({
  page,
}) => {
  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(page.getByLabel('Read token')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Write token')).toHaveAttribute('type', 'password');
  await expect(page.getByText('canyonos token create --scope read')).toBeVisible();
  await expect(page.getByText('canyonos token create --scope write')).toBeVisible();
  await expect(page.getByLabel(/email/i)).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /create|register|account/i })).toHaveCount(0);
  await expect(submit(page)).toBeDisabled();
});

test('@smoke a read token sent with Enter signs in, is stored alone, and survives a reload', async ({
  page,
}) => {
  const readToken = tokenFor('read');
  await page.goto('/login');

  await readField(page).fill(readToken);
  await readField(page).press('Enter');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  expect(await readStoredTokens(page)).toEqual(storedTokens({ readToken }));
  await page.reload();
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('both tokens sign in together and the account menu names them', async ({ page }) => {
  const tokens = { readToken: tokenFor('read'), writeToken: tokenFor('write') };
  await page.goto('/login');

  await readField(page).fill(tokens.readToken);
  await writeField(page).fill(tokens.writeToken);
  await submit(page).click();

  await expectPath(page, '/projects');
  expect(await readStoredTokens(page)).toEqual(storedTokens(tokens));
  await page.getByTestId('sidebar-user-menu').click();
  await expect(page.getByTestId('sidebar-held-tokens')).toHaveText('Tokens held: read and write');
});

test('a write token alone signs in, and a page that only reads shows the refusal where its data would be', async ({
  page,
}) => {
  const writeToken = tokenFor('write');
  await page.goto('/login');

  await writeField(page).fill(writeToken);
  await submit(page).click();

  await expectPath(page, '/projects');
  const refusal = page.getByTestId('projects-overview').getByTestId('query-refused');
  await expect(refusal).toHaveText(READ_REFUSAL);
  await expect(page.getByTestId('projects-overview-error')).toHaveCount(0);
  await expect(page.getByTestId('projects-error').getByTestId('query-refused')).toHaveText(
    READ_REFUSAL
  );
  expect(await readStoredTokens(page)).toEqual(storedTokens({ writeToken }));
  await page.getByTestId('sidebar-user-menu').click();
  await expect(page.getByTestId('sidebar-held-tokens')).toHaveText('Tokens held: write');
});

test('a token signed by a key the API does not trust shows its refusal against the read field', async ({
  page,
}) => {
  await page.goto('/login');

  await readField(page).fill(untrustedToken('read'));
  await submit(page).click();

  await expect(formError(page)).toHaveText(`Read token: ${UNTRUSTED}`);
  await expect(formError(page)).toHaveAttribute('role', 'alert');
  await expect(readField(page)).toHaveAttribute('aria-describedby', /\bauth-error\b/);
  await expect(writeField(page)).not.toHaveAttribute('aria-describedby', /\bauth-error\b/);
  await expect(submit(page)).toBeEnabled();
  await expectPath(page, '/login');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
});

test('a refused write token is named even when the read token is good, and neither is kept', async ({
  page,
}) => {
  await page.goto('/login');

  await readField(page).fill(tokenFor('read'));
  await writeField(page).fill(untrustedToken('write'));
  await submit(page).click();

  await expect(formError(page)).toHaveText(`Write token: ${UNTRUSTED}`);
  await expect(writeField(page)).toHaveAttribute('aria-describedby', /\bauth-error\b/);
  await expect(readField(page)).not.toHaveAttribute('aria-describedby', /\bauth-error\b/);
  await expect(writeField(page)).toBeFocused();
  await expectPath(page, '/login');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
});

test('a token pasted into the field of the other scope is refused', async ({ page }) => {
  await page.goto('/login');

  await readField(page).fill(tokenFor('write'));
  await submit(page).click();

  await expect(formError(page)).toHaveText('Read token: This is a write token, not a read token');
  await expectPath(page, '/login');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
});

test('a workflow token pasted by mistake is refused and nothing is stored', async ({ page }) => {
  await page.goto('/login');

  await readField(page).fill(tokenFor('query', undefined, { aud: [PROJECT.id] }));
  await submit(page).click();

  await expect(formError(page)).toHaveText(
    'Read token: This token is for a workflow, not for the dashboard API'
  );
  await expectPath(page, '/login');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
});

test('a token pasted with surrounding whitespace signs in and is stored trimmed', async ({
  page,
}) => {
  const readToken = tokenFor('read');
  await page.goto('/login');

  await readField(page).fill(`  ${readToken}\n`);
  await submit(page).click();

  await expectPath(page, '/projects');
  expect(await readStoredTokens(page)).toEqual(storedTokens({ readToken }));
});

test('empty or blank fields send no token check and stay on the token screen', async ({ page }) => {
  const tokenChecks = countTokenChecks(page);
  await page.goto('/login');

  await readField(page).press('Enter');
  await writeField(page).fill('   ');
  await writeField(page).press('Enter');

  await expect(submit(page)).toBeDisabled();
  await expectPath(page, '/login');
  expect(tokenChecks()).toBe(0);
});

test('a deep link survives the token screen', async ({ page }) => {
  await stubProject(page);

  await page.goto(`/projects/${PROJECT.id}`);
  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toMatch(
    new RegExp(`^/projects/${PROJECT.id}`)
  );

  await readField(page).fill(tokenFor('read'));
  await submit(page).click();

  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('project-screen')).toBeVisible();
});

test('a redirect to another origin is dropped after sign-in', async ({ page }) => {
  await page.goto('/login?redirect=https://example.com/steal');

  await readField(page).fill(tokenFor('read'));
  await submit(page).click();

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('an expired stored token is dropped and sent to the token screen without asking the API', async ({
  page,
}) => {
  const tokenChecks = countTokenChecks(page);
  await setTokens(page, { readToken: tokenFor('read', Math.floor(Date.now() / 1000) - 60) });

  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(readField(page)).toBeVisible();
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
  expect(tokenChecks()).toBe(0);
});

test('a stored token the API no longer trusts is dropped once, with no redirect loop', async ({
  page,
}) => {
  const tokenChecks = countTokenChecks(page);
  await setTokens(page, { readToken: untrustedToken('read') });

  await page.goto('/projects');

  await expectPath(page, '/login');
  await expect(readField(page)).toBeVisible();
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
  await page.waitForLoadState('networkidle');
  await expectPath(page, '/login');
  expect(tokenChecks()).toBe(1);
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
        ? fulfillJson(route, { error: 'auth.invalid_token', message: 'This token expired' }, 401)
        : fulfillJson(route, [PROJECT])
  );
  await setTokens(page, { readToken: tokenFor('read') });

  await page.goto('/projects');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/projects');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
  refuse = false;
  await readField(page).fill(tokenFor('read'));
  await submit(page).click();
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toContainText(PROJECT.name);
});

test('every API call carries the token its method needs', async ({ page }) => {
  const tokens = { readToken: tokenFor('read'), writeToken: tokenFor('write') };
  const calls: Request[] = [];
  page.on('request', (request) => {
    if (isApiCall(request) && !isTokenCheck(request)) calls.push(request);
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
  await readField(page).fill(tokens.readToken);
  await writeField(page).fill(tokens.writeToken);
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
  expect(bearers.some(({ method }) => method === 'PUT')).toBe(true);
  for (const { method, authorization } of bearers) {
    const token = method === 'GET' ? tokens.readToken : tokens.writeToken;
    expect(authorization, method).toBe(`Bearer ${token}`);
  }
});

test('with a read token only, an action shows the refusal and the page stays signed in', async ({
  page,
}) => {
  await stubProject(page);
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING,
    (route) => fulfillJson(route, NO_POLICY)
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `${SCALING}/app`,
    (route) => fulfillJson(route, { error: 'auth.insufficient_scope', message: WRITE_REFUSAL }, 403)
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `${SCALING}/agents`,
    (route) => fulfillJson(route, { agents: [] })
  );
  const readToken = tokenFor('read');
  await setTokens(page, { readToken });

  await page.goto(SCALING);
  await page.getByTestId('scaling-policy-none').getByTestId('policy-add').click();
  await page.getByTestId('policy-save').click();

  await expect(page.getByTestId('scaling-policy-editor').getByRole('alert')).toContainText(
    WRITE_REFUSAL
  );
  await expectPath(page, SCALING);
  expect(await readStoredTokens(page)).toEqual(storedTokens({ readToken }));
});

test('logging out forgets the tokens, and Back does not reopen the dashboard', async ({ page }) => {
  await setTokens(page, { readToken: tokenFor('read'), writeToken: tokenFor('write') });
  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  await page.getByTestId('sidebar-user-menu').click();
  await page.getByTestId('sidebar-logout').click();

  await expectPath(page, '/login');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
  await page.goBack();
  await expectPath(page, '/login');
  await expect(readField(page)).toBeVisible();
});

test('an API that cannot answer the token check keeps the tokens and offers a retry', async ({
  page,
}) => {
  const readToken = tokenFor('read');
  let down = true;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/auth/token',
    (route) =>
      down
        ? fulfillJson(route, { error: 'service.unavailable', message: 'Restarting' }, 503)
        : route.continue()
  );
  await setTokens(page, { readToken });

  await page.goto('/projects');

  await expect(page.getByTestId('dashboard-error')).toBeVisible();
  await expectPath(page, '/projects');
  expect(await readStoredTokens(page)).toEqual(storedTokens({ readToken }));
  down = false;
  await page.getByTestId('dashboard-retry').click();
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});
