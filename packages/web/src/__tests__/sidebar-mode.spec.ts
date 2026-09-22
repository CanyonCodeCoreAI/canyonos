import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { SHOW_RESOURCE_NAVIGATION } from '../modules/core/components/app-sidebar/sidebar-sections';
import { authenticate } from './helpers/auth';
import { createProject, projectPath } from './helpers/projects';

// Every test here reads the two-section sidebar. The resources section is hidden for now, so there is
// one section, no order to swap and no overview link to compare against. Restored by flipping
// SHOW_RESOURCE_NAVIGATION back on in sidebar-sections.ts.
test.skip(!SHOW_RESOURCE_NAVIGATION, 'resource navigation is hidden');

async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

// Assert section order without touching production code or private structure: compare the document
// position of the always-present Projects anchor (its import link) against a seeded Resources group
// (`nav-cpu`). Both sections render in either mode — only their order flips — so a stable comparison
// of two anchors captures the reordering. Returns true when Projects precedes Resources.
async function projectsAboveResources(page: Page): Promise<boolean> {
  await page.getByTestId('project-import-trigger').waitFor({ state: 'attached' });
  await page.getByTestId('nav-cpu').waitFor({ state: 'attached' });
  return page.evaluate(() => {
    const proj = document.querySelector('[data-testid="project-import-trigger"]');
    const res = document.querySelector('[data-testid="nav-cpu"]');
    if (!proj || !res) throw new Error('sidebar anchors missing');
    return Boolean(proj.compareDocumentPosition(res) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}

test('projects route activates the projects overview link and leads with the projects section', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  await expect(page.getByTestId('nav-projects-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('nav-resources-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(await projectsAboveResources(page)).toBe(true);
});

test('resources route activates the resources overview link and leads with the resources section', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/resources');
  await expect(page.getByTestId('resources-overview')).toBeVisible();

  await expect(page.getByTestId('nav-resources-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('nav-projects-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(await projectsAboveResources(page)).toBe(false);
});

test('resources child route leads with resources but activates no overview link', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/resources/cpu');
  await expect(page.getByTestId('cpu-analytics')).toBeVisible();

  // The overview links point at the overview routes, so neither is "current" on a sub-route — even
  // though the resources section still leads.
  await expect(page.getByTestId('nav-resources-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByTestId('nav-projects-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(await projectsAboveResources(page)).toBe(false);
});

test('project child route leads with projects but activates no overview link', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId(`nav-project-${fixture.project.id}`)).toBeVisible();

  // Section order still follows projects mode, but the overview link is not the current page.
  await expect(page.getByTestId('nav-projects-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByTestId('nav-resources-overview')).not.toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(await projectsAboveResources(page)).toBe(true);
});

test('@smoke overview links are focusable and Enter-activate navigation', async ({ page }) => {
  await authenticate(page);
  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  const resourcesLink = page.getByTestId('nav-resources-overview');
  await resourcesLink.focus();
  await expect(resourcesLink).toBeFocused();
  await resourcesLink.press('Enter');
  await expectPath(page, '/resources');
  await expect(page.getByTestId('resources-overview')).toBeVisible();

  const projectsLink = page.getByTestId('nav-projects-overview');
  await projectsLink.focus();
  await expect(projectsLink).toBeFocused();
  await projectsLink.press('Enter');
  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});
