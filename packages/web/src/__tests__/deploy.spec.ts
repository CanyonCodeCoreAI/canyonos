import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';

import type { DeploymentInfo } from '@cc-forge/api/deploy';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ID,
  deploymentInfo,
  deployWorkflowDesign,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployPreview,
  mockDeployStream,
  mockDeploySummary,
  mockDeploySummaryError,
  mockDeployTrigger,
  mockDeployTriggerConflict,
  mockDeployWorkflowDesign,
  mockDeployWorkflows,
  mockProjectDetail,
  PREVIEW_ADDED_FILE,
  PREVIEW_MODIFIED_FILE,
  PREVIEW_REMOVED_FILE,
  previewFirstDeploy,
  previewNoChanges,
  previewWithAllChanges,
  PROJECT_ID,
  RUNNING_FRAMES,
  setScalingPlan,
  WORKFLOW_ID,
} from './helpers/deploy';
import {
  apiBaseUrl,
  canonicalDeployPath,
  canonicalDesignPath,
  createProject,
  failJson,
  fulfillJson,
  isApiRequest,
  projectPath,
  projectStatus,
  workflowByPath,
  workflowDesign,
} from './helpers/projects';

type TestPage = Parameters<typeof authenticate>[0];

const apiOrigin = new URL(apiBaseUrl).origin;

const previewUrl = `/projects/${PROJECT_ID}/deploy/preview`;

/** The fleet arrives collapsed behind its Edit pill. */
async function openStartingConfig(page: TestPage) {
  await page.getByTestId('deploy-starting-config-toggle').click();
}

// The deploy trigger is the only POST to the bare `/deploy` path; the preview GET and the config GET
// live under different suffixes, so this matcher counts exactly the confirm-driven deploy.
function isDeployTriggerPost(request: Request): boolean {
  const url = new URL(request.url());
  return (
    request.method() === 'POST' && url.origin === apiOrigin && url.pathname.endsWith('/deploy')
  );
}

function countDeployTriggers(page: TestPage): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (isDeployTriggerPost(request)) count += 1;
  });
  return () => count;
}

async function expectExactPath(page: TestPage, expected: string) {
  await expect
    .poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
    .toBe(expected);
}

test('UUID-backed project deploy renders system-owned config and enabled submit', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  await page.goto(canonicalDeployPath(fixture.project.id));

  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-hero')).toContainText(
    `Set scaling policy for ${fixture.project.name}`
  );
  await expect(page.getByTestId('deploy-scaling-plan-card')).toBeVisible();

  // Nothing below the load exists until the load is answered.
  await expect(page.getByTestId('deploy-plan-choices')).toHaveCount(0);

  await page.getByTestId('deploy-expected-load').fill('120');
  await expect(page.getByTestId('deploy-plan-choices')).toBeVisible();
  // The compute choices wait for the slider, one reveal later.
  await expect(page.getByTestId('deploy-plan-targets')).toHaveCount(0);
  await page.getByTestId('deploy-priority').click();
  await expect(page.getByTestId('deploy-plan-targets')).toBeVisible();

  const providerSelect = page.getByTestId('deploy-provider-select');
  await expect(providerSelect).toContainText('AWS');
  await expect(providerSelect).toBeEnabled();

  await providerSelect.click();
  const lockedProvider = page.getByTestId('deploy-provider-option-2');
  await expect(lockedProvider).toContainText('GCP');
  await expect(lockedProvider).toContainText('coming soon');
  await expect(lockedProvider).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  await expect(page.locator('[data-testid^="deploy-field-input-"]')).toHaveCount(0);
  await expect(page.getByTestId('deploy-pem-uploader')).toHaveCount(0);

  // A freshly created project has never deployed, so setting the policy carries it on to the
  // emulation on its own rather than waiting to be asked.
  await page.getByTestId('deploy-plan-set').click();
  // The answers travel with it, so the path is the end of the match and not the URL.
  await expect(page).toHaveURL(
    new RegExp(`${canonicalDeployPath(fixture.project.id)}/performance\\?`)
  );
});

test('the upload flow hands policy to emulation, and deploys the fleet it works out', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page, { has_previous_deploy: false });
  await mockDeploySummary(page);
  await mockDeployTrigger(page, DEPLOY_ID);
  await mockDeployInfo(page, { status: 'pending' });
  await mockDeployStream(page, RUNNING_FRAMES);
  await mockDeployWorkflows(page);
  await mockDeployWorkflowDesign(page);
  const deployTriggers = countDeployTriggers(page);

  await page.goto(`/projects/${PROJECT_ID}/deploy`);
  // Setting the policy hands over on its own. The emulation loops, and deploy waits for it to work
  // out a fleet rather than being offered against nothing.
  await setScalingPlan(page, PROJECT_ID);
  await expect(page.getByTestId('emulation-deploy')).toBeDisabled();
  expect(deployTriggers()).toBe(0);

  // The fleet appears once the run has settled, folded away, and deploy opens with it.
  await expect(page.getByTestId('emulation-fleet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('emulation-deploy')).toBeEnabled();
  await expect(page.getByTestId('deploy-starting-config-input-max_cpu_instances')).toHaveCount(0);
  await page.getByTestId('emulation-fleet-toggle').click();
  await expect(page.getByTestId('emulation-fleet')).toContainText('Max CPU instances');

  await page.getByTestId('emulation-deploy').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));
  expect(deployTriggers()).toBe(1);
});

test('an emulation is open to a deployed project, without a next step to be sent to', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummary(page, { latest: deploymentInfo({ status: 'success' }), active: null });
  await mockDeployWorkflows(page);
  await mockDeployWorkflowDesign(page);

  await page.goto(`/projects/${PROJECT_ID}/deploy/performance`);
  await expect(page.getByTestId('deploy-performance-screen')).toBeVisible();

  // The emulation is the screen for every project; only the flow has somewhere to continue to.
  await expect(page.getByTestId('emulation-policy')).toBeVisible();
  await expect(page.getByTestId('deploy-emulation-continue')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/performance$`));
});

test('the emulation runs the policy it was handed, and Reset undoes an edit to it', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page, { has_previous_deploy: false });
  await mockDeploySummary(page);
  await mockDeployWorkflows(page);
  await mockDeployWorkflowDesign(page);

  await page.goto(`/projects/${PROJECT_ID}/deploy`);
  await page.getByTestId('deploy-expected-load').fill('240');
  await page.getByTestId('deploy-priority').click();
  await page.getByTestId('deploy-plan-set').click();

  // The answers travel in the URL, so the emulation runs what was just set.
  await expect(page).toHaveURL(/load=240/);
  await expect(page.getByTestId('emulation-policy-load')).toHaveValue('240');
  // Nothing to put back yet.
  await expect(page.getByTestId('emulation-policy-reset')).toBeDisabled();

  await page.getByTestId('emulation-policy-load').fill('600');
  await expect(page.getByTestId('emulation-policy-reset')).toBeEnabled();
  await page.getByTestId('emulation-policy-reset').click();
  await expect(page.getByTestId('emulation-policy-load')).toHaveValue('240');
});

// A project reaches the emulation straight off an import, before its design exists. The screen used
// to ask for the design anyway, take the refusal as "this project has no workflow", and stay there.
test('the emulation waits out a design still being generated, and runs it once it is ready', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page, { has_previous_deploy: false });
  await mockDeploySummary(page);
  await mockDeployWorkflowDesign(page);

  let design_requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/design')) design_requests += 1;
  });

  let ready = false;
  await page.route(
    (url) => url.pathname.endsWith('/workflows'),
    (route) =>
      fulfillJson(route, [
        {
          id: WORKFLOW_ID,
          project_id: PROJECT_ID,
          source_file_id: WORKFLOW_ID,
          source_path: 'workflow.py',
          updated_at: '2026-07-01T12:00:00.000Z',
          status: ready ? 'READY' : 'GENERATING',
        },
      ])
  );

  await page.goto(`/projects/${PROJECT_ID}/deploy/performance`);
  await expect(page.getByTestId('deploy-emulation-generating')).toBeVisible();
  await expect(page.getByTestId('deploy-emulation-empty')).toHaveCount(0);
  expect(design_requests).toBe(0);

  // The screen keeps asking, so the design it could not have on arrival is picked up on its own.
  ready = true;
  await expect(page.getByTestId('emulation-stage')).toBeVisible();
  await expect(page.getByTestId('deploy-emulation-generating')).toHaveCount(0);
});

test('a design that fails to load offers a retry rather than reading as no workflow', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page, { has_previous_deploy: false });
  await mockDeploySummary(page);
  await mockDeployWorkflows(page);

  let fail = true;
  await page.route(
    (url) => url.pathname.endsWith(`/workflows/${WORKFLOW_ID}/design`),
    (route) => (fail ? failJson(route) : fulfillJson(route, deployWorkflowDesign()))
  );

  await page.goto(`/projects/${PROJECT_ID}/deploy/performance`);
  await expect(page.getByTestId('deploy-emulation-design-error')).toBeVisible();
  await expect(page.getByTestId('deploy-emulation-empty')).toHaveCount(0);

  fail = false;
  await page.getByTestId('deploy-emulation-design-error').getByRole('button').click();
  await expect(page.getByTestId('emulation-stage')).toBeVisible();
});

// A million requests a second is a policy a reader may state, and it used to be fifty thousand
// objects built in a single 50ms step: the tab stopped answering before it drew anything.
test('a load past what a pane can draw is sampled, and the screen keeps running', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page, { has_previous_deploy: false });
  await mockDeploySummary(page);
  await mockDeployWorkflows(page);
  await mockDeployWorkflowDesign(page);

  await page.goto(
    `/projects/${PROJECT_ID}/deploy/performance?load=1000000&unit=second&priority=50&endpoint=bedrock`
  );

  await expect(page.getByTestId('emulation-stage')).toBeVisible();
  // The run reaching a fleet is the frame loop still turning, which is what the load used to stop.
  await expect(page.getByTestId('emulation-fleet')).toBeVisible({ timeout: 15_000 });

  const drawn = await page.getByTestId('emulation-lane-traditional').locator('svg circle').count();
  expect(drawn).toBeLessThan(300);
});

test('@smoke the deploy config route hands off to the deploy already running', async ({ page }) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummary(page, {
    latest: null,
    active: deploymentInfo({ status: 'receiving_files' }),
  });
  await mockDeployInfo(page, { status: 'receiving_files' });
  await mockDeployStream(page, RUNNING_FRAMES);

  await page.goto(`/projects/${PROJECT_ID}/deploy`);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));
  await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-screen')).toHaveCount(0);
});

test('a summary the config screen cannot read still leaves a usable config screen', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummaryError(page);
  let summaryReads = 0;
  page.on('request', (request: Request) => {
    if (request.url().endsWith('/deploy/summary')) summaryReads += 1;
  });

  await page.goto(`/projects/${PROJECT_ID}/deploy`);

  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-loading')).toHaveCount(0);

  // Answered but not set, so the screen is still the one under test: setting the policy would hand
  // over to the emulation, and this is about the config screen surviving a summary it cannot read.
  await page.getByTestId('deploy-expected-load').fill('120');
  await page.getByTestId('deploy-priority').click();
  await expect(page.getByTestId('deploy-plan-set')).toBeEnabled();

  // A read retried for the header controls would drop the screen back to its skeleton and loop.
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-loading')).toHaveCount(0);
  expect(summaryReads).toBe(1);
});

test('a deploy that starts while the config screen is open hands the reader to the run', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  // Idle while the reader configures, running by the time the tab is looked at again: a deploy
  // started from another tab takes over rather than leaving a second deploy on offer here.
  await mockDeploySummary(
    page,
    { latest: null, active: null },
    { latest: null, active: null },
    { latest: null, active: deploymentInfo({ status: 'processing_files' }) }
  );
  await mockDeployInfo(page, { status: 'processing_files' });
  await mockDeployStream(page, RUNNING_FRAMES);
  const deployTriggers = countDeployTriggers(page);

  await page.goto(`/projects/${PROJECT_ID}/deploy`);
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  // Left on the policy screen on purpose: this is about the summary re-read, not about the hand-off.
  await page.getByTestId('deploy-expected-load').fill('120');

  // Returning to the tab is what re-reads the summary while the plan sits unanswered.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));
  await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-screen')).toHaveCount(0);
  expect(deployTriggers()).toBe(0);
});

test('project and workflow actions stay in the canonical project deploy route', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/${root.id}/design`, (route) =>
    isApiRequest(route) ? fulfillJson(route, workflowDesign(root)) : route.continue()
  );

  await page.goto(projectPath(fixture.project));
  await page.getByTestId('header-project-deploy').click();
  await expectExactPath(page, canonicalDeployPath(fixture.project.id));
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  // Before anything is deployed the header carries only the deploy action; the sidebar is the way
  // back to the project.
  await expect(page.getByTestId('header-back-to-project')).toHaveCount(0);
  await page.getByTestId(`nav-project-manage-${fixture.project.id}`).click();
  await expectExactPath(page, projectPath(fixture.project));

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('workflow-design')).toBeVisible();
  await expect(page.getByTestId('header-back-to-project')).toHaveCount(0);
  await page.getByTestId('header-project-deploy').click();
  await expectExactPath(page, canonicalDeployPath(fixture.project.id));
  await page.getByTestId(`nav-project-manage-${fixture.project.id}`).click();
  await expectExactPath(page, projectPath(fixture.project));
});

test('a successfully deployed project keeps the live status and offers another deploy', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const deployment: DeploymentInfo = {
    id: DEPLOY_ID,
    project_id: fixture.project.id,
    status: 'success',
    address: 'https://request-router.example.com',
    error: null,
    stop_error: null,
    stop: { available: true, code: 'available', message: null },
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:05:00.000Z',
  };

  await page.route(`**/projects/${fixture.project.id}/deploy/summary`, (route) =>
    fulfillJson(route, { latest: deployment, active: null })
  );
  await page.goto(projectPath(fixture.project));

  await expect(page.getByTestId('project-deploy-status')).toContainText('Live');
  await expect(page.getByTestId('header-project-latest-deploy')).toBeVisible();
  // A live project re-deploys over the running instance rather than deploying fresh.
  await expect(page.getByTestId('header-project-deploy')).toContainText('Re-deploy');

  // A live project shows its agent address with a copy button beside the status badge.
  const endpoint = page.getByTestId('project-deploy-endpoint');
  await expect(endpoint).toContainText('request-router.example.com');
  await expect(endpoint.getByTestId('project-deploy-endpoint-copy')).toBeVisible();

  // The cost ribbon no longer renders an empty title row above the KPI cards.
  await expect(page.getByTestId('project-cost-ribbon').locator('h2')).toHaveCount(0);
});

test('a project with no live deployment offers a plain Deploy', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const stopped: DeploymentInfo = {
    id: DEPLOY_ID,
    project_id: fixture.project.id,
    status: 'stopped',
    address: null,
    error: null,
    stop_error: null,
    stop: { available: false, code: 'not_live', message: null },
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:05:00.000Z',
  };

  await page.route(`**/projects/${fixture.project.id}/deploy/summary`, (route) =>
    fulfillJson(route, { latest: stopped, active: null })
  );
  await page.goto(projectPath(fixture.project));

  await expect(page.getByTestId('header-project-deploy')).toHaveText('Deploy');
});

test('header actions keep one spacing however many the screen carries', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  const deployment: DeploymentInfo = {
    id: DEPLOY_ID,
    project_id: fixture.project.id,
    status: 'success',
    address: 'https://request-router.example.com',
    error: null,
    stop_error: null,
    stop: { available: true, code: 'available', message: null },
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:05:00.000Z',
  };

  await page.route(`**/projects/${fixture.project.id}/deploy/summary`, (route) =>
    fulfillJson(route, { latest: deployment, active: null })
  );
  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/${root.id}/design`, (route) =>
    isApiRequest(route) ? fulfillJson(route, workflowDesign(root)) : route.continue()
  );

  const headerGaps = async (testids: readonly string[]) => {
    const boxes = await Promise.all(
      testids.map(async (testid) => (await page.getByTestId(testid).boundingBox())!)
    );
    return boxes
      .slice(1)
      .map((box, index) => Math.round(box.x - (boxes[index]!.x + boxes[index]!.width)));
  };

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('header-project-deploy')).toBeVisible();
  const design_gaps = await headerGaps(['header-project-latest-deploy', 'header-project-deploy']);

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-header-refresh')).toBeVisible();
  const overview_gaps = await headerGaps([
    'project-header-refresh',
    'header-project-latest-deploy',
    'header-project-deploy',
  ]);

  expect(new Set([...design_gaps, ...overview_gaps]).size).toBe(1);
});

test('deploy config failure has a dedicated retry and recovers', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  let attempts = 0;
  await page.route(`**/projects/${fixture.project.id}/deploy/config`, (route) => {
    attempts += 1;
    return attempts === 1 ? failJson(route) : route.continue();
  });

  await page.goto(canonicalDeployPath(fixture.project.id));
  await expect(page.getByTestId('deploy-config-error')).toBeVisible();
  await page.getByTestId('deploy-config-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  expect(attempts).toBe(2);
});

test('the deployment config screen opens on its fleet summary, with the fields behind Edit', async ({
  page,
}) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummary(page);

  await page.goto(`/projects/${PROJECT_ID}/deployment-config`);

  // Its own screen, so there is no analysis to follow: the fleet is there on arrival.
  const card = page.getByTestId('deploy-starting-config-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Starting Configuration');
  // Closed: the summary stands in for the fields until the Edit pill opens them.
  await expect(page.getByTestId('deploy-starting-config-summary')).toContainText('1\u20134 CPU');
  await expect(card).not.toContainText('min 1 \u00b7 max 10');

  await openStartingConfig(page);
  await expect(card).toContainText('min 1 \u00b7 max 10');

  await expect(page.getByTestId('deploy-starting-config-input-starting_cpu_instances')).toHaveValue(
    '1'
  );
  await expect(page.getByTestId('deploy-starting-config-input-starting_gpu_instances')).toHaveValue(
    '0'
  );
  await expect(page.getByTestId('deploy-starting-config-input-max_cpu_instances')).toHaveValue('4');
  await expect(page.getByTestId('deploy-starting-config-input-max_gpu_instances')).toHaveValue('1');

  // A cleared field summarises as its minimum, not NaN.
  await page.getByTestId('deploy-starting-config-input-starting_gpu_instances').fill('');
  await expect(page.getByTestId('deploy-starting-config-summary')).toContainText('0\u20131 GPU');
});

test('tabbing past the priority slider does not count as answering it', async ({ page }) => {
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployConfig(page);
  await mockDeploySummary(page);

  await page.goto(`/projects/${PROJECT_ID}/deploy`);
  await page.getByTestId('deploy-expected-load').fill('120');
  await expect(page.getByTestId('deploy-plan-choices')).toBeVisible();

  await page.getByTestId('deploy-priority').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('deploy-plan-targets')).toHaveCount(0);

  await page.getByTestId('deploy-priority').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('deploy-plan-targets')).toBeVisible();
});

test.describe('deploy preview flow', () => {
  test.beforeEach(async ({ page }) => {
    // Real signed session for the authenticated layout's /auth/profile; the project detail, deploy
    // config, workflows, and each screen's own data are mocked at the network boundary so the
    // config -> preview -> confirm -> status flow is deterministic regardless of ambient DB state.
    await authenticate(page);
    await mockProjectDetail(page);
    await mockDeployConfig(page);
    await mockDeploySummary(page);
    await mockDeployWorkflows(page);
    await mockDeployWorkflowDesign(page);
  });

  test('@smoke submitting the deploy config opens the preview and triggers no deploy', async ({
    page,
  }) => {
    // A preview is a diff against what is deployed, so this path belongs to a project that has
    // deployed before: that is what the emulation offers Review changes to rather than Deploy.
    await mockDeploySummary(page, { latest: deploymentInfo({ status: 'success' }), active: null });
    await mockDeployPreview(page, previewWithAllChanges());
    const deployTriggers = countDeployTriggers(page);

    await page.goto(`/projects/${PROJECT_ID}/deploy`);
    await expect(page.getByTestId('deploy-screen')).toBeVisible();

    await setScalingPlan(page, PROJECT_ID);
    await expect(page.getByTestId('emulation-review')).toContainText('Review changes');
    await page.getByTestId('emulation-review').click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/preview$`));
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();
    // The config submit is a pure navigation now — no deploy fires until the preview is confirmed.
    expect(deployTriggers()).toBe(0);
  });

  test('the preview pages through one changed file at a time with a position counter', async ({
    page,
  }) => {
    await mockDeployPreview(page, previewWithAllChanges());

    await page.goto(previewUrl);
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();

    const summary = page.getByTestId('deploy-preview-summary');
    await expect(summary).toContainText('1 added');
    await expect(summary).toContainText('1 removed');
    await expect(summary).toContainText('1 modified');

    // Only the current file is mounted; the others are reachable via the pager, not a scroll.
    const counter = page.getByTestId('deploy-preview-counter');
    await expect(counter).toContainText('File 1 of 3');
    await expect(page.locator('[data-testid^="deploy-preview-file-"]')).toHaveCount(1);
    await expect(page.getByTestId(`deploy-preview-file-${PREVIEW_ADDED_FILE.path}`)).toBeVisible();
    await expect(page.getByTestId('deploy-preview-prev')).toBeDisabled();

    await page.getByTestId('deploy-preview-next').click();

    await expect(counter).toContainText('File 2 of 3');
    const modified = page.getByTestId(`deploy-preview-file-${PREVIEW_MODIFIED_FILE.path}`);
    await expect(modified).toBeVisible();
    const table = modified.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'After' })).toBeVisible();

    // The single changed line renders side by side: the old text carries the `-` marker on the
    // Before side, the new text the `+` marker on the After side.
    const beforeCell = table.locator('td', { hasText: 'return request' });
    await expect(beforeCell).toContainText('-');
    await expect(beforeCell).toContainText('return request');
    const afterCell = table.locator('td', { hasText: 'return handoff(request)' });
    await expect(afterCell).toContainText('+');
    await expect(afterCell).toContainText('return handoff(request)');

    await page.getByTestId('deploy-preview-next').click();

    await expect(counter).toContainText('File 3 of 3');
    await expect(
      page.getByTestId(`deploy-preview-file-${PREVIEW_REMOVED_FILE.path}`)
    ).toBeVisible();
    await expect(page.getByTestId('deploy-preview-next')).toBeDisabled();

    await page.getByTestId('deploy-preview-prev').click();
    await expect(counter).toContainText('File 2 of 3');
    await expect(modified).toBeVisible();
  });

  // The config screen deploys a first-ever project directly, but the preview stays reachable by URL
  // (e.g. a deep link) and still explains that every file is new.
  test('the first deploy preview notes that every file is new', async ({ page }) => {
    await mockDeployPreview(page, previewFirstDeploy());

    await page.goto(previewUrl);

    const screen = page.getByTestId('deploy-preview-screen');
    await expect(screen).toContainText('This is the first deployment for this project.');
    await expect(screen).toContainText('Every file is new.');
    await expect(page.getByTestId('deploy-preview-summary')).toContainText('2 added');
    await expect(page.getByTestId('deploy-preview-counter')).toContainText('File 1 of 2');
    await expect(page.locator('[data-testid^="deploy-preview-file-"]')).toHaveCount(1);
  });

  test('a preview with no changes shows the empty note and still allows confirming', async ({
    page,
  }) => {
    await mockDeployPreview(page, previewNoChanges());

    await page.goto(previewUrl);

    await expect(page.getByTestId('deploy-preview-empty')).toBeVisible();
    await expect(page.getByTestId('deploy-preview-confirm')).toBeEnabled();
    await expect(page.locator('[data-testid^="deploy-preview-file-"]')).toHaveCount(0);
  });

  test('confirming the preview triggers the deploy once and hands off to the live status screen', async ({
    page,
  }) => {
    await mockDeployPreview(page, previewWithAllChanges());
    await mockDeployTrigger(page, DEPLOY_ID);
    await mockDeployInfo(page, { status: 'pending' });
    await mockDeployStream(page, RUNNING_FRAMES);
    const deployTriggers = countDeployTriggers(page);

    await page.goto(previewUrl);
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();

    await page.getByTestId('deploy-preview-confirm').click();

    // A 202 hands off to the deploy-id-scoped status route, which streams the run's progress.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}$`));
    await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();
    await expect(page.getByTestId('deploy-progress-status')).toHaveAttribute(
      'data-phase',
      'running'
    );
    expect(deployTriggers()).toBe(1);
  });

  test('cancelling the preview returns to the deploy config and triggers no deploy', async ({
    page,
  }) => {
    await mockDeployPreview(page, previewWithAllChanges());
    const deployTriggers = countDeployTriggers(page);

    await page.goto(previewUrl);
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();

    await page.getByTestId('deploy-preview-cancel').click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy$`));
    await expect(page.getByTestId('deploy-screen')).toBeVisible();
    expect(deployTriggers()).toBe(0);
  });

  test('a 409 already-running deploy on confirm surfaces inline and stays on the preview', async ({
    page,
  }) => {
    await mockDeployPreview(page, previewWithAllChanges());
    await mockDeployTriggerConflict(page);

    await page.goto(previewUrl);
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();

    await page.getByTestId('deploy-preview-confirm').click();

    const error = page.getByTestId('deploy-preview-submit-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('already running');

    // A conflict carries no deploy id, so the preview never hands off.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deploy/preview$`));
    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();
  });

  test('a failed preview fetch shows an error with a working retry', async ({ page }) => {
    let attempts = 0;
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname.endsWith('/deploy/preview'),
      (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        attempts += 1;
        if (attempts === 1) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'test.failure', message: 'Controlled preview failure' }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(previewWithAllChanges()),
        });
      }
    );

    await page.goto(previewUrl);

    const previewError = page.getByTestId('deploy-preview-error');
    await expect(previewError).toBeVisible();
    await previewError.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByTestId('deploy-preview-screen')).toBeVisible();
    expect(attempts).toBe(2);
  });
});
