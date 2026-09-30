import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, failJson, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

test('account menu reveals company details and logs out', async ({ page }) => {
  await authenticate(page);
  await page.goto('/projects');

  const trigger = page.getByTestId('sidebar-user-menu');
  await trigger.click();
  await expect(page.getByTestId('sidebar-user-menu-content')).toBeVisible();
  await expect(page.getByTestId('sidebar-company')).toBeVisible();
  await page.getByTestId('sidebar-logout').click();
  await expect(page).toHaveURL(/\/login/);
});

test('project navigation distinguishes loading, error, retry, and empty states', async ({
  page,
}) => {
  await authenticate(page);
  await stubFleetSpend(page);
  let releaseProjects!: () => void;
  const projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  let attempts = 0;

  const apiOrigin = new URL(apiBaseUrl).origin;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/projects',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      attempts += 1;
      if (attempts === 1) {
        await projectsGate;
        return failJson(route);
      }
      return fulfillJson(route, []);
    }
  );

  await page.goto('/projects');
  await expect(page.getByTestId('projects-loading')).toBeVisible();
  releaseProjects();
  await expect(page.getByTestId('projects-error')).toBeVisible();
  await page.getByTestId('projects-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('projects-empty')).toHaveText('No projects on this machine yet.');
  expect(attempts).toBe(2);
});

test('@smoke project row opens the dashboard in one click and the chevron folds Manage away', async ({
  page,
}) => {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
  const row = page.getByTestId(`nav-project-${PROJECT.id}`);
  const toggle = page.getByTestId(`nav-project-toggle-${PROJECT.id}`);
  const manage = page.getByTestId(`nav-project-manage-${PROJECT.id}`);

  await page.goto('/projects');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('project-screen')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(manage).toHaveAttribute('aria-current', 'page');

  // Folding is the chevron's job and must not navigate away from the dashboard.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(manage).toHaveCount(0);
  await expectPath(page, `/projects/${PROJECT.id}`);

  await row.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});
