// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  stubFleetSpend,
  stubWorkflowDashboard,
  stubWorkflowsList,
  WORKFLOW,
} from './helpers/session';
import { apiBaseUrl, fulfillJson } from './helpers/workflows';

const apiOrigin = new URL(apiBaseUrl).origin;

test('a pending workflow read shows the shimmering logo until the workflow arrives', async ({
  page,
}) => {
  await authenticate(page);
  await stubWorkflowsList(page, [WORKFLOW]);
  await stubFleetSpend(page);
  await stubWorkflowDashboard(page, WORKFLOW);

  let releaseWorkflow!: () => void;
  const workflowGate = new Promise<void>((resolve) => {
    releaseWorkflow = resolve;
  });
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === `/v1/workflows/${WORKFLOW.id}`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await workflowGate;
      return fulfillJson(route, WORKFLOW);
    }
  );

  await page.goto(`/workflows/${WORKFLOW.id}`);

  const empty = page.getByTestId('empty-state');
  try {
    await expect(empty).toContainText('Loading workflow…');
    await expect(empty.getByTestId('empty-state-logo')).toHaveAttribute('data-loading', 'true');
  } finally {
    releaseWorkflow();
  }

  await expect(page.getByTestId('workflow-screen')).toBeVisible();
  await expect(empty).toHaveCount(0);
});
