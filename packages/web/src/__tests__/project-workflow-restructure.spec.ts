import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

import type { ProjectDeployAccepted } from '@cc-forge/api/deploy';
import type { CreateProjectResult } from '@cc-forge/api/projects';

import { authenticate } from './helpers/auth';
import { setScalingPlan } from './helpers/deploy';
import {
  CANONICAL_PROJECT_FILES,
  canonicalDeployPath,
  canonicalDesignPath,
  createProject,
  deleteProjectFile,
  failJson,
  fileByPath,
  fulfillJson,
  getProjectFiles,
  isApiRequest,
  openSourceFolders,
  projectPath,
  projectStatus,
  projectZip,
  uniqueProjectName,
  workflowByPath,
  workflowDesign,
  workflowDetail,
} from './helpers/projects';
import type { ProjectFixture, SourceFile } from './helpers/projects';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_FILE_ID = '00000000-0000-4000-8000-000000000999';

function isCreateProjectResponse(response: Response): boolean {
  const url = new URL(response.url());
  return response.request().method() === 'POST' && url.pathname.replace(/\/$/, '') === '/projects';
}

async function importProject(
  page: Page,
  token: string,
  files: readonly SourceFile[],
  name: string
): Promise<ProjectFixture> {
  await page.goto('/projects/import');
  await expect(page.getByTestId('project-import')).toBeVisible();
  await page.getByTestId('project-import-zip-input').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: projectZip(files),
  });
  await expect(page.getByTestId('project-import-files').getByRole('listitem')).toHaveCount(
    files.length
  );
  await page.getByTestId('project-import-name').fill(name);

  const createdResponse = page.waitForResponse(isCreateProjectResponse);
  await page.getByTestId('project-import-submit').click();
  const response = await createdResponse;
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as CreateProjectResult;

  return {
    ...result,
    files: await getProjectFiles(page, token, result.project.id),
  };
}

async function expectExactPath(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
    .toBe(expected);
}

async function expectPlainBreadcrumbs(page: Page, labels: readonly string[]): Promise<string> {
  const breadcrumbs = page.getByTestId('app-breadcrumbs');
  await expect(breadcrumbs).toBeVisible();
  for (const label of labels)
    await expect(breadcrumbs.getByText(label, { exact: true })).toBeVisible();
  const disabledLinks = breadcrumbs.getByRole('link');
  for (let index = 0; index < (await disabledLinks.count()); index += 1) {
    await expect(disabledLinks.nth(index)).toBeDisabled();
    await expect(disabledLinks.nth(index)).not.toHaveAttribute('href');
  }
  return breadcrumbs.innerText();
}

async function installReadyDesignRoutes(
  page: Page,
  fixture: Pick<ProjectFixture, 'project' | 'workflows'>
): Promise<void> {
  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/*`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    const workflow_id = new URL(route.request().url()).pathname.split('/').at(-1);
    const workflow = fixture.workflows.find((candidate) => candidate.id === workflow_id);
    return workflow ? fulfillJson(route, workflowDetail(workflow, 'READY')) : route.continue();
  });
  await page.route(`**/projects/${fixture.project.id}/workflows/*/design`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    const workflow_id = new URL(route.request().url()).pathname.split('/').at(-2);
    const workflow = fixture.workflows.find((candidate) => candidate.id === workflow_id);
    return workflow ? fulfillJson(route, workflowDesign(workflow)) : route.continue();
  });
}

async function paneWidths(page: Page): Promise<{ graph: number; source: number }> {
  const graph = (await page.getByTestId('workflow-graph-pane').boundingBox())!;
  const source = (await page.getByTestId('workflow-source-pane').boundingBox())!;
  return { graph: graph.width, source: source.width };
}

async function dragHandleBy(page: Page, offset: number): Promise<void> {
  const handle = (await page.getByTestId('workflow-workspace-handle').boundingBox())!;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + offset, y, { steps: 10 });
  await page.mouse.up();
}

test('design workspace splits evenly and resizes down to the pane minimum', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  await installReadyDesignRoutes(page, fixture);

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  await expect(page.getByTestId('project-file-editor')).toBeVisible();

  const start = await paneWidths(page);
  expect(Math.abs(start.graph - start.source)).toBeLessThanOrEqual(1);

  const handle = page.getByTestId('workflow-workspace-handle');
  await expect(handle).toHaveAttribute('role', 'separator');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');

  await dragHandleBy(page, 120);
  const widened = await paneWidths(page);
  expect(widened.graph).toBeGreaterThan(start.graph + 100);
  expect(widened.source).toBeLessThan(start.source - 100);

  await dragHandleBy(page, -600);
  const clamped = await paneWidths(page);
  expect(clamped.graph).toBeGreaterThanOrEqual(449);
  expect(clamped.graph).toBeLessThan(widened.graph);
  expect(clamped.source).toBeGreaterThan(widened.source);
});

test('the design frame is wider than the standard screen frame', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 900 });
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  await installReadyDesignRoutes(page, fixture);
  const contentWidth = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="app-content-scroll"]')!.firstElementChild!.clientWidth
    );

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  expect(await contentWidth()).toBe(1840);

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-screen')).toBeVisible();
  expect(await contentWidth()).toBe(1450);
});

test('project import picker buttons preserve keyboard intent', async ({ page }) => {
  await authenticate(page);
  await page.goto('/projects/import');

  const dropzone = page.getByTestId('project-import-dropzone');
  await expect(dropzone).not.toHaveAttribute('role');

  const folder_chooser_event = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose project folder' }).focus();
  await page.keyboard.press('Enter');
  const folder_chooser = await folder_chooser_event;
  expect(await folder_chooser.element().getAttribute('data-testid')).toBe(
    'project-import-folder-input'
  );

  const zip_chooser_event = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose .zip' }).focus();
  await page.keyboard.press('Space');
  const zip_chooser = await zip_chooser_event;
  expect(await zip_chooser.element().getAttribute('data-testid')).toBe('project-import-zip-input');
});

test('@project-workflow-restructure imports the canonical project and keeps navigation project-owned', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  let imported: ProjectFixture | undefined;

  await page.route('**/projects/*/status', (route) => {
    const project_id = new URL(route.request().url()).pathname.split('/').at(-2);
    return imported && project_id === imported.project.id
      ? fulfillJson(route, projectStatus(imported.project.id, 'READY'))
      : route.continue();
  });
  await page.route('**/projects/*/workflows/*/design', (route) => {
    if (!isApiRequest(route)) return route.continue();
    const segments = new URL(route.request().url()).pathname.split('/');
    const project_id = segments.at(-4);
    const workflow_id = segments.at(-2);
    const workflow = imported?.workflows.find((candidate) => candidate.id === workflow_id);
    return imported && project_id === imported.project.id && workflow
      ? fulfillJson(route, workflowDesign(workflow))
      : route.continue();
  });

  await page.goto('/');
  await page.getByTestId('project-import-trigger').click();
  await expectExactPath(page, '/projects/import');
  await expect(page.getByRole('heading', { name: 'Import a project' })).toBeVisible();

  const project_name = uniqueProjectName('Canonical restructure');
  imported = await importProject(page, token, CANONICAL_PROJECT_FILES, project_name);
  const root_workflow = workflowByPath(imported, 'workflow.py');
  const nested_workflow = workflowByPath(imported, 'nested/secondary.workflow.py');
  const agent = fileByPath(imported, 'agents/router.agent.py');
  const tool = fileByPath(imported, 'tools/search.tool.py');

  expect(imported.project.id).toMatch(UUID_PATTERN);
  expect(root_workflow.id).toMatch(UUID_PATTERN);
  expect(nested_workflow.id).toMatch(UUID_PATTERN);
  expect(root_workflow.id).not.toBe(imported.project.id);
  expect(nested_workflow.id).not.toBe(imported.project.id);
  // An import lands on the scaling policy now, whatever workflows it found. Which workflow the
  // sidebar's Design row opens is its own business; this test is about the design screen, so it
  // asks for the root workflow directly.
  await expectExactPath(page, canonicalDeployPath(imported.project.id));
  await page.goto(canonicalDesignPath(imported.project.id, root_workflow.id));

  await expect(page.getByTestId('workflow-design')).toBeVisible();
  await expect(page.getByTestId('workflow-hero')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  await expect(page.getByTestId('workflow-design').getByTestId('project-stats')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const hero = document.querySelector('[data-testid="workflow-hero"]');
      const workspace = document.querySelector('[data-testid="workflow-workspace"]');
      return Boolean(
        hero &&
          workspace &&
          hero.compareDocumentPosition(workspace) === Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing workflow.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('root_workflow');
  const design_breadcrumbs = await expectPlainBreadcrumbs(page, [
    project_name,
    'Workflows',
    'Design',
  ]);

  const editor = page.getByTestId('project-file-editor').getByRole('textbox');
  await editor.click();
  await editor.press('Control+End');
  await editor.pressSequentially('\n# persisted restructure edit');
  await expect(page.getByTestId('project-file-save-status')).toHaveAttribute(
    'data-status',
    'saved'
  );
  await page.reload();
  await expect(page.getByTestId('project-file-editor')).toContainText('persisted restructure edit');

  await expect(page.getByTestId(`nav-workflow-${root_workflow.id}`)).toHaveAttribute(
    'href',
    canonicalDesignPath(imported.project.id, root_workflow.id)
  );
  await openSourceFolders(page, 'agents', 'tools', 'nested');
  await page.getByTestId(`nav-file-${agent.id}`).click();
  await expectExactPath(
    page,
    `${canonicalDesignPath(imported.project.id, root_workflow.id)}?file_id=${agent.id}`
  );
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing agents/router.agent.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('route_request');
  await expect(page.getByTestId('workflow-node-entry')).toBeVisible();
  await expect.poll(() => page.getByTestId('app-breadcrumbs').innerText()).toBe(design_breadcrumbs);

  await page.getByTestId(`nav-file-${tool.id}`).click();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing tools/search.tool.py'
  );
  await page.goBack();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing agents/router.agent.py'
  );
  await page.goForward();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing tools/search.tool.py'
  );

  await page.getByTestId(`nav-workflow-${nested_workflow.id}`).click();
  await expectExactPath(page, canonicalDesignPath(imported.project.id, nested_workflow.id));
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing nested/secondary.workflow.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('secondary_workflow');

  // The design header carries only Deploy until the project is live, so the sidebar leads back.
  await page.getByTestId(`nav-project-manage-${imported.project.id}`).click();
  await expectExactPath(page, projectPath(imported.project));
  await expect(page.getByTestId('project-screen')).toBeVisible();
  await expect(page.getByTestId('project-hero')).toContainText(project_name);
  // A freshly imported project has never deployed, so its status reads the same as the overview row.
  await expect(page.getByTestId('project-deploy-status')).toContainText('Not deployed');
  await expect(page.getByTestId('header-project-deploy')).toBeVisible();
  await expect(page.getByTestId('header-project-latest-deploy')).toHaveCount(0);
  await expect(page.getByTestId('project-status')).toHaveCount(0);
  await expect(page.getByTestId('project-stats')).toBeVisible();
  await expect(page.getByTestId('project-workflows')).toHaveCount(0);
  // No requests recorded yet, so spend stays visible while its per-query denominator is unavailable.
  await expect(page.getByTestId('project-cost-total')).toContainText('$0.00');
  await expect(page.getByTestId('project-cost-per-query')).toContainText('—');
  // The Overview tab is the cost trend alone: no flow board, and no query table to read empty.
  await expect(page.getByTestId('project-timeseries-empty')).toBeVisible();
  await expectExactPath(page, projectPath(imported.project));
  await expectPlainBreadcrumbs(page, [project_name]);

  await page.getByTestId('header-project-deploy').click();
  await expectExactPath(page, canonicalDeployPath(imported.project.id));
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  await expectPlainBreadcrumbs(page, [project_name, 'Scaling Policy']);
  await setScalingPlan(page, imported.project.id);

  const deployRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      request.method() === 'POST' && url.pathname === canonicalDeployPath(imported!.project.id)
    );
  });
  const deployResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'POST' &&
      url.pathname === canonicalDeployPath(imported!.project.id)
    );
  });
  // Setting the policy hands off to the emulation, and the fleet it works out is deployed from
  // there rather than from a screen the reader has to go and find.
  await page.getByTestId('emulation-deploy').click();
  const request = await deployRequest;
  const response = await deployResponse;
  expect(response.status()).toBe(202);
  expect(new URL(request.url()).pathname).toBe(canonicalDeployPath(imported.project.id));
  expect(request.postDataJSON()).toBeNull();

  const accepted = (await response.json()) as ProjectDeployAccepted;
  expect(accepted.deploy_id).toMatch(UUID_PATTERN);
  await expectExactPath(page, `/projects/${imported.project.id}/deploy/${accepted.deploy_id}`);
  await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();
});

test('every import lands on the scaling policy, whatever workflows it found', async ({ page }) => {
  const { token } = await authenticate(page);
  let projectPosts = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.replace(/\/$/, '') === '/projects') {
      projectPosts += 1;
    }
  });
  await page.route('**/projects/*/status', (route) => {
    const project_id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    return fulfillJson(route, projectStatus(project_id, 'PENDING'));
  });

  const single = await importProject(
    page,
    token,
    [
      { path: 'nested/only.workflow.py', content: 'def only():\n    return True\n' },
      { path: 'README.md', content: '# Single nested workflow\n' },
    ],
    uniqueProjectName('Single workflow')
  );
  await expectExactPath(page, canonicalDeployPath(single.project.id));
  await expect(page.getByTestId('deploy-screen')).toBeVisible();

  const zero = await importProject(
    page,
    token,
    [
      { path: 'agents/worker.agent.py', content: 'def work():\n    return True\n' },
      { path: 'README.md', content: '# No workflows\n' },
    ],
    uniqueProjectName('Zero workflow')
  );
  expect(zero.workflows).toHaveLength(0);
  // A project with nothing to emulate still starts here: the policy is asked before the design is
  // read, so having no workflow is not a reason to land somewhere else.
  await expectExactPath(page, canonicalDeployPath(zero.project.id));

  const multiple = await importProject(
    page,
    token,
    [
      { path: 'nested/alpha.workflow.py', content: 'def alpha():\n    return True\n' },
      { path: 'other/beta.workflow.py', content: 'def beta():\n    return True\n' },
      { path: 'README.md', content: '# Choose a workflow\n' },
    ],
    uniqueProjectName('Multiple workflows without root')
  );
  expect(multiple.workflows).toHaveLength(2);
  await expectExactPath(page, canonicalDeployPath(multiple.project.id));
  expect(projectPosts).toBe(3);
});

test('opens a standalone source from the project overview without selecting a workflow first', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const agent = fileByPath(fixture, 'agents/router.agent.py');
  await installReadyDesignRoutes(page, fixture);
  // Without an active workflow the source opens against the first project workflow, so match any.
  const source_href = new RegExp(
    `/projects/${fixture.project.id}/workflows/[0-9a-f-]+/design\\?file_id=${agent.id}$`
  );

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-screen')).toBeVisible();

  await openSourceFolders(page, 'agents');
  const agent_link = page.getByTestId(`nav-file-${agent.id}`);
  await expect(agent_link).toHaveAttribute('href', source_href);
  await agent_link.click();

  await expect(page).toHaveURL(source_href);
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing agents/router.agent.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('route_request');
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
});

test('direct nested design shows source while generation moves from pending to ready', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  let detailRequests = 0;
  let releaseReady!: () => void;
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });

  await page.route(`**/projects/${fixture.project.id}/workflows/${nested.id}`, async (route) => {
    if (!isApiRequest(route)) return route.continue();
    detailRequests += 1;
    if (detailRequests === 1) {
      return fulfillJson(route, workflowDetail(nested, 'GENERATING'));
    }
    await readyGate;
    return fulfillJson(route, workflowDetail(nested, 'READY'));
  });
  await page.route(`**/projects/${fixture.project.id}/workflows/${nested.id}/design`, (route) =>
    isApiRequest(route) ? fulfillJson(route, workflowDesign(nested)) : route.continue()
  );

  await page.goto(canonicalDesignPath(fixture.project.id, nested.id));
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing nested/secondary.workflow.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('secondary_workflow');
  await expect(page.getByTestId('workflow-design-generating')).toBeVisible();
  releaseReady();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  expect(detailRequests).toBeGreaterThanOrEqual(2);
  await expectPlainBreadcrumbs(page, [fixture.project.name, 'Workflows', 'Design']);
});

test('direct nested design preserves source when workflow generation fails', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  let designRequests = 0;

  await page.route(`**/projects/${fixture.project.id}/workflows/${nested.id}`, (route) =>
    isApiRequest(route) ? fulfillJson(route, workflowDetail(nested, 'FAILED')) : route.continue()
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/${nested.id}/design`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    designRequests += 1;
    return route.continue();
  });

  await page.goto(canonicalDesignPath(fixture.project.id, nested.id));
  await expect(page.getByTestId('workflow-design-unavailable')).toContainText(
    'could not be generated'
  );
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing nested/secondary.workflow.py'
  );
  await expect(page.getByTestId('project-file-editor')).toContainText('secondary_workflow');
  expect(designRequests).toBe(0);
});

test('file selection normalizes active, workflow, malformed, unknown, foreign, and deleted ids', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const foreign = await createProject(page, token, {
    name: uniqueProjectName('Foreign project'),
    files: [{ path: 'README.md', content: '# Foreign\n' }],
  });
  const root = workflowByPath(fixture, 'workflow.py');
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  const agent = fileByPath(fixture, 'agents/router.agent.py');
  const tool = fileByPath(fixture, 'tools/search.tool.py');
  const deleted = fileByPath(fixture, 'README.md');
  const foreign_file = fileByPath(foreign, 'README.md');
  await deleteProjectFile(page, token, fixture.project.id, deleted.id);
  await installReadyDesignRoutes(page, fixture);
  const root_path = canonicalDesignPath(fixture.project.id, root.id);

  await page.goto(`${root_path}?file_id=${root.source_file_id}`);
  await expectExactPath(page, root_path);
  await expect(page.getByTestId('file-selection-error')).toHaveCount(0);
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing workflow.py'
  );

  for (const [file_id, message] of [
    ['not-a-uuid', 'malformed'],
    [UNKNOWN_FILE_ID, 'unavailable or does not belong'],
    [foreign_file.id, 'unavailable or does not belong'],
    [deleted.id, 'unavailable or does not belong'],
  ] as const) {
    await page.goto(`${root_path}?file_id=${file_id}`);
    await expectExactPath(page, root_path);
    await expect(page.getByTestId('file-selection-error')).toContainText(message);
    await expect(page.getByTestId('project-file')).toHaveAttribute(
      'aria-label',
      'Editing workflow.py'
    );
  }

  await page.goto(`${root_path}?file_id=${nested.source_file_id}`);
  await expectExactPath(page, canonicalDesignPath(fixture.project.id, nested.id));
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing nested/secondary.workflow.py'
  );

  await page.goto(root_path);
  const breadcrumbs = await expectPlainBreadcrumbs(page, [
    fixture.project.name,
    'Workflows',
    'Design',
  ]);
  await openSourceFolders(page, 'agents', 'tools');
  await page.getByTestId(`nav-file-${agent.id}`).click();
  await page.getByTestId(`nav-file-${tool.id}`).click();
  await page.goBack();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing agents/router.agent.py'
  );
  await page.goForward();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing tools/search.tool.py'
  );
  await expect.poll(() => page.getByTestId('app-breadcrumbs').innerText()).toBe(breadcrumbs);
});

test('project header opens the first workflow design once workflows arrive', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  const root = workflowByPath(fixture, 'workflow.py');
  let releaseWorkflows!: () => void;
  const workflows_gate = new Promise<void>((resolve) => {
    releaseWorkflows = resolve;
  });

  await installReadyDesignRoutes(page, fixture);
  await page.route(`**/projects/${fixture.project.id}/workflows`, async (route) => {
    if (!isApiRequest(route)) return route.continue();
    await workflows_gate;
    return fulfillJson(route, [nested, root]);
  });

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-hero')).toContainText(fixture.project.name);
  await expect(page.getByTestId('project-design-link')).toHaveCount(0);

  releaseWorkflows();
  const design_link = page.getByTestId('project-design-link');
  await expect(design_link).toHaveAttribute(
    'href',
    canonicalDesignPath(fixture.project.id, nested.id)
  );

  await design_link.click();
  await expectExactPath(page, canonicalDesignPath(fixture.project.id, nested.id));
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing nested/secondary.workflow.py'
  );
});

test('project header carries no design link when the project has no workflow', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);

  await page.route(`**/projects/${fixture.project.id}/workflows`, (route) =>
    isApiRequest(route) ? fulfillJson(route, []) : route.continue()
  );

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-hero')).toContainText(fixture.project.name);
  await expect(page.getByTestId('project-stats')).toBeVisible();
  await expect(page.getByTestId('project-design-link')).toHaveCount(0);
});

test('project home stats failure recovers without workflow status noise', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  let stats_failed = true;

  await page.route(`**/projects/${fixture.project.id}/**`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    const path = new URL(route.request().url()).pathname;
    return path === `/projects/${fixture.project.id}/stats` && stats_failed
      ? failJson(route)
      : route.continue();
  });

  await page.goto(projectPath(fixture.project));
  await expect(page.getByTestId('project-screen')).toContainText(fixture.project.name);
  await expect(page.getByTestId('project-stats-error')).toBeVisible();
  await expect(page.getByTestId('project-status')).toHaveCount(0);
  await expect(page.getByTestId('project-workflows')).toHaveCount(0);
  await expectExactPath(page, projectPath(fixture.project));

  stats_failed = false;
  await page.getByTestId('project-stats-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('project-stats-error')).toHaveCount(0);
  await expect(page.getByTestId('project-stats')).toBeVisible();
  await expect(page.getByTestId('project-status')).toHaveCount(0);
  await expect(page.getByTestId('project-workflows')).toHaveCount(0);
  await expectExactPath(page, projectPath(fixture.project));
});

test('workflow detail, design, and source failures expose independent retries', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  let detailAttempts = 0;
  let designAttempts = 0;
  let fileAttempts = 0;

  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/${root.id}`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    detailAttempts += 1;
    return detailAttempts === 1
      ? failJson(route)
      : fulfillJson(route, workflowDetail(root, 'READY'));
  });
  await page.route(`**/projects/${fixture.project.id}/workflows/${root.id}/design`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    designAttempts += 1;
    return designAttempts === 1 ? failJson(route) : fulfillJson(route, workflowDesign(root));
  });
  await page.route(`**/projects/${fixture.project.id}/files/${root.source_file_id}`, (route) => {
    if (!isApiRequest(route)) return route.continue();
    fileAttempts += 1;
    return fileAttempts === 1 ? failJson(route) : route.continue();
  });

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('project-workflow-error')).toBeVisible();
  await page.getByTestId('project-workflow-error').getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByTestId('workflow-design-error')).toBeVisible();
  await expect(page.getByTestId('project-file-error')).toBeVisible();
  await page.getByTestId('project-file-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('project-file')).toHaveAttribute(
    'aria-label',
    'Editing workflow.py'
  );
  await expect(page.getByTestId('workflow-design-error')).toBeVisible();
  await page.getByTestId('workflow-design-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  expect(detailAttempts).toBe(2);
  expect(designAttempts).toBe(2);
  expect(fileAttempts).toBe(2);
});

test('legacy workflow, standalone file, and mock request web routes are absent', async ({
  page,
}) => {
  await authenticate(page);
  const project_id = '00000000-0000-4000-8000-000000000001';
  const child_id = '00000000-0000-4000-8000-000000000002';
  const legacyPaths = [
    `/workflows/${child_id}/design`,
    `/workflows/${child_id}/deploy`,
    `/projects/${project_id}/files/${child_id}`,
    `/projects/${project_id}/requests/req_legacy`,
  ];

  for (const path of legacyPaths) {
    await page.goto(path);
    await expectExactPath(page, path);
    await expect(page.getByTestId('workflow-design')).toHaveCount(0);
    await expect(page.getByTestId('deploy-screen')).toHaveCount(0);
    await expect(page.getByTestId('project-file')).toHaveCount(0);
  }
});
