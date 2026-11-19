// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { expectPath } from './helpers/session';

test('@smoke a stored API key grants access to the protected route', async ({ page }) => {
  await authenticate(page);
  await page.goto('/');

  await expect(page.getByTestId('workflows-overview')).toBeVisible();
  await expectPath(page, '/workflows');
});

test('@smoke a visit to /login with a stored API key lands on the workflows overview', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/login');

  await expect(page.getByTestId('workflows-overview')).toBeVisible();
  await expectPath(page, '/workflows');
});

test('the old sign-up page sends a signed-out visitor to the sign-in screen', async ({ page }) => {
  await page.goto('/register?redirect=/workflows');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/workflows');
  await expect(page.getByTestId('auth-api-key')).toBeVisible();
});
