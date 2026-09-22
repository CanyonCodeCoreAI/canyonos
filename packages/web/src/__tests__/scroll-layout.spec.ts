import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

import { authenticate } from './helpers/auth';
import {
  DEPLOY_ADDRESS,
  DEPLOY_ID,
  mockDeployConfig,
  mockDeployInfo,
  mockDeployWorkflows,
  mockProjectDetail,
  PROJECT_ID,
} from './helpers/deploy';
import {
  canonicalDeployPath,
  canonicalDesignPath,
  createProject,
  fulfillJson,
  isApiRequest,
  projectStatus,
  projectZip,
  workflowByPath,
  workflowDesign,
  workflowDetail,
} from './helpers/projects';
import type { ProjectFixture, SourceFile } from './helpers/projects';

const LONG_WORKFLOW = `${'def root_workflow(request):\n    return route_request(request)\n\n'.repeat(
  60
)}`;

const LAPTOP = { width: 1280, height: 720 };
const DESKTOP = { width: 1920, height: 1080 };

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

async function scrollMetrics(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      overflowY: style.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      clientWidth: el.clientWidth,
    };
  }, testId);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function expectShellFixedDuringScroll(page: Page): Promise<void> {
  const before = await page.evaluate(() => {
    const rect = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left } : null;
    };
    return { header: rect('app-header'), sidebar: rect('app-sidebar') };
  });
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="app-content-scroll"]');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
  const after = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="app-content-scroll"]') as HTMLElement;
    const rect = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left } : null;
    };
    return {
      scrolled: scroll.scrollTop,
      header: rect('app-header'),
      sidebar: rect('app-sidebar'),
    };
  });
  expect(after.scrolled).toBeGreaterThan(0);
  expect(after.header).toEqual(before.header);
  expect(after.sidebar).toEqual(before.sidebar);
}

test('workflow design keeps scroll on the shell, not a nested column (laptop)', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(LAPTOP);
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token, {
    name: 'scroll-workflow',
    files: [{ path: 'workflow.py', content: LONG_WORKFLOW }],
  });
  await installReadyDesignRoutes(page, fixture);
  const root = workflowByPath(fixture, 'workflow.py');

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('workflow-design')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  await expect(page.getByTestId('project-file-editor')).toBeVisible();

  const shell = await scrollMetrics(page, 'app-content-scroll');
  expect(shell?.overflowY).toBe('auto');
  expect(shell!.scrollHeight).toBeLessThanOrEqual(shell!.clientHeight + 1);

  const main = await scrollMetrics(page, 'workflow-design');
  expect(main?.overflowY).toBe('visible');

  const editorScrolls = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="project-file-editor"] .cm-scroller');
    return scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : null;
  });
  expect(editorScrolls).toBe(true);

  const canvasFits = await scrollMetrics(page, 'workflow-canvas');
  expect(canvasFits!.scrollHeight).toBeLessThanOrEqual(canvasFits!.clientHeight + 1);
  await expect(page.locator('.react-flow__controls')).toBeVisible();
  const box = (await page.getByTestId('workflow-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  const scrolledAfterWheel = await page.evaluate(
    () => (document.querySelector('[data-testid="app-content-scroll"]') as HTMLElement).scrollTop
  );
  expect(scrolledAfterWheel).toBe(0);

  await attachScreenshot(page, testInfo, 'workflow-design-laptop.png');
});

test('workflow design scrollbar sits at the far right of the content area (desktop)', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(DESKTOP);
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token, {
    name: 'scroll-workflow-desktop',
    files: [{ path: 'workflow.py', content: LONG_WORKFLOW }],
  });
  await installReadyDesignRoutes(page, fixture);
  const root = workflowByPath(fixture, 'workflow.py');

  await page.goto(canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId('workflow-design')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();

  const widths = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="app-content-scroll"]');
    const column = scroll?.firstElementChild;
    return scroll && column
      ? {
          scroll: scroll.clientWidth,
          column: column.clientWidth,
          scroll_right: scroll.getBoundingClientRect().right,
          viewport: window.innerWidth,
        }
      : null;
  });
  expect(widths).not.toBeNull();
  expect(widths!.column).toBeLessThanOrEqual(widths!.scroll);
  expect(widths!.scroll_right).toBe(widths!.viewport);

  await attachScreenshot(page, testInfo, 'workflow-design-desktop.png');
});

test('upload file list and preview scroll inside their panels, not the page', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await authenticate(page);

  const files: SourceFile[] = Array.from({ length: 40 }, (_, i) => ({
    path: `pkg/mod_${i}.py`,
    content: `value = ${i}\n`,
  }));
  files.push({ path: 'workflow.py', content: LONG_WORKFLOW });

  await page.goto('/projects/import');
  await expect(page.getByTestId('project-import')).toBeVisible();
  await page.getByTestId('project-import-zip-input').setInputFiles({
    name: 'scroll-upload.zip',
    mimeType: 'application/zip',
    buffer: projectZip(files),
  });
  const list = page.getByTestId('project-import-files');
  await expect(list.getByRole('listitem')).toHaveCount(files.length);

  await list.getByRole('button', { name: 'workflow.py', exact: true }).click();

  const shell = await scrollMetrics(page, 'app-content-scroll');
  expect(shell!.scrollHeight).toBeLessThanOrEqual(shell!.clientHeight + 1);

  const fileList = await scrollMetrics(page, 'project-import-files');
  expect(fileList?.overflowY).toBe('auto');
  expect(fileList!.scrollHeight).toBeGreaterThan(fileList!.clientHeight + 1);

  const previewScrolls = await page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    return scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : null;
  });
  expect(previewScrolls).toBe(true);
});

test('deploy config screen has no nested or inset scroll container', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token, { name: 'scroll-deploy' });

  await page.goto(canonicalDeployPath(fixture.project.id));
  await expect(page.getByTestId('deploy-screen')).toBeVisible();
  await expect(page.getByTestId('deploy-form')).toBeVisible();

  const shell = await scrollMetrics(page, 'app-content-scroll');
  expect(shell?.overflowY).toBe('auto');

  const main = await scrollMetrics(page, 'deploy-screen');
  expect(main?.overflowY).toBe('visible');
  const form = await scrollMetrics(page, 'deploy-form');
  expect(form?.overflowY).toBe('visible');
});

test('deploy completed screen scrolls on the shell with a fixed header and sidebar', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await authenticate(page);
  await mockProjectDetail(page);
  await mockDeployWorkflows(page);
  await mockDeployConfig(page);
  await mockDeployInfo(page, { status: 'success', address: DEPLOY_ADDRESS });

  await page.goto(`/projects/${PROJECT_ID}/deploy/${DEPLOY_ID}`);
  await expect(page.getByTestId('deploy-complete-screen')).toBeVisible();

  const shell = await scrollMetrics(page, 'app-content-scroll');
  expect(shell?.overflowY).toBe('auto');
  const main = await scrollMetrics(page, 'deploy-complete-screen');
  expect(main?.overflowY).toBe('visible');

  await expectShellFixedDuringScroll(page);

  await attachScreenshot(page, testInfo, 'deploy-complete-laptop.png');
});
