// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { readStoredApiKey, setApiKey, storedApiKey, TEST_API_KEY } from './helpers/auth';
import {
  SELF_HOSTED_API_KEY,
  SELF_HOSTED_WORKFLOW,
  SELF_HOSTED_WORKFLOW_NAME,
} from './helpers/self-hosted';
import { expectPath } from './helpers/session';
import { SEEDED_WORKFLOW_NAME } from './helpers/workflows';

// A dashboard beside a Global Controller (self-host): the API found that controller's workflow
// group and its key as it started (`scripts/self-hosted-controller.ts`), with no `canyonos
// deploy` to register them. Nothing here is stubbed: the API answers every call.

const keyField = (page: Page) => page.getByTestId('auth-api-key');
const submit = (page: Page) => page.getByTestId('auth-submit');

test("the self-hosted workflow group's key signs in and opens its workflow, and no other", async ({
  page,
}) => {
  await page.goto('/login');

  await keyField(page).fill(SELF_HOSTED_API_KEY);
  await submit(page).click();

  await expectPath(page, '/workflows');
  const overview = page.getByTestId('workflows-overview');
  await expect(overview).toContainText(SELF_HOSTED_WORKFLOW_NAME);
  await expect(overview).not.toContainText(SEEDED_WORKFLOW_NAME);
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(SELF_HOSTED_API_KEY));

  await page.goto(`/workflows/${SELF_HOSTED_WORKFLOW}`);
  await expect(page.getByTestId('workflow-screen')).toBeVisible();
});

test("the seeded workflow groups' key does not see the self-hosted workflow", async ({ page }) => {
  await setApiKey(page, TEST_API_KEY);

  await page.goto('/workflows');

  const overview = page.getByTestId('workflows-overview');
  await expect(overview).toContainText(SEEDED_WORKFLOW_NAME);
  await expect(overview).not.toContainText(SELF_HOSTED_WORKFLOW_NAME);
});

test("a workflow of another workflow group is not found, and the session stays: the API's real 404 signs nobody out", async ({
  page,
}) => {
  await setApiKey(page, TEST_API_KEY);

  await page.goto(`/workflows/${SELF_HOSTED_WORKFLOW}`);

  await expect(page.getByTestId('workflow-layout-error')).toBeVisible();
  await expectPath(page, `/workflows/${SELF_HOSTED_WORKFLOW}`);
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  expect(await readStoredApiKey(page)).toEqual(storedApiKey(TEST_API_KEY));
  await page.goto('/workflows');
  await expectPath(page, '/workflows');
  await expect(page.getByTestId('workflows-overview')).toContainText(SEEDED_WORKFLOW_NAME);
});
