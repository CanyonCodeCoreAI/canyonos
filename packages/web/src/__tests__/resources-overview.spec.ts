import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { FleetOverview } from '@cc-forge/api/resources';

import { setToken, validToken } from './helpers/auth';

// Anchor the fleet mock to the API origin. A bare `**/resources/overview**` glob would also match
// the app's own Vite source module `/src/modules/resources/overview.selectors.ts` and serve it JSON.
const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';
const OVERVIEW_ROUTE = `${apiBaseUrl}/resources/overview*`;

// The overview endpoint is authenticated + company-scoped + data-driven, so every spec mocks it
// rather than trusting the shared dev DB. `tokens` is the only tracked resource; gpu/cpu/mem/storage
// ship unavailable with an empty pool so the UI must render an explicit not-tracked state.
const OVERVIEW_FIXTURE: FleetOverview = {
  time_window: '1d',
  kpis: [
    {
      id: 'cost',
      label: 'Fleet spend',
      value: '$1,240',
      sub_label: '+8% vs prior',
      tone: 'neutral',
    },
    {
      id: 'requests',
      label: 'Requests',
      value: '18,204',
      sub_label: 'across 3 projects',
      tone: 'neutral',
    },
    {
      id: 'tokens',
      label: 'Tokens',
      value: '12.4M',
      sub_label: 'billed this window',
      tone: 'neutral',
    },
    {
      id: 'errors',
      label: 'Error rate',
      value: '0.9%',
      sub_label: 'down from 1.4%',
      tone: 'positive',
    },
  ],
  resources: [
    { id: 'gpu', label: 'GPU', unit: 'h', pool: 0, available: false },
    { id: 'cpu', label: 'CPU', unit: 'h', pool: 0, available: false },
    { id: 'mem', label: 'Memory', unit: 'GB', pool: 0, available: false },
    { id: 'storage', label: 'Storage', unit: 'GB', pool: 0, available: false },
    { id: 'tokens', label: 'Tokens', unit: 'M', pool: 12.4, available: true },
  ],
  projects: [
    {
      id: 'proj-parser',
      name: 'Document Parser',
      color_index: 0,
      cost: 620,
      requests: 9120,
      avg_latency_ms: 240,
      error_rate_pct: 0.8,
      resource_usage: [
        { resource_id: 'gpu', usage: 0 },
        { resource_id: 'cpu', usage: 0 },
        { resource_id: 'mem', usage: 0 },
        { resource_id: 'storage', usage: 0 },
        { resource_id: 'tokens', usage: 6.2 },
      ],
    },
    {
      id: 'proj-router',
      name: 'Smart Router',
      color_index: 1,
      cost: 410,
      requests: 6040,
      avg_latency_ms: 180,
      error_rate_pct: 1.1,
      resource_usage: [
        { resource_id: 'gpu', usage: 0 },
        { resource_id: 'cpu', usage: 0 },
        { resource_id: 'mem', usage: 0 },
        { resource_id: 'storage', usage: 0 },
        { resource_id: 'tokens', usage: 4.1 },
      ],
    },
    {
      id: 'proj-indexer',
      name: 'Vector Indexer',
      color_index: 2,
      cost: 210,
      requests: 3044,
      avg_latency_ms: 320,
      error_rate_pct: 0.6,
      resource_usage: [
        { resource_id: 'gpu', usage: 0 },
        { resource_id: 'cpu', usage: 0 },
        { resource_id: 'mem', usage: 0 },
        { resource_id: 'storage', usage: 0 },
        { resource_id: 'tokens', usage: 2.1 },
      ],
    },
  ],
};

const DONUT_IDS = ['gpu', 'cpu', 'mem', 'storage', 'tokens'] as const;
const UNTRACKED_IDS = ['gpu', 'cpu', 'mem', 'storage'] as const;

async function mockOverview(page: Page, overview: FleetOverview) {
  await page.route(OVERVIEW_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(overview),
    })
  );
}

test.beforeEach(async ({ page }) => {
  // The fake token can't be validated by the real API, so the authenticated layout's
  // profile lookup would 401 and log the session out mid-navigation. Stub it so the
  // session survives client-side navigation.
  await page.route('**/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: '1', email: 'test@cc-forge.test' }),
    })
  );
  await page.addInitScript(setToken, validToken);
});

test('@smoke overview renders KPI band and every resource donut', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  await expect(page.getByTestId('resources-overview')).toBeVisible();
  await expect(page.getByText('Resource Overview')).toBeVisible();

  await expect(page.getByTestId('overview-kpi-band')).toBeVisible();
  for (const id of DONUT_IDS) {
    await expect(page.getByTestId(`overview-donut-${id}`)).toBeVisible();
  }
});

test('@smoke tracked and untracked donuts render their distinct states', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  // tokens is the only real resource — its center shows the fleet pool with its unit.
  await expect(page.getByTestId('overview-donut-tokens')).toContainText('12.4M');

  for (const id of UNTRACKED_IDS) {
    await expect(page.getByTestId(`overview-donut-${id}`)).toContainText('Not tracked yet');
  }
});

test('@smoke overview shows the Resources breadcrumb', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  await expect(page.getByTestId('app-breadcrumbs')).toContainText('Resources');
});

test('@smoke overview shows the empty state until a project is selected', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  await expect(page.getByTestId('overview-breakdown-empty')).toBeVisible();
  await expect(page.getByTestId('overview-breakdown-panel')).toHaveCount(0);
});

test('@smoke selecting a project chip opens its breakdown panel', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');
  await expect(page.getByTestId('overview-breakdown-empty')).toBeVisible();

  await page.getByTestId('overview-chip-proj-parser').click();

  const panel = page.getByTestId('overview-breakdown-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('overview-breakdown-empty')).toHaveCount(0);
  await expect(panel.getByText('Document Parser')).toBeVisible();

  for (const id of DONUT_IDS) {
    await expect(page.getByTestId(`overview-bar-${id}`)).toBeVisible();
  }

  // Untracked resources render an explicit not-tracked bar; the tokens bar carries a real share.
  await expect(page.getByTestId('overview-bar-gpu')).toContainText('—');
  await expect(page.getByTestId('overview-bar-tokens')).toContainText('%');
});

test('@smoke closing the panel via × restores the empty state', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  await page.getByTestId('overview-chip-proj-parser').click();
  await expect(page.getByTestId('overview-breakdown-panel')).toBeVisible();

  await page.getByTestId('overview-breakdown-close').click();

  await expect(page.getByTestId('overview-breakdown-panel')).toHaveCount(0);
  await expect(page.getByTestId('overview-breakdown-empty')).toBeVisible();
});

test('@smoke re-clicking the active chip toggles the panel back off', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  const chip = page.getByTestId('overview-chip-proj-parser');

  await chip.click();
  await expect(page.getByTestId('overview-breakdown-panel')).toBeVisible();

  await chip.click();
  await expect(page.getByTestId('overview-breakdown-panel')).toHaveCount(0);
  await expect(page.getByTestId('overview-breakdown-empty')).toBeVisible();
});

test('@smoke range toggle updates the hero subtitle', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');

  const hero = page.getByTestId('overview-hero');
  await expect(hero).toContainText('last 24 hours');

  await page.getByTestId('overview-range-toggle').getByText('Last 7d').click();

  await expect(hero).toContainText('last 7 days');
});

test('@smoke project chips are keyboard-operable', async ({ page }) => {
  await mockOverview(page, OVERVIEW_FIXTURE);
  await page.goto('/resources');
  await expect(page.getByTestId('overview-breakdown-empty')).toBeVisible();

  const chip = page.getByTestId('overview-chip-proj-parser');
  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press('Enter');

  await expect(page.getByTestId('overview-breakdown-panel')).toBeVisible();
  await expect(
    page.getByTestId('overview-breakdown-panel').getByText('Document Parser')
  ).toBeVisible();
});

test('@smoke overview shows a friendly empty state when no projects exist', async ({ page }) => {
  await mockOverview(page, { ...OVERVIEW_FIXTURE, projects: [] });
  await page.goto('/resources');

  await expect(page.getByTestId('overview-empty')).toBeVisible();
  await expect(page.getByTestId('overview-kpi-band')).toHaveCount(0);
});

test('overview surfaces an error with retry when the fetch fails', async ({ page }) => {
  await page.route(OVERVIEW_ROUTE, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'internal', message: 'boom' }),
    })
  );
  await page.goto('/resources');

  await expect(page.getByTestId('overview-error')).toBeVisible();
  await expect(page.getByTestId('overview-retry')).toBeVisible();
});
