// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { FleetOverview, FleetWorkflow } from '@canyonos/api/resources';
import type { WorkflowSummary } from '@canyonos/api/workflows';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/workflows';

const apiOrigin = new URL(apiBaseUrl).origin;

async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

async function mockWorkflowsList(page: Page, workflows: WorkflowSummary[]): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/v1/workflows',
    (route) =>
      route.request().method() === 'GET' ? fulfillJson(route, workflows) : route.continue()
  );
}

/** The range-scoped rollup the rows read their spend figures from. */
async function mockFleetSpend(page: Page, workflows: FleetWorkflow[]): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/v1/resources/overview',
    (route) =>
      route.request().method() === 'GET'
        ? fulfillJson(route, {
            kpis: [],
            resources: [],
            workflows,
            from: new URL(route.request().url()).searchParams.get('from') ?? '',
            to: new URL(route.request().url()).searchParams.get('to') ?? '',
          } satisfies FleetOverview)
        : route.continue()
  );
}

function fleetFixture(id: string, cost: number, requests: number): FleetWorkflow {
  return {
    id,
    name: 'ignored by the row, which reads the workflow record for its name',
    color_index: 0,
    cost,
    requests,
    avg_latency_ms: 210,
    error_rate_pct: 0,
    resource_usage: [],
  };
}

const WORKFLOW_A = '11111111-1111-4111-8111-1111111111a1';

function workflowFixture(id: string, name: string): WorkflowSummary {
  return {
    id,
    name,
    workflow_group_id: null,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
  };
}

test('@smoke authenticated home redirects to the workflows overview', async ({ page }) => {
  await authenticate(page);
  await page.goto('/');

  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toBeVisible();
});

test('workflows overview empty state states the fact without offering an import', async ({
  page,
}) => {
  await authenticate(page);
  await mockWorkflowsList(page, []);
  await page.goto('/workflows');

  const empty = page.getByTestId('workflows-overview-empty');
  await expect(empty).toContainText('No workflows on this machine yet.');
  await expect(empty.getByRole('link')).toHaveCount(0);
});

test('workflows overview list fits short workflow lists instead of filling the viewport', async ({
  page,
}) => {
  await authenticate(page);
  await mockWorkflowsList(page, [workflowFixture(WORKFLOW_A, 'Portfolio')]);
  await page.goto('/workflows');

  const list = page.getByTestId('workflows-overview-list');
  await expect(list).toBeVisible();

  const listBox = await list.boundingBox();
  const rowBox = await page
    .getByTestId(`workflows-overview-workflow-${WORKFLOW_A}`)
    .locator('..')
    .boundingBox();

  if (!listBox || !rowBox) throw new Error('Workflow overview list layout was not measurable.');
  expect(listBox.height).toBeLessThan(rowBox.height + 16);
});

test('a workflow row opens its Status', async ({ page }) => {
  await authenticate(page);
  await mockWorkflowsList(page, [workflowFixture(WORKFLOW_A, 'Fraud Screen')]);

  await page.goto('/workflows');

  await expect(page.getByTestId(`workflows-overview-workflow-${WORKFLOW_A}`)).toHaveAttribute(
    'href',
    `/workflows/${WORKFLOW_A}/status`
  );
});

test('each workflow row carries its queries, spend and cost per query', async ({ page }) => {
  await authenticate(page);
  await mockWorkflowsList(page, [workflowFixture(WORKFLOW_A, 'Alpha')]);
  await mockFleetSpend(page, [fleetFixture(WORKFLOW_A, 31.5, 1_260)]);

  await page.goto('/workflows');

  const row = page.getByTestId(`workflows-overview-workflow-${WORKFLOW_A}`);
  await expect(row).toContainText('1,260');
  await expect(row).toContainText('queries');
  await expect(row).toContainText('$31.50');
  // $31.50 over 1,260 queries, at the same two decimals the ribbon uses.
  await expect(row).toContainText('$0.03');
  await expect(row).toContainText('per query');
});

test('a workflow that has never run shows no cost per query to divide', async ({ page }) => {
  await authenticate(page);
  await mockWorkflowsList(page, [workflowFixture(WORKFLOW_A, 'Alpha')]);
  await mockFleetSpend(page, [fleetFixture(WORKFLOW_A, 0, 0)]);

  await page.goto('/workflows');

  const row = page.getByTestId(`workflows-overview-workflow-${WORKFLOW_A}`);
  // Figure and label are separate spans held apart by a flex gap, so the row text runs them together.
  await expect(row).toContainText(/0\s*queries/);
  await expect(row).not.toContainText('per query');
});

test('the row still reads when the spend rollup fails', async ({ page }) => {
  await authenticate(page);
  await mockWorkflowsList(page, [workflowFixture(WORKFLOW_A, 'Alpha')]);
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/v1/resources/overview',
    (route) => route.fulfill({ status: 500, body: '{}' })
  );

  await page.goto('/workflows');

  // Spend is decoration: losing it drops the figures rather than the list.
  const row = page.getByTestId(`workflows-overview-workflow-${WORKFLOW_A}`);
  await expect(row).toContainText('Alpha');
  await expect(row).not.toContainText('queries');
});
