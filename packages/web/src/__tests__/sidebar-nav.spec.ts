// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import type { WorkflowSummary } from '@canyonos/api/workflows';

import { authenticate } from './helpers/auth';
import {
  expectPath,
  stubFleetSpend,
  stubWorkflowDashboard,
  stubWorkflowsList,
  WORKFLOW,
} from './helpers/session';
import { apiBaseUrl, failJson, fulfillJson } from './helpers/workflows';

test('account menu says it is signed in with an API key and logs out', async ({ page }) => {
  await authenticate(page);
  await page.goto('/workflows');

  const trigger = page.getByTestId('sidebar-user-menu');
  await trigger.click();
  await expect(page.getByTestId('sidebar-user-menu-content')).toBeVisible();
  await expect(page.getByTestId('sidebar-signed-in')).toHaveText('Signed in with an API key');
  await page.getByTestId('sidebar-logout').click();
  await expect(page).toHaveURL(/\/login/);
});

test('workflow navigation distinguishes loading, error, retry, and empty states', async ({
  page,
}) => {
  await authenticate(page);
  await stubFleetSpend(page);
  let releaseWorkflows!: () => void;
  const workflowsGate = new Promise<void>((resolve) => {
    releaseWorkflows = resolve;
  });
  let attempts = 0;

  const apiOrigin = new URL(apiBaseUrl).origin;
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/v1/workflows',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      attempts += 1;
      if (attempts === 1) {
        await workflowsGate;
        return failJson(route);
      }
      return fulfillJson(route, [] satisfies WorkflowSummary[]);
    }
  );

  await page.goto('/workflows');
  await expect(page.getByTestId('workflows-loading')).toBeVisible();
  releaseWorkflows();
  await expect(page.getByTestId('workflows-error')).toBeVisible();
  await page.getByTestId('workflows-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('workflows-empty')).toHaveText('No workflows on this machine yet.');
  expect(attempts).toBe(2);
});

test('@smoke workflow row opens Status in one click and the chevron folds it away', async ({
  page,
}) => {
  await authenticate(page);
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);
  const row = page.getByTestId(`nav-workflow-${WORKFLOW.id}`);
  const toggle = page.getByTestId(`nav-workflow-toggle-${WORKFLOW.id}`);
  const status = page.getByTestId(`nav-workflow-status-${WORKFLOW.id}`);

  await page.goto('/workflows');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expectPath(page, `/workflows/${WORKFLOW.id}/status`);
  await expect(page.getByTestId('status-screen')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(status).toHaveAttribute('aria-current', 'page');

  // Folding is the chevron's job and must not navigate away from Status.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(status).toHaveCount(0);
  await expectPath(page, `/workflows/${WORKFLOW.id}/status`);

  await row.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('the selected time range carries from page to page', async ({ page }) => {
  await authenticate(page);
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);

  await page.goto(`/workflows/${WORKFLOW.id}`);
  const thirty_days = page
    .getByTestId('workflow-window-toggle')
    .getByRole('radio', { name: '30 days' });
  await thirty_days.click();
  await expect(page).toHaveURL(/[?&]range=30d\b/);

  await page.getByTestId(`nav-workflow-logs-${WORKFLOW.id}`).click();
  await expectPath(page, `/workflows/${WORKFLOW.id}/logs`);
  await expect(thirty_days).toHaveAttribute('data-state', 'on');

  // Status has no range control of its own, and must not drop the range on the way through.
  await page.getByTestId(`nav-workflow-status-${WORKFLOW.id}`).click();
  await expectPath(page, `/workflows/${WORKFLOW.id}/status`);
  await page.getByTestId(`nav-workflow-monitoring-${WORKFLOW.id}`).click();
  await expectPath(page, `/workflows/${WORKFLOW.id}/monitoring`);
  await expect(thirty_days).toHaveAttribute('data-state', 'on');
});

test('Monitoring and Configuration are dropdowns, open only where the current page is', async ({
  page,
}) => {
  await authenticate(page);
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);

  await page.goto(`/workflows/${WORKFLOW.id}`);

  const monitoring = page.getByRole('group', { name: 'Monitoring' });
  const configuration = page.getByRole('group', { name: 'Configuration' });
  for (const slug of ['manage', 'monitoring', 'logs', 'errors', 'metrics']) {
    await expect(monitoring.getByTestId(`nav-workflow-${slug}-${WORKFLOW.id}`)).toBeVisible();
  }
  const prompts = configuration.getByTestId(`nav-workflow-prompts-${WORKFLOW.id}`);
  await expect(prompts).toHaveCount(0);

  await page.getByRole('button', { name: 'Configuration' }).click();
  await expect(prompts).toBeVisible();
  await expect(configuration.getByTestId(`nav-workflow-scaling-${WORKFLOW.id}`)).toBeVisible();

  await page.getByRole('button', { name: 'Monitoring' }).click();
  await expect(monitoring.getByTestId(`nav-workflow-logs-${WORKFLOW.id}`)).toHaveCount(0);
});

test('the Configuration dropdown opens and closes from the keyboard', async ({ page }) => {
  await authenticate(page);
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubWorkflowDashboard(page, WORKFLOW);
  await stubFleetSpend(page);

  await page.goto(`/workflows/${WORKFLOW.id}`);

  const trigger = page.getByRole('button', { name: 'Configuration' });
  const prompts = page.getByTestId(`nav-workflow-prompts-${WORKFLOW.id}`);
  await expect(page.getByTestId(`nav-workflow-manage-${WORKFLOW.id}`)).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(prompts).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(prompts).toBeFocused();

  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(prompts).toHaveCount(0);
});
