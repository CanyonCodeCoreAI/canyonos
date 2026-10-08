import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import { PROJECT, stubFleetSpend, stubProjectDashboard, stubProjectsList } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;

test('a pending project read shows the shimmering logo until the project arrives', async ({
  page,
}) => {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubFleetSpend(page);
  await stubProjectDashboard(page, PROJECT);

  let releaseProject!: () => void;
  const projectGate = new Promise<void>((resolve) => {
    releaseProject = resolve;
  });
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `/projects/${PROJECT.id}`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await projectGate;
      return fulfillJson(route, PROJECT);
    }
  );

  await page.goto(`/projects/${PROJECT.id}`);

  const empty = page.getByTestId('empty-state');
  try {
    await expect(empty).toContainText('Loading project…');
    await expect(empty.getByTestId('empty-state-logo')).toHaveAttribute('data-loading', 'true');
  } finally {
    releaseProject();
  }

  await expect(page.getByTestId('project-screen')).toBeVisible();
  await expect(empty).toHaveCount(0);
});
