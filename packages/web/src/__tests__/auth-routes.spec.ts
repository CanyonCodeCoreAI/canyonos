import { expect, test } from '@playwright/test';

import { expiredToken, setToken, validToken } from './helpers/auth';

test('@smoke unauthenticated visit to a protected route lands on /login', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-email-input')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('@smoke a valid token grants access to the protected route', async ({ page }) => {
  await page.addInitScript(setToken, validToken);
  await page.goto('/');
  // The authenticated home redirects to the Projects Overview at /projects.
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});

test('@smoke an expired token is rejected and lands on /login', async ({ page }) => {
  await page.addInitScript(setToken, expiredToken);
  await page.goto('/');
  await expect(page.getByTestId('auth-email-input')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('@smoke an authenticated visit to /login is redirected to the protected route', async ({
  page,
}) => {
  await page.addInitScript(setToken, validToken);
  await page.goto('/login');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});
