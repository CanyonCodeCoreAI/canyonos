import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ADDRESS,
  DEPLOY_ID,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployStop,
  mockDeployStopConflict,
  mockDeployStream,
  mockDeployStreamSequence,
  mockDeployWorkflows,
  mockProjectDetail,
  PROJECT_ID,
  STOP_FAILED_FRAMES,
  STOP_FAILED_REASON,
  STOPPED_FRAMES,
  STOPPED_UNVERIFIED_FRAMES,
  STOPPING_DROPPED_FRAMES,
  UNVERIFIED_REASON,
} from './helpers/deploy';

const statusUrl = `/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}`;

test.beforeEach(async ({ page }) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployWorkflows(page);
  await mockDeployConfig(page);
});

test('@smoke stopping a live deployment confirms, follows the teardown, and lands on the stopped view', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  const stop = await mockDeployStop(page);
  await mockDeployStream(page, STOPPED_FRAMES);

  await page.goto(statusUrl);
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();

  await page.getByTestId('deploy-stop').click();
  await expect(page.getByTestId('deploy-stop-dialog')).toBeVisible();
  expect(stop.calls()).toBe(0);

  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-redeploy')).toBeVisible();
  expect(stop.calls()).toBe(1);
});

test('a teardown stream that drops mid-stop reconnects and still reaches the stopped view', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployStop(page);
  // The first connection ends without a terminal frame; the reconnect carries the teardown home.
  await mockDeployStreamSequence(page, [STOPPING_DROPPED_FRAMES, STOPPED_FRAMES]);

  await page.goto(statusUrl);
  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
});

test('cancelling the confirmation leaves the deployment running and sends nothing', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  const stop = await mockDeployStop(page);

  await page.goto(statusUrl);
  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-cancel').click();

  await expect(page.getByTestId('deploy-stop-dialog')).toBeHidden();
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stop')).toBeEnabled();
  expect(stop.calls()).toBe(0);
});

test('a rejected stop surfaces the reason and keeps the summary usable', async ({ page }) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployStopConflict(page);

  await page.goto(statusUrl);
  await expect(page.getByTestId('deploy-complete-hero').getByTestId('deploy-stop')).toBeVisible();
  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('app-toast')).toHaveText('This deployment is no longer running.');
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stop')).toBeEnabled();
});

test('a legacy deployment explains why it cannot be stopped', async ({ page }) => {
  await mockDeployInfo(page, {
    status: 'success',
    address: DEPLOY_ADDRESS,
    stop: {
      available: false,
      code: 'missing_controller_identity',
      message: 'This deployment predates Stop support. Deploy again before stopping it.',
    },
  });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-stop')).toBeDisabled();
  await page.getByTestId('deploy-stop-trigger').hover();
  await expect(page.getByTestId('deploy-stop-tooltip').first()).toContainText(
    'This deployment predates Stop support. Deploy again before stopping it.'
  );
});

test('a deployment already torn down loads straight into the stopped view', async ({ page }) => {
  await mockDeployInfo(page, { status: 'stopped' });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stop')).toBeHidden();
});

test('a teardown that fails keeps the deployment live and warns that instances may remain', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployStop(page);
  await mockDeployStream(page, STOP_FAILED_FRAMES);

  await page.goto(statusUrl);
  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-screen')).toBeHidden();
  await expect(page.getByTestId('deploy-stop-failed-notice')).toBeVisible();
  await expect(page.getByTestId('deploy-stop-failed-reason')).toHaveText(STOP_FAILED_REASON);

  await expect(page.getByTestId('deploy-stop')).toBeEnabled();
});

test('a deployment whose last stop failed warns again after a reload', async ({ page }) => {
  await mockDeployInfo(page, {
    status: 'success',
    address: DEPLOY_ADDRESS,
    stop_error: STOP_FAILED_REASON,
  });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-stop-failed-notice')).toBeVisible();
  await expect(page.getByTestId('deploy-stop-failed-reason')).toHaveText(STOP_FAILED_REASON);
});

test('retrying a stop clears the previous failure warning', async ({ page }) => {
  await mockDeployInfo(page, {
    status: 'success',
    address: DEPLOY_ADDRESS,
    stop_error: STOP_FAILED_REASON,
  });
  await mockDeployStop(page);
  await mockDeployStream(page, STOPPED_FRAMES);

  await page.goto(statusUrl);
  await expect(page.getByTestId('deploy-stop-failed-notice')).toBeVisible();

  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stop-failed-notice')).toBeHidden();
});

test('a teardown that could not confirm every instance says so on the stopped view', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployStop(page);
  await mockDeployStream(page, STOPPED_UNVERIFIED_FRAMES);

  await page.goto(statusUrl);
  await page.getByTestId('deploy-stop').click();
  await page.getByTestId('deploy-stop-confirm').click();

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-unverified')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-unverified-reason')).toHaveText(UNVERIFIED_REASON);
});

test('an unverified teardown still warns after a reload', async ({ page }) => {
  await mockDeployInfo(page, { status: 'stopped', stop_error: UNVERIFIED_REASON });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-stopped-unverified')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-unverified-reason')).toHaveText(UNVERIFIED_REASON);
});

test('a clean teardown shows no warning', async ({ page }) => {
  await mockDeployInfo(page, { status: 'stopped' });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-stopped-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-stopped-unverified')).toBeHidden();
});
