import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ID,
  FAILED_FRAMES,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployInfoNotFound,
  mockDeployStream,
  mockDeploySummary,
  mockDeployWorkflows,
  mockProjectDetail,
  PROJECT_ID,
  RUNNING_FRAMES,
} from './helpers/deploy';

const lifecycleStatuses = [
  'pending',
  'receiving_files',
  'processing_files',
  'provisioning_resources',
  'launching_resources',
  'success',
] as const;

const statusUrl = `/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}`;

const isStreamRequest = (url: string) => /\/deploy\/[^/]+\/stream$/.test(new URL(url).pathname);

test.beforeEach(async ({ page }) => {
  // Real signed session for the authenticated layout's /auth/profile; everything the deploy screens
  // read is mocked at the network boundary so each run is deterministic.
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummary(page);
  await mockDeployWorkflows(page);
});

test('@smoke deploy status streams an in-flight deploy into the progress view', async ({
  page,
}) => {
  // An in-flight record seeds the current status, then the machine opens the stream to follow it.
  await mockDeployInfo(page, { status: 'pending' });
  await mockDeployStream(page, RUNNING_FRAMES);

  const streamRequested = page.waitForRequest((request) => isStreamRequest(request.url()));
  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-progress-hero')).toContainText('Deploying Request Router');
  // Nothing to go back to yet — the way out appears once the run settles.
  await expect(page.getByTestId('header-back-to-project')).toHaveCount(0);

  const status = page.getByTestId('deploy-progress-status');
  await expect(status).toContainText('In progress');
  await expect(status).toHaveAttribute('data-phase', 'running');

  await expect(page.getByRole('progressbar')).toBeVisible();

  // The lifecycle renders exactly the backend deployment_status stages, in order.
  for (const stageStatus of lifecycleStatuses) {
    await expect(page.getByTestId(`deploy-stage-${stageStatus}`)).toBeVisible();
  }
  // The furthest streamed phase is the active stage.
  await expect(page.getByTestId('deploy-stage-processing_files')).toHaveAttribute(
    'data-status',
    'active'
  );

  // A running deploy exposes no footer actions (no cancel, no retry).
  await expect(page.getByTestId('deploy-progress-actions')).toHaveCount(0);
  // The summary is unreachable without a `succeeded` frame — a running stream never renders it.
  await expect(page.getByTestId('deploy-complete-screen')).toHaveCount(0);

  // An in-flight deploy is the only case that streams — confirm the stream was actually opened.
  await streamRequested;
});

test('a deploy already failed at load renders the failed view directly, without streaming', async ({
  page,
}) => {
  // A terminal record renders its outcome from the loaded fields — no stream is ever opened.
  let streamRequests = 0;
  await page.route(
    (url) => isStreamRequest(url.href),
    (route) => {
      streamRequests += 1;
      return route.abort();
    }
  );
  await mockDeployInfo(page, {
    status: 'failed',
    error: 'Resource provisioning was rejected by the provider.',
  });

  await page.goto(statusUrl);

  const status = page.getByTestId('deploy-progress-status');
  await expect(status).toHaveAttribute('data-phase', 'failed');
  await expect(status).toContainText('Failed');

  // The failure footer only appears on a failed run.
  await expect(page.getByTestId('deploy-progress-actions')).toBeVisible();

  const viewLogs = page.getByTestId('deploy-view-logs');
  await expect(viewLogs).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('deploy-error-log')).toBeHidden();
  await viewLogs.click();
  await expect(viewLogs).toHaveAttribute('aria-expanded', 'true');
  // "View logs" discloses the error carried by the deployment record.
  await expect(page.getByTestId('deploy-error-log')).toContainText(
    'Resource provisioning was rejected by the provider.'
  );

  const deployAgain = page.getByTestId('deploy-again');
  await expect(deployAgain).toHaveAttribute('href', `/projects/${PROJECT_ID}/deploy`);

  // The summary never renders, and a terminal deploy never opens the stream.
  await expect(page.getByTestId('deploy-complete-screen')).toHaveCount(0);
  expect(streamRequests).toBe(0);
});

test('a deploy that fails mid-stream marks the halted stage, discloses logs, and links to a fresh deploy', async ({
  page,
}) => {
  // In-flight at load, so the machine opens the stream and follows it to its `failed` frame.
  await mockDeployInfo(page, { status: 'pending' });
  await mockDeployStream(page, FAILED_FRAMES);
  await page.goto(statusUrl);

  const status = page.getByTestId('deploy-progress-status');
  await expect(status).toHaveAttribute('data-phase', 'failed');
  await expect(status).toContainText('Failed');

  // The phase that halted provisioning is marked failed; later stages stay queued.
  await expect(page.getByTestId('deploy-stage-provisioning_resources')).toHaveAttribute(
    'data-status',
    'failed'
  );
  await expect(page.getByTestId('deploy-stage-launching_resources')).toHaveAttribute(
    'data-status',
    'pending'
  );

  // The footer (error + actions) only appears on failure.
  await expect(page.getByTestId('deploy-progress-actions')).toBeVisible();

  const viewLogs = page.getByTestId('deploy-view-logs');
  await expect(viewLogs).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('deploy-error-log')).toBeHidden();
  await viewLogs.click();
  await expect(viewLogs).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('deploy-error-log')).toBeVisible();

  // "Deploy again" is a plain link back to the create screen — retry is a brand-new run, not an
  // in-place re-trigger.
  const deployAgain = page.getByTestId('deploy-again');
  await expect(deployAgain).toHaveAttribute('href', `/projects/${PROJECT_ID}/deploy`);
  await deployAgain.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy$`));
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
});

test('a deploy id that does not resolve renders the not-found view', async ({ page }) => {
  await mockDeployInfoNotFound(page);
  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-not-found')).toBeVisible();
  await expect(page.getByTestId('deploy-progress-screen')).toHaveCount(0);
  await expect(page.getByTestId('deploy-complete-screen')).toHaveCount(0);
});
