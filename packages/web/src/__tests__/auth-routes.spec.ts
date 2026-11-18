// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { expectPath } from './helpers/session';

test('@smoke a stored API key grants access to the protected route', async ({ page }) => {
  await authenticate(page);
  await page.goto('/');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});

test('@smoke a visit to /login with a stored API key lands on the projects overview', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/login');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});

test('the old sign-up page sends a signed-out visitor to the sign-in screen', async ({ page }) => {
  await page.goto('/register?redirect=/projects');

  await expectPath(page, '/login');
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/projects');
  await expect(page.getByTestId('auth-api-key')).toBeVisible();
});
