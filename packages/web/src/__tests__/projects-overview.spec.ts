import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { DeploymentOverviewItem } from '@canyonos/api/deploy';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { FleetProject } from '@canyonos/api/resources';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';

const IMPORT_PATH = '/projects/import';
const apiOrigin = new URL(apiBaseUrl).origin;

async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

async function mockOverview(page: Page, deployments: DeploymentOverviewItem[]): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/projects/deployments',
    (route) =>
      route.request().method() === 'GET' ? fulfillJson(route, deployments) : route.continue()
  );
}

async function mockProjectsList(page: Page, projects: ProjectSummary[]): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/projects',
    (route) =>
      route.request().method() === 'GET' ? fulfillJson(route, projects) : route.continue()
  );
}

/** The trailing-30-day rollup the rows read their spend figures from. */
async function mockFleetSpend(page: Page, projects: FleetProject[]): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/resources/overview',
    (route) =>
      route.request().method() === 'GET'
        ? fulfillJson(route, { kpis: [], resources: [], projects, time_window: '30d' })
        : route.continue()
  );
}

function fleetFixture(id: string, cost: number, requests: number): FleetProject {
  return {
    id,
    name: 'ignored by the row, which reads the project record for its name',
    color_index: 0,
    cost,
    requests,
    avg_latency_ms: 210,
    error_rate_pct: 0,
    resource_usage: [],
  };
}

const PROJECT_A = '11111111-1111-4111-8111-1111111111a1';
const PROJECT_B = '11111111-1111-4111-8111-1111111111b2';
const DEPLOY_A = '22222222-2222-4222-8222-2222222222a1';
const DEPLOY_B = '22222222-2222-4222-8222-2222222222b2';

function projectFixture(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    file_count: 5,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
  };
}

test('@smoke authenticated home redirects to the projects overview', async ({ page }) => {
  await authenticate(page);
  await page.goto('/');

  await expectPath(page, '/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('@smoke projects overview hero shows create CTA', async ({ page }) => {
  await authenticate(page);
  await page.goto('/projects');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expect(page.getByTestId('projects-overview-hero')).toBeVisible();

  // The populated projects overview surfaces a "New project" CTA in its hero that leads to import.
  // The resources header keeps its own create-project CTA off this screen.
  const heroCta = page.getByTestId('projects-overview-new-project');
  await expect(heroCta).toBeVisible();
  await expect(heroCta).toHaveAttribute('href', IMPORT_PATH);
  await expect(page.getByTestId('header-create-project')).toHaveCount(0);
});

test('@smoke /resources still renders the resources overview', async ({ page }) => {
  await authenticate(page);
  await page.goto('/resources');

  await expect(page.getByTestId('resources-overview')).toBeVisible();
  await expectPath(page, '/resources');
});

test('@smoke the resources header create-project CTA leads to import', async ({ page }) => {
  await authenticate(page);

  await page.goto('/resources/cpu');
  await expect(page.getByTestId('header-create-project')).toBeVisible();

  await page.goto('/resources');
  const cta = page.getByTestId('header-create-project');
  await expect(cta).toHaveAttribute('href', IMPORT_PATH);

  await cta.click();
  await expectPath(page, IMPORT_PATH);
  await expect(page.getByRole('heading', { name: 'Import a project' })).toBeVisible();
});

test('projects overview hides the resume card when no deploy is in flight', async ({ page }) => {
  await authenticate(page);
  await mockOverview(page, []);
  await page.goto('/projects');

  await expect(
    page.getByTestId('projects-overview-list').or(page.getByTestId('projects-overview-empty'))
  ).toBeVisible();
  await expect(page.getByTestId('projects-overview-resume')).toHaveCount(0);
});

test('projects overview empty state uses one matching new-project CTA', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, []);
  await mockOverview(page, []);
  await page.goto('/projects');

  await expect(page.getByTestId('projects-overview-empty')).toBeVisible();
  await expect(page.getByTestId('projects-overview-new-project')).toHaveCount(0);

  const emptyCta = page.getByTestId('projects-overview-empty-new-project');
  await expect(emptyCta).toHaveAttribute('href', IMPORT_PATH);
});

test('projects overview list fits short project lists instead of filling the viewport', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Portfolio')]);
  await mockOverview(page, []);
  await page.goto('/projects');

  const list = page.getByTestId('projects-overview-list');
  await expect(list).toBeVisible();

  const listBox = await list.boundingBox();
  const rowBox = await page
    .getByTestId(`projects-overview-project-${PROJECT_A}`)
    .locator('..')
    .boundingBox();

  if (!listBox || !rowBox) throw new Error('Project overview list layout was not measurable.');
  expect(listBox.height).toBeLessThan(rowBox.height + 16);
});

test('projects overview surfaces the active deploy and per-project deploy status', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectsList(page, [
    projectFixture(PROJECT_A, 'Fraud Screen'),
    projectFixture(PROJECT_B, 'Request Router'),
  ]);
  await mockOverview(page, [
    {
      id: DEPLOY_A,
      project_id: PROJECT_A,
      project_name: 'Fraud Screen',
      status: 'launching_resources',
      address: null,
      error: null,
      stop_error: null,
      created_at: '2026-07-07T14:20:00.000Z',
      updated_at: '2026-07-07T15:00:00.000Z',
    },
    {
      id: DEPLOY_B,
      project_id: PROJECT_B,
      project_name: 'Request Router',
      status: 'success',
      address: 'https://request-router.example.com',
      error: null,
      stop_error: null,
      created_at: '2026-07-06T10:00:00.000Z',
      updated_at: '2026-07-06T10:05:00.000Z',
    },
  ]);
  await page.goto('/projects');

  await expect(page.getByTestId('projects-overview-resume')).toBeVisible();
  await expect(page.getByTestId('projects-overview-resume-progress')).toBeVisible();
  const resumeLink = page.getByTestId('projects-overview-resume-link');
  await expect(resumeLink).toHaveAttribute('href', `/projects/${PROJECT_A}/deploy/${DEPLOY_A}`);
  await expect(resumeLink).toHaveText(/See deploy/);

  const rowA = page.getByTestId(`projects-overview-project-${PROJECT_A}`).locator('..');
  await expect(rowA.getByText('Launching resources', { exact: true })).toBeVisible();
  const rowB = page.getByTestId(`projects-overview-project-${PROJECT_B}`).locator('..');
  await expect(rowB.getByText('Live', { exact: true })).toBeVisible();

  const copyB = page.getByTestId(`projects-overview-copy-ip-${PROJECT_B}`);
  await expect(copyB).toBeVisible();
  await copyB.click();
  await expectPath(page, '/projects');
});

test('projects overview renders a stopped deployment as terminal', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Fraud Screen')]);
  await mockOverview(page, [
    {
      id: DEPLOY_A,
      project_id: PROJECT_A,
      project_name: 'Fraud Screen',
      status: 'stopped',
      address: null,
      error: null,
      stop_error: null,
      created_at: '2026-07-07T14:20:00.000Z',
      updated_at: '2026-07-07T15:00:00.000Z',
    },
  ]);

  await page.goto('/projects');

  const row = page.getByTestId(`projects-overview-project-${PROJECT_A}`).locator('..');
  const badge = row.getByText('Stopped', { exact: true });
  await expect(badge).toHaveClass(/text-primary/);
  await expect(row.getByTestId(`projects-overview-project-${PROJECT_A}`)).toHaveAttribute(
    'href',
    `/projects/${PROJECT_A}`
  );
});

test('each project row carries its queries, spend and cost per query', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Alpha')]);
  await mockOverview(page, []);
  await mockFleetSpend(page, [fleetFixture(PROJECT_A, 31.5, 1_260)]);

  await page.goto('/projects');

  const row = page.getByTestId(`projects-overview-project-${PROJECT_A}`);
  await expect(row).toContainText('1,260');
  await expect(row).toContainText('queries');
  await expect(row).toContainText('$31.50');
  // $31.50 over 1,260 queries, at the same two decimals the ribbon uses.
  await expect(row).toContainText('$0.03');
  await expect(row).toContainText('per query');
});

test('a project that has never run shows no cost per query to divide', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Alpha')]);
  await mockOverview(page, []);
  await mockFleetSpend(page, [fleetFixture(PROJECT_A, 0, 0)]);

  await page.goto('/projects');

  const row = page.getByTestId(`projects-overview-project-${PROJECT_A}`);
  // Figure and label are separate spans held apart by a flex gap, so the row text runs them together.
  await expect(row).toContainText(/0\s*queries/);
  await expect(row).not.toContainText('per query');
});

test('the row still reads when the spend rollup fails', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Alpha')]);
  await mockOverview(page, []);
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/resources/overview',
    (route) => route.fulfill({ status: 500, body: '{}' })
  );

  await page.goto('/projects');

  // Spend is decoration: losing it drops the figures rather than the list.
  const row = page.getByTestId(`projects-overview-project-${PROJECT_A}`);
  await expect(row).toContainText('Alpha');
  await expect(row).not.toContainText('queries');
});
