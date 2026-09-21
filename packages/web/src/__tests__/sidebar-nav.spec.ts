import { expect, test } from '@playwright/test';

import type { FleetOverview } from '@canyonos/api/resources';

import { SHOW_RESOURCE_NAVIGATION } from '../modules/core/components/app-sidebar/sidebar-sections';
import { authenticate } from './helpers/auth';
import { DEPLOY_ID, mockDeployInfo, mockDeployStream, RUNNING_FRAMES } from './helpers/deploy';
import {
  canonicalDeployPath,
  canonicalDesignPath,
  createProject,
  failJson,
  fileByPath,
  fulfillJson,
  isApiRequest,
  openSourceFolders,
  projectPath,
  projectStatus,
  uniqueProjectName,
  workflowByPath,
  workflowDesign,
} from './helpers/projects';

// Untracked resources (gpu/cpu/mem/storage) ship unavailable with an empty pool; only `tokens`
// carries real usage. The sidebar derives its per-resource totals from this shape.
const SIDEBAR_OVERVIEW: FleetOverview = {
  time_window: '30d',
  kpis: [],
  resources: [
    { id: 'gpu', label: 'GPU', unit: 'hrs', pool: 0, available: false },
    { id: 'cpu', label: 'CPU', unit: 'hrs', pool: 0, available: false },
    { id: 'mem', label: 'Memory', unit: 'GB·hr', pool: 0, available: false },
    { id: 'storage', label: 'Storage', unit: 'GB', pool: 0, available: false },
    { id: 'tokens', label: 'Tokens', unit: 'M', pool: 8.3, available: true },
  ],
  projects: [
    {
      id: 'proj-parser',
      name: 'Document Parser',
      color_index: 0,
      cost: 480,
      requests: 7200,
      avg_latency_ms: 210,
      error_rate_pct: 0.7,
      resource_usage: [
        { resource_id: 'gpu', usage: 0 },
        { resource_id: 'cpu', usage: 0 },
        { resource_id: 'mem', usage: 0 },
        { resource_id: 'storage', usage: 0 },
        { resource_id: 'tokens', usage: 8.3 },
      ],
    },
  ],
};

async function expectExactPath(page: Parameters<typeof authenticate>[0], expected: string) {
  await expect
    .poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
    .toBe(expected);
}

test('account menu reveals company details and logs out', async ({ page }) => {
  await authenticate(page);
  await page.goto('/resources');

  const trigger = page.getByTestId('sidebar-user-menu');
  await trigger.click();
  await expect(page.getByTestId('sidebar-user-menu-content')).toBeVisible();
  await expect(page.getByTestId('sidebar-company')).toBeVisible();
  await page.getByTestId('sidebar-logout').click();
  await expect(page).toHaveURL(/\/login/);
});

test('@smoke resource navigation lists flat links that load fleet usage and follow canonical paths', async ({
  page,
}) => {
  test.skip(!SHOW_RESOURCE_NAVIGATION, 'resource navigation is hidden');
  await authenticate(page);
  let releaseOverview!: () => void;
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve;
  });

  await page.route('**/resources/overview*', async (route) => {
    if (!isApiRequest(route)) return route.continue();
    await overviewGate;
    return fulfillJson(route, SIDEBAR_OVERVIEW);
  });

  await page.goto('/resources');
  await expect(page.getByTestId('nav-gpu-usage-loading')).toBeVisible();
  await expect(page.getByTestId('nav-gpu-usage')).toHaveCount(0);

  releaseOverview();
  // Only `tokens` is backed by real data, so it is the sole row that shows a usage total. The other
  // resources are untracked and must show no fabricated number. Assert the format, not the value.
  await expect(page.getByTestId('nav-tokens-usage')).toHaveText(/^[\d.,]+ M$/);
  await expect(page.getByTestId('nav-gpu-usage')).toHaveCount(0);
  await expect(page.getByTestId('nav-memory-usage')).toHaveCount(0);
  await expect(page.getByTestId('nav-gpu-usage-loading')).toHaveCount(0);

  // The mock that invented per-resource children is gone: every resource is a plain link now, so
  // the section holds no expand triggers and no rows beyond the five resources.
  const resources_section = page.getByRole('region', { name: 'Resources' });
  await expect(resources_section.getByRole('button')).toHaveCount(0);
  await expect(resources_section.getByRole('link')).toHaveCount(5);
  await expect(page.getByTestId('nav-gpu.router')).toHaveCount(0);

  await page.getByTestId('nav-cpu').click();
  await expectExactPath(page, '/resources/cpu');
  await expect(page.getByTestId('cpu-analytics')).toBeVisible();
  await expect(page.getByTestId('nav-cpu')).toHaveClass(/app-sidebar-active/);
  await expect(page.getByTestId('nav-gpu')).not.toHaveClass(/app-sidebar-active/);

  const storage = page.getByTestId('nav-storage');
  await storage.focus();
  await expect(storage).toBeFocused();
  await storage.press('Enter');
  await expectExactPath(page, '/resources/storage');

  await page.getByTestId('nav-resources-overview').click();
  await expectExactPath(page, '/resources');
  await expect(page.getByTestId('resources-overview')).toBeVisible();
});

test('resource rows stay navigable and drop their totals when fleet usage is unavailable', async ({
  page,
}) => {
  test.skip(!SHOW_RESOURCE_NAVIGATION, 'resource navigation is hidden');
  await authenticate(page);
  await page.route('**/resources/overview*', (route) =>
    isApiRequest(route) ? failJson(route) : route.continue()
  );

  await page.goto('/projects');
  await expect(page.getByTestId('nav-gpu')).toBeVisible();
  await expect(page.getByTestId('nav-gpu-usage-loading')).toHaveCount(0);
  await expect(page.getByTestId('nav-gpu-usage')).toHaveCount(0);

  await page.getByTestId('nav-gpu').click();
  await expectExactPath(page, '/resources/gpu');
});

test('project navigation distinguishes loading, error, retry, and empty states', async ({
  page,
}) => {
  await authenticate(page);
  let releaseProjects!: () => void;
  const projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  let attempts = 0;

  await page.route('**/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    attempts += 1;
    if (attempts === 1) {
      await projectsGate;
      return failJson(route);
    }
    return fulfillJson(route, []);
  });

  await page.goto('/resources');
  await expect(page.getByTestId('projects-loading')).toBeVisible();
  releaseProjects();
  await expect(page.getByTestId('projects-error')).toBeVisible();
  await page.getByTestId('projects-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('projects-empty')).toBeVisible();
  await expect(page.getByTestId('project-import-trigger')).toHaveAttribute(
    'href',
    '/projects/import'
  );
  expect(attempts).toBe(2);
});

test('expanded project child queries show loading, independent errors, and retries', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  let releaseWorkflows!: () => void;
  let releaseFiles!: () => void;
  const workflowGate = new Promise<void>((resolve) => {
    releaseWorkflows = resolve;
  });
  const filesGate = new Promise<void>((resolve) => {
    releaseFiles = resolve;
  });
  let workflowAttempts = 0;
  let fileAttempts = 0;

  await page.route(`**/projects/${fixture.project.id}/workflows`, async (route) => {
    workflowAttempts += 1;
    if (workflowAttempts === 1) {
      await workflowGate;
      return failJson(route);
    }
    return route.continue();
  });
  await page.route(`**/projects/${fixture.project.id}/files`, async (route) => {
    fileAttempts += 1;
    if (fileAttempts === 1) {
      await filesGate;
      return failJson(route);
    }
    return route.continue();
  });

  await page.goto('/resources');
  // The chevron expands without navigating, so the child queries load with the route unchanged.
  await page.getByTestId(`nav-project-toggle-${fixture.project.id}`).click();
  await expect(page.getByText('Loading workflows…', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading sources…', { exact: true })).toBeVisible();
  await expect(page.getByTestId(`nav-project-design-${fixture.project.id}`)).toHaveCount(0);

  releaseWorkflows();
  releaseFiles();
  const workflowError = page.getByRole('alert').filter({ hasText: 'Workflows unavailable' });
  const sourceError = page.getByRole('alert').filter({ hasText: 'Sources unavailable' });
  await expect(workflowError).toBeVisible();
  await expect(sourceError).toBeVisible();
  await expect(page.getByTestId(`nav-project-design-${fixture.project.id}`)).toHaveCount(0);

  await workflowError.getByRole('button', { name: 'Retry' }).click();
  const root = workflowByPath(fixture, 'workflow.py');
  await expect(workflowError).toHaveCount(0);
  await expect(page.getByTestId(`nav-project-design-${fixture.project.id}`)).toBeVisible();
  await expect(sourceError).toBeVisible();
  await sourceError.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toBeVisible();
  const agent = fileByPath(fixture, 'agents/router.agent.py');
  await openSourceFolders(page, 'agents');
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toBeVisible();
  expect(workflowAttempts).toBe(2);
  expect(fileAttempts).toBe(2);
});

test('@smoke project row opens the overview in one click and the chevron closes its sources', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const row = page.getByTestId(`nav-project-${fixture.project.id}`);
  const toggle = page.getByTestId(`nav-project-toggle-${fixture.project.id}`);

  await page.goto('/resources');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expectExactPath(page, projectPath(fixture.project));
  await expect(page.getByTestId('project-screen')).toBeVisible();
  // Arriving on the project also reveals its sources, so the overview and the tree land together.
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`nav-project-manage-${fixture.project.id}`)).toHaveAttribute(
    'aria-current',
    'page'
  );

  // Closing the sources is the chevron's job and must not navigate away from the overview.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`nav-project-manage-${fixture.project.id}`)).toHaveCount(0);
  await expectExactPath(page, projectPath(fixture.project));

  // Re-clicking the row while already on the overview reopens what the chevron closed.
  await row.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('project design row opens the first workflow and stays out of projects without workflows', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const zero = await createProject(page, token, {
    name: uniqueProjectName('Sidebar design zero workflow'),
    files: [{ path: 'README.md', content: '# Source only\n' }],
  });
  const root = workflowByPath(fixture, 'workflow.py');
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  const design_row = page.getByTestId(`nav-project-design-${fixture.project.id}`);
  // The row targets the first workflow the API lists, so serve a fixed order the assertions can name.
  await page.route(`**/projects/${fixture.project.id}/workflows`, (route) =>
    isApiRequest(route) ? fulfillJson(route, [nested, root]) : route.continue()
  );
  for (const workflow of [nested, root]) {
    await page.route(
      `**/projects/${fixture.project.id}/workflows/${workflow.id}/design`,
      (route) =>
        isApiRequest(route) ? fulfillJson(route, workflowDesign(workflow)) : route.continue()
    );
  }
  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );

  await page.goto(projectPath(fixture.project));
  await expect(design_row).toHaveAttribute(
    'href',
    canonicalDesignPath(fixture.project.id, nested.id)
  );
  await expect(design_row).not.toHaveAttribute('aria-current', 'page');
  await expect(design_row).not.toHaveClass(/bg-background/);

  await design_row.click();
  await expectExactPath(page, canonicalDesignPath(fixture.project.id, nested.id));
  await expect(design_row).toHaveAttribute('aria-current', 'page');
  await expect(design_row).toHaveClass(/bg-background/);

  // Every design screen of the project marks the row active, not only the workflow it opens.
  await page.getByTestId(`nav-workflow-${root.id}`).click();
  await expectExactPath(page, canonicalDesignPath(fixture.project.id, root.id));
  await expect(design_row).toHaveAttribute('aria-current', 'page');
  await expect(design_row).toHaveAttribute(
    'href',
    canonicalDesignPath(fixture.project.id, nested.id)
  );

  await page.getByTestId(`nav-project-deploy-${fixture.project.id}`).click();
  await expectExactPath(page, canonicalDeployPath(fixture.project.id));
  await expect(design_row).not.toHaveAttribute('aria-current', 'page');

  await page.goto(projectPath(zero.project));
  await expect(page.getByTestId(`nav-project-manage-${zero.project.id}`)).toBeVisible();
  await expect(page.getByTestId(`nav-project-design-${zero.project.id}`)).toHaveCount(0);
});

test('project source rows follow home, design, deploy, zero-workflow, active, and collapsed behavior', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const zero = await createProject(page, token, {
    name: uniqueProjectName('Sidebar zero workflow'),
    files: [{ path: 'README.md', content: '# Source only\n' }],
  });
  const root = workflowByPath(fixture, 'workflow.py');
  const nested = workflowByPath(fixture, 'nested/secondary.workflow.py');
  const agent = fileByPath(fixture, 'agents/router.agent.py');
  const tool = fileByPath(fixture, 'tools/search.tool.py');
  const zeroFile = fileByPath(zero, 'README.md');
  // Without an active workflow, a source opens against the first project workflow, so match any.
  const sourceHref = (file_id: string) =>
    new RegExp(
      `^/projects/${fixture.project.id}/workflows/[0-9a-f-]+/design\\?file_id=${file_id}$`
    );

  await page.route(`**/projects/${fixture.project.id}/status`, (route) =>
    fulfillJson(route, projectStatus(fixture.project.id, 'READY'))
  );
  await page.route(`**/projects/${fixture.project.id}/workflows/${root.id}/design`, (route) =>
    isApiRequest(route) ? fulfillJson(route, workflowDesign(root)) : route.continue()
  );

  await page.goto(projectPath(fixture.project));
  // The tree arrives shut. The rest of this test reads the files inside it and then closes the
  // folders again, so it opens them first.
  const folder_paths = ['agents', 'nested', 'tools'] as const;
  for (const path of folder_paths) {
    await expect(page.getByTestId(`nav-folder-${path}`)).toHaveAttribute('aria-expanded', 'false');
  }
  await openSourceFolders(page, ...folder_paths);
  await expect(page.getByTestId(`nav-project-manage-${fixture.project.id}`)).toHaveAttribute(
    'href',
    projectPath(fixture.project)
  );
  await expect(page.getByTestId(`nav-project-manage-${fixture.project.id}`)).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByTestId(`nav-project-deploy-${fixture.project.id}`)).toHaveAttribute(
    'href',
    canonicalDeployPath(fixture.project.id)
  );
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toHaveAttribute(
    'href',
    canonicalDesignPath(fixture.project.id, root.id)
  );
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toHaveAttribute(
    'href',
    sourceHref(agent.id)
  );
  await expect(page.getByTestId(`nav-file-${agent.id}`)).not.toHaveClass(/bg-background/);
  await expect(page.getByTestId(`nav-file-${tool.id}`)).not.toHaveClass(/bg-background/);
  await expect(page.getByTestId(`nav-project-${fixture.project.id}`)).not.toHaveClass(
    /app-sidebar-active/
  );

  const agents_folder = page.getByRole('button', { name: 'Toggle agents folder' });
  const nested_folder = page.getByRole('button', { name: 'Toggle nested folder' });
  const tools_folder = page.getByRole('button', { name: 'Toggle tools folder' });
  for (const folder of [agents_folder, nested_folder, tools_folder]) {
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect((await folder.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    await expect(folder).not.toHaveClass(/bg-background/);
  }

  await agents_folder.focus();
  await agents_folder.press('Enter');
  await expect(agents_folder).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toHaveCount(0);
  await tools_folder.focus();
  await tools_folder.press('Space');
  await expect(tools_folder).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`nav-file-${tool.id}`)).toHaveCount(0);
  await nested_folder.click();
  await expect(nested_folder).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`nav-workflow-${nested.id}`)).toHaveCount(0);

  await page.getByTestId(`nav-project-deploy-${fixture.project.id}`).click();
  await expectExactPath(page, canonicalDeployPath(fixture.project.id));
  await expect(page.getByTestId(`nav-project-deploy-${fixture.project.id}`)).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(agents_folder).toHaveAttribute('aria-expanded', 'false');
  await expect(nested_folder).toHaveAttribute('aria-expanded', 'false');
  await expect(tools_folder).toHaveAttribute('aria-expanded', 'false');

  await agents_folder.press('Enter');
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toBeVisible();

  await page.getByTestId(`nav-workflow-${root.id}`).click();
  await expectExactPath(page, canonicalDesignPath(fixture.project.id, root.id));
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).not.toHaveClass(/bg-background/);
  await expect(page.getByTestId(`nav-file-${agent.id}`)).not.toHaveClass(/bg-background/);
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toHaveAttribute(
    'href',
    `${canonicalDesignPath(fixture.project.id, root.id)}?file_id=${agent.id}`
  );
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toHaveAttribute(
    'href',
    canonicalDesignPath(fixture.project.id, root.id)
  );
  await page.getByTestId(`nav-file-${agent.id}`).click();
  await expectExactPath(
    page,
    `${canonicalDesignPath(fixture.project.id, root.id)}?file_id=${agent.id}`
  );
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toHaveClass(/bg-background/);
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).not.toHaveClass(/bg-background/);

  await page.getByTestId(`nav-project-deploy-${fixture.project.id}`).click();
  await expectExactPath(page, canonicalDeployPath(fixture.project.id));
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toHaveAttribute(
    'href',
    sourceHref(agent.id)
  );

  await page.goto(projectPath(zero.project));
  await expect(
    page.getByTestId('app-sidebar').getByText('No workflows detected', { exact: true })
  ).toBeVisible();
  await expect(page.getByTestId(`nav-source-${zeroFile.id}`)).toBeVisible();
  await expect(page.getByTestId(`nav-file-${zeroFile.id}`)).toHaveCount(0);

  await page.getByTestId('app-header').getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(
    page.getByTestId(`nav-project-${zero.project.id}`).getByText(zero.project.name)
  ).toBeHidden();
  await expect(page.getByTestId(`nav-project-${fixture.project.id}`)).toBeVisible();
  await page.getByTestId(`nav-project-${fixture.project.id}`).click();
  await expectExactPath(page, projectPath(fixture.project));
});

test('the sidebar Deploy row stays active on a deploy status screen', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  await mockDeployInfo(page, { status: 'processing_files' });
  await mockDeployStream(page, RUNNING_FRAMES);

  await page.goto(`${canonicalDeployPath(fixture.project.id)}/${DEPLOY_ID}`);
  await expect(page.getByTestId('deploy-progress-screen')).toBeVisible();

  const deploy_row = page.getByTestId(`nav-project-deploy-${fixture.project.id}`);
  await expect(deploy_row).toHaveAttribute('aria-current', 'page');
  await expect(deploy_row).toHaveClass(/bg-background/);
});

test('the design fold hides the sources without closing the project', async ({ page }) => {
  const { token } = await authenticate(page);
  const fixture = await createProject(page, token);
  const root = workflowByPath(fixture, 'workflow.py');
  const agent = fileByPath(fixture, 'agents/router.agent.py');

  await page.goto(projectPath(fixture.project));

  // Open by default: arriving at a project shows what it is made of, with the folders inside it
  // shut until asked.
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toBeVisible();
  await openSourceFolders(page, 'agents');
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toBeVisible();

  const toggle = page.getByTestId(`nav-project-design-toggle-${fixture.project.id}`);
  await toggle.click();

  // The sources go; Design, Manage and Deploy stay, and so does the project.
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toBeHidden();
  await expect(page.getByTestId(`nav-file-${agent.id}`)).toBeHidden();
  await expect(page.getByTestId(`nav-project-design-${fixture.project.id}`)).toBeVisible();
  await expect(page.getByTestId(`nav-project-manage-${fixture.project.id}`)).toBeVisible();
  await expect(page.getByTestId(`nav-project-deploy-${fixture.project.id}`)).toBeVisible();

  await toggle.click();
  await expect(page.getByTestId(`nav-workflow-${root.id}`)).toBeVisible();
});
