import { expect, test } from '@playwright/test';

import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubLocalSession,
  stubProjectDashboard,
  stubProjectsList,
} from './local-mode.helpers';

// Every route that needs a billing account, an import pipeline or a deploy target. The dashboard
// still builds them; local mode sends a reader who types one back to the projects overview.
const CLOSED_PATHS = [
  '/resources',
  '/resources/cpu',
  '/projects/import',
  `/projects/${PROJECT.id}/deploy`,
  `/projects/${PROJECT.id}/deployment-config`,
  // Not a route at all: the guard reads the last match, and a URL matching nothing leaves it none.
  '/not-a-route-at-all',
] as const;

test.beforeEach(async ({ page }) => {
  await stubLocalSession(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
});

for (const path of CLOSED_PATHS) {
  test(`@smoke ${path} is closed and ends on the projects overview`, async ({ page }) => {
    await page.goto(path);

    await expectPath(page, '/projects');
    await expect(page.getByTestId('projects-overview')).toBeVisible();
  });
}

test('the routes local mode keeps still open', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  await page.goto(`/projects/${PROJECT.id}`);
  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('project-screen')).toBeVisible();
});
