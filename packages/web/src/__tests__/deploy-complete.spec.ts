import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ADDRESS,
  DEPLOY_ID,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployStream,
  mockDeployTest,
  mockDeployWorkflows,
  mockProjectDetail,
  PROJECT_ID,
  SUCCESS_FRAMES,
} from './helpers/deploy';

const resourceIds = ['compute', 'network', 'database', 'llm', 'harness'] as const;

const statusUrl = `/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}`;

const isStreamRequest = (url: string) => /\/deploy\/[^/]+\/stream$/.test(new URL(url).pathname);

test.beforeEach(async ({ page }) => {
  // Real signed session plus the project detail, deploy config, and workflow list every complete
  // view reads. Each test supplies its own deployment record (terminal or in-flight) to pick the
  // path into the summary.
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployWorkflows(page);
  await mockDeployConfig(page);
});

test('@smoke a successful deploy loads straight into the summary without opening the stream', async ({
  page,
}) => {
  // A `success` record renders the summary directly from its own fields — no skeleton→progress→
  // complete flash, and the stream is never touched. Any hit here fails the determinism guarantee.
  let streamRequests = 0;
  await page.route(
    (url) => isStreamRequest(url.href),
    (route) => {
      streamRequests += 1;
      return route.abort();
    }
  );
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  // The summary stays on the same status URL — it is a sub-view of the run, not its own route.
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));

  // Project name and setup name both come from the real deploy config.
  const hero = page.getByTestId('deploy-complete-hero');
  await expect(hero).toContainText('Request Router is live');
  await expect(hero).toContainText('AWS Setup Felipe');

  // The endpoint card renders the address carried by the deployment record.
  await expect(page.getByTestId('deploy-endpoint')).toContainText('request-router.example.com');
  await expect(
    page.getByTestId('deploy-endpoint').getByTestId('deploy-endpoint-copy')
  ).toContainText('Copy Endpoint');

  for (const id of resourceIds) {
    await expect(page.getByTestId(`deploy-resource-${id}`)).toBeVisible();
  }

  // The summary ends at the resource list: onward navigation is the header's and the sidebar's job.
  await expect(page.getByTestId('header-back-to-project')).toBeVisible();

  // The progress view never appeared, and the stream was never opened for a terminal deploy.
  await expect(page.getByTestId('deploy-progress-screen')).toHaveCount(0);
  expect(streamRequests).toBe(0);
});

test('the status screen header returns to the project', async ({ page }) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await page.goto(statusUrl);
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();

  await page.getByTestId('header-back-to-project').click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`));
});

test('an in-flight deploy streams through progress to the completed summary', async ({ page }) => {
  // In-flight at load: the machine opens the stream and follows it to its `succeeded` frame, then
  // hands off to the summary.
  await mockDeployInfo(page, { status: 'pending' });
  await mockDeployStream(page, SUCCESS_FRAMES);

  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));

  // The endpoint card only renders because the `succeeded` frame carried an address.
  await expect(page.getByTestId('deploy-endpoint')).toContainText('request-router.example.com');
});

const QUERY = 'Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months';

const isTestRequest = (url: string) => /\/deploy\/[^/]+\/test$/.test(new URL(url).pathname);

test('the test panel posts the typed query and shows the raw response', async ({ page }) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployTest(page);
  await page.goto(statusUrl);

  await expect(page.getByTestId('deploy-test-panel')).toBeVisible();
  await expect(page.getByTestId('deploy-test-panel')).toContainText('Run a test to Request Router');
  await expect(page.getByTestId('deploy-test-response')).toHaveCount(0);

  await page.getByTestId('deploy-test-query-input').fill(QUERY);

  const [request] = await Promise.all([
    page.waitForRequest((req) => isTestRequest(req.url()) && req.method() === 'POST'),
    page.getByTestId('deploy-test-run').click(),
  ]);

  // The whole point of the feature: the typed text reaches the agent as its `query` field.
  expect(request.postDataJSON()).toEqual({ query: QUERY });

  const response = page.getByTestId('deploy-test-response');
  await expect(response).toBeVisible();
  await expect(response).toHaveAttribute('data-state', 'ok');
  await expect(response).toContainText('HTTP 200');
  await expect(response).toContainText('Use the reset link on the sign-in screen.');
});

test('a non-2xx endpoint response renders the test request as failed', async ({ page }) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await mockDeployTest(page, { status: 502, body: { error: 'upstream unavailable' } });
  await page.goto(statusUrl);

  await page.getByTestId('deploy-test-query-input').fill(QUERY);
  await page.getByTestId('deploy-test-run').click();

  const response = page.getByTestId('deploy-test-response');
  await expect(response).toBeVisible();
  await expect(response).toHaveAttribute('data-state', 'error');
  await expect(response).toContainText('HTTP 502');
  await expect(response).toContainText('upstream unavailable');
});

test('a failed test request stays runnable for the same query', async ({ page }) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  let calls = 0;
  await page.route(
    (url) => isTestRequest(url.href),
    (route) => {
      calls += 1;
      if (calls === 1) return route.fulfill({ status: 500, contentType: 'application/json' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 200, body: { answer: `answer-${calls}` } }),
      });
    }
  );
  await page.goto(statusUrl);

  await page.getByTestId('deploy-test-query-input').fill(QUERY);
  await page.getByTestId('deploy-test-run').click();

  await expect(page.getByTestId('deploy-test-response')).toContainText('Test request failed');
  await expect(page.getByTestId('deploy-test-run')).toBeEnabled();

  await page.getByTestId('deploy-test-run').click();
  await expect(page.getByTestId('deploy-test-response')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('deploy-test-run')).toBeDisabled();
  expect(calls).toBe(2);
});

test('Enter runs the test and respects the answered query the same way the button does', async ({
  page,
}) => {
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  let calls = 0;
  await page.route(
    (url) => isTestRequest(url.href),
    (route) => {
      calls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 200, body: { answer: `answer-${calls}` } }),
      });
    }
  );
  await page.goto(statusUrl);

  const queryInput = page.getByTestId('deploy-test-query-input');
  await queryInput.fill(QUERY);
  await queryInput.press('Enter');

  await expect(page.getByTestId('deploy-test-response')).toContainText('answer-1');
  await expect(page.getByTestId('deploy-test-run')).toBeDisabled();

  await queryInput.press('Enter');

  await queryInput.fill(`${QUERY} again`);
  await expect(page.getByTestId('deploy-test-run')).toBeEnabled();
  await queryInput.press('Enter');

  await expect(page.getByTestId('deploy-test-response')).toContainText('answer-2');
  expect(calls).toBe(2);
});

test('a blank query keeps the test request disabled', async ({ page }) => {
  let testRequests = 0;
  await page.route(
    (url) => isTestRequest(url.href),
    (route) => {
      testRequests += 1;
      return route.abort();
    }
  );
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });
  await page.goto(statusUrl);

  // The panel opens empty, and whitespace alone is not a query the agent can answer.
  const queryInput = page.getByTestId('deploy-test-query-input');
  await expect(queryInput).toHaveValue('');
  await expect(page.getByTestId('deploy-test-run')).toBeDisabled();

  await queryInput.fill('   ');
  await expect(page.getByTestId('deploy-test-run')).toBeDisabled();

  await queryInput.fill(QUERY);
  await expect(page.getByTestId('deploy-test-run')).toBeEnabled();

  await expect(page.getByTestId('deploy-test-response')).toHaveCount(0);
  expect(testRequests).toBe(0);
});
