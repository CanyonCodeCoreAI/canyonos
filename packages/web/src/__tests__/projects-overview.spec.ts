import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { ProjectSummary } from '@canyonos/api/projects';
import type { FleetProject } from '@canyonos/api/resources';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';

const apiOrigin = new URL(apiBaseUrl).origin;

async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
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

test('projects overview empty state states the fact without offering an import', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectsList(page, []);
  await page.goto('/projects');

  const empty = page.getByTestId('projects-overview-empty');
  await expect(empty).toContainText('No projects on this machine yet.');
  await expect(empty.getByRole('link')).toHaveCount(0);
});

test('projects overview list fits short project lists instead of filling the viewport', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Portfolio')]);
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

test('a project row opens its Status', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Fraud Screen')]);

  await page.goto('/projects');

  await expect(page.getByTestId(`projects-overview-project-${PROJECT_A}`)).toHaveAttribute(
    'href',
    `/projects/${PROJECT_A}/status`
  );
});

test('each project row carries its queries, spend and cost per query', async ({ page }) => {
  await authenticate(page);
  await mockProjectsList(page, [projectFixture(PROJECT_A, 'Alpha')]);
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
