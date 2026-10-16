// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';

test('@smoke a signed-in session grants access to the protected route', async ({ page }) => {
  await authenticate(page);
  await page.goto('/');
  // The authenticated home redirects to the Projects Overview at /projects.
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});

test('@smoke an authenticated visit to /login is redirected to the protected route', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/login');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});
