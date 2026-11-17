// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { setTokens, tokenFor } from './helpers/auth';
import { expectPath } from './helpers/session';

test('@smoke a stored read token grants access to the protected route', async ({ page }) => {
  await setTokens(page, { readToken: tokenFor('read') });
  await page.goto('/');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});

test('@smoke a visit to /login with a stored read token lands on the projects overview', async ({
  page,
}) => {
  await setTokens(page, { readToken: tokenFor('read') });
  await page.goto('/login');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});

test('the old sign-up page sends a signed-out visitor to the token screen', async ({ page }) => {
  await page.goto('/register?redirect=/projects');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/projects');
  await expect(page.getByTestId('auth-read-token')).toBeVisible();
});
