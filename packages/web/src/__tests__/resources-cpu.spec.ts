import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('@smoke CPU resources view renders every card', async ({ page }) => {
  await page.goto('/resources/cpu');

  await expect(page.getByTestId('cpu-analytics')).toBeVisible();

  // Data-driven: cards only mount once the /resources/cpu fetch resolves, so their
  // visibility also proves the API → selector → render pipeline worked end to end.
  await expect(page.getByText('CPU cost over time')).toBeVisible();

  await expect(page.getByTestId('cpu-cost-card')).toBeVisible();
  await expect(page.getByTestId('cpu-idle-card')).toBeVisible();
  await expect(page.getByTestId('cpu-allocation-card')).toBeVisible();
  await expect(page.getByTestId('top-requests-card')).toBeVisible();
  await expect(page.getByTestId('top-workflows-card')).toBeVisible();
});

test('@smoke CPU resources view shows the Resources › CPU breadcrumb', async ({ page }) => {
  await page.goto('/resources/cpu');

  const breadcrumbs = page.getByTestId('app-breadcrumbs');
  await expect(breadcrumbs).toContainText('Resources');
  await expect(breadcrumbs).toContainText('CPU');
});
