import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ID,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployWorkflows,
  mockProjectDetail,
  PROJECT_ID,
  RUNNING_FRAMES,
  sseBody,
  SUCCESS_FRAMES,
} from './helpers/deploy';

const statusUrl = `/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}`;

// Frames the resumed connection replays after the drop — the tail of the run, picking up from the
// last seq the first connection delivered.
const RESUME_FRAMES = SUCCESS_FRAMES.slice(RUNNING_FRAMES.length);

test('surfaces a reconnect notice when the stream drops, then resumes and finishes', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeployWorkflows(page);
  // In-flight at load, so the machine opens the stream to follow the run live.
  await mockDeployInfo(page, { status: 'pending' });

  // Behaviour keys off `last-event-id` (the resume header the reader sends), not a call counter, so
  // it stays correct across the client's own reconnects and dev StrictMode's throwaway first mount:
  //   - a fresh connection (no resume header) delivers the run partway, then closes;
  //   - every reconnect drops until the test recovers it, so the notice stays put deterministically;
  //   - once recovered, the reconnect streams the tail through to success.
  let recovered = false;
  await page.route(
    (url) => /\/deploy\/[^/]+\/stream$/.test(url.pathname),
    (route) => {
      const resumeFrom = route.request().headers()['last-event-id'];
      if (!resumeFrom) {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody(RUNNING_FRAMES),
        });
      }
      if (!recovered) {
        return route.abort('connectionreset');
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(RESUME_FRAMES),
      });
    }
  );

  await page.goto(statusUrl);

  // Progress advanced from the first connection and is held across the gap.
  await expect(page.getByTestId('deploy-stage-processing_files')).toHaveAttribute(
    'data-status',
    'active'
  );

  const reconnecting = page.getByTestId('deploy-stream-reconnecting');
  await expect(reconnecting).toBeVisible();

  // Recover the transport; the next reconnect resumes from the last seq and finishes the run.
  recovered = true;

  await expect(reconnecting).toBeHidden();
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-endpoint')).toContainText('request-router.example.com');
});
