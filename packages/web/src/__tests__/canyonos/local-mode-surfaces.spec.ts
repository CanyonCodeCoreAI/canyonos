import { expect, test } from '@playwright/test';

import {
  PROJECT,
  stubFleetSpend,
  stubLocalSession,
  stubProjectDashboard,
  stubProjectsList,
  watchDeployRequests,
} from './local-mode.helpers';

test.describe('project navigation', () => {
  test.beforeEach(async ({ page }) => {
    await stubLocalSession(page);
    await stubProjectsList(page, [PROJECT]);
    await stubProjectDashboard(page, PROJECT);
    await stubFleetSpend(page);
  });

  test('a project offers Manage and nothing that needs a deploy target', async ({ page }) => {
    await page.goto(`/projects/${PROJECT.id}`);
    await expect(page.getByTestId('project-screen')).toBeVisible();

    // The row expands on arrival, so what it holds is on screen rather than one click away.
    await expect(page.getByTestId(`nav-project-manage-${PROJECT.id}`)).toBeVisible();

    for (const hidden of [
      `nav-project-design-${PROJECT.id}`,
      `nav-project-design-toggle-${PROJECT.id}`,
      `nav-project-deploy-${PROJECT.id}`,
      `nav-project-deploy-toggle-${PROJECT.id}`,
      `nav-project-config-${PROJECT.id}`,
      `nav-project-performance-${PROJECT.id}`,
      `nav-project-deployment_config-${PROJECT.id}`,
      `nav-project-actions-${PROJECT.id}`,
      'project-import-trigger',
    ]) {
      await expect(page.getByTestId(hidden)).toHaveCount(0);
    }
  });

  test('the empty project list states the fact instead of offering an import', async ({ page }) => {
    await stubProjectsList(page, []);

    await page.goto('/projects');

    const empty = page.getByTestId('projects-empty');
    await expect(empty).toBeVisible();
    await expect(empty).not.toContainText('Import');
    await expect(empty).toHaveCount(1);
    await expect(page.getByTestId('project-import-trigger')).toHaveCount(0);
  });
});

test.describe('projects overview', () => {
  test.beforeEach(async ({ page }) => {
    await stubLocalSession(page);
    await stubFleetSpend(page);
  });

  test('carries no create-project action and no deploy state per row', async ({ page }) => {
    await stubProjectsList(page, [PROJECT]);

    await page.goto('/projects');
    await expect(page.getByTestId('projects-overview')).toBeVisible();

    await expect(page.getByTestId('projects-overview-new-project')).toHaveCount(0);
    await expect(page.getByTestId('header-create-project')).toHaveCount(0);
    await expect(page.getByTestId('projects-overview-resume')).toHaveCount(0);
    await expect(page.getByTestId(`projects-overview-copy-ip-${PROJECT.id}`)).toHaveCount(0);

    // Every row opens the project detail: there is no deploy route to link into.
    const row = page.getByTestId(`projects-overview-project-${PROJECT.id}`);
    await expect(row).toHaveAttribute('href', `/projects/${PROJECT.id}`);
    await expect(row.locator('..')).not.toContainText('Not deployed');
  });

  test('the hero counts projects and promises no deploys', async ({ page }) => {
    await stubProjectsList(page, [PROJECT]);

    await page.goto('/projects');

    const hero = page.getByTestId('projects-overview-hero');
    await expect(hero).toContainText('1 project on this machine.');
    await expect(hero).not.toContainText('deploy');
  });

  test('an empty workspace says so without offering an import', async ({ page }) => {
    await stubProjectsList(page, []);

    await page.goto('/projects');

    const empty = page.getByTestId('projects-overview-empty');
    await expect(empty).toBeVisible();
    await expect(empty).not.toContainText('Import');
    await expect(page.getByTestId('projects-overview-empty-new-project')).toHaveCount(0);
  });
});

test.describe('project dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await stubLocalSession(page);
    await stubProjectsList(page, [PROJECT]);
    await stubFleetSpend(page);
  });

  test('shows no deploy status, address, deploy action or design entry', async ({ page }) => {
    await stubProjectDashboard(page, PROJECT);

    await page.goto(`/projects/${PROJECT.id}`);
    await expect(page.getByTestId('project-hero')).toBeVisible();

    for (const hidden of [
      'project-deploy-status',
      'project-deploy-loading',
      'project-deploy-endpoint',
      'project-design-link',
      'project-deploy-header-loading',
    ]) {
      await expect(page.getByTestId(hidden)).toHaveCount(0);
    }
    await expect(page.getByRole('link', { name: /deploy/i })).toHaveCount(0);
    // Refresh only re-reads what is on screen, so it survives.
    await expect(page.getByTestId('project-header-refresh')).toBeVisible();
  });

  test('asks for no deploy endpoint on either screen', async ({ page }) => {
    const deployRequests = await watchDeployRequests(page);
    await stubProjectDashboard(page, PROJECT);

    await page.goto('/projects');
    await expect(page.getByTestId('projects-overview-list')).toBeVisible();

    await page.getByTestId(`projects-overview-project-${PROJECT.id}`).click();
    await expect(page.getByTestId('project-screen')).toBeVisible();
    await expect(page.getByTestId('project-cost-queries')).toBeVisible();

    expect(deployRequests).toEqual([]);
  });

  test('a project that ran nothing keeps its empty state', async ({ page }) => {
    await stubProjectDashboard(page, PROJECT);

    await page.goto(`/projects/${PROJECT.id}`);

    const highlights = page.getByTestId('project-spend-highlights');
    await expect(highlights).toBeVisible();
    await expect(highlights).toContainText('Nothing has billed in this window.');
  });

  test('a failing metrics read keeps its error and its retry', async ({ page }) => {
    await stubProjectDashboard(page, PROJECT, { kpis_fail: true });

    await page.goto(`/projects/${PROJECT.id}`);

    const error = page.getByTestId('project-cost-ribbon-error');
    await expect(error).toBeVisible();

    await stubProjectDashboard(page, PROJECT);
    await error.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByTestId('project-cost-queries')).toBeVisible();
  });
});
