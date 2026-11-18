// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { readStoredTokens, storedTokens, tokenFor } from './helpers/auth';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const UNTRUSTED = 'This token is not signed by a key this API trusts';

/** The link `canyonos dashboard` opens: the tokens ride in the fragment, never in a request. */
const signInLink = (tokens: { read?: string; write?: string }, path = '/login') =>
  `${path}#${new URLSearchParams(tokens).toString()}`;

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

test('@smoke a dashboard link signs in with its tokens, stores them and leaves no trace of them in the address', async ({
  page,
}) => {
  const tokens = { readToken: tokenFor('read'), writeToken: tokenFor('write') };
  const urls = requestedUrls(page);

  await page.goto(signInLink({ read: tokens.readToken, write: tokens.writeToken }));

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  expect(await readStoredTokens(page)).toEqual(storedTokens(tokens));
  expect(new URL(page.url()).hash).toBe('');
  expect(urls.filter((url) => url.includes(tokens.readToken))).toEqual([]);
});

test('a dashboard link goes on to where the visitor was going', async ({ page }) => {
  const readToken = tokenFor('read');
  const project = `/projects/${PROJECT.id}`;
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);

  await page.goto(signInLink({ read: readToken }, `/login?redirect=${project}`));

  await expectPath(page, project);
  await expect(page.getByTestId('project-screen')).toBeVisible();
  expect(await readStoredTokens(page)).toEqual(storedTokens({ readToken }));
});

test('a dashboard link whose token the API refuses stays on the token screen, says why and keeps nothing', async ({
  page,
}) => {
  const untrusted = tokenFor('read', undefined, {
    key: generateKeyPairSync('ed25519').privateKey,
  });

  await page.goto(signInLink({ read: untrusted, write: tokenFor('write') }));

  await expectPath(page, '/login');
  await expect(page.getByTestId('auth-error')).toHaveText(`Read token: ${UNTRUSTED}`);
  await expect(page.getByTestId('auth-read-token')).toHaveAttribute(
    'aria-describedby',
    /\bauth-error\b/
  );
  expect(new URL(page.url()).hash).toBe('');
  expect(await readStoredTokens(page)).toEqual(storedTokens({}));
});
