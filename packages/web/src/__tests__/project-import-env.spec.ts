import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { projectZip } from './helpers/projects';
import type { SourceFile } from './helpers/projects';

const WORKFLOW: SourceFile = {
  path: 'flow/workflow.py',
  content: 'def run(request):\n    return request\n',
};

async function importZip(page: Page, files: readonly SourceFile[]): Promise<void> {
  await authenticate(page);
  await page.goto('/projects/import');
  await expect(page.getByTestId('project-import')).toBeVisible();
  await page.getByTestId('project-import-zip-input').setInputFiles({
    name: 'env-flow.zip',
    mimeType: 'application/zip',
    buffer: projectZip(files),
  });
  await expect(page.getByTestId('project-import-files')).toBeVisible();
}

test('warns about every env file in the upload and still reads them', async ({ page }) => {
  await importZip(page, [
    WORKFLOW,
    { path: 'flow/.env', content: 'OPENAI_API_KEY=sk-test\n' },
    { path: 'flow/service/.env.production', content: 'DB_URL=postgres://prod\n' },
    { path: 'flow/.gitignore', content: 'dist\n' },
  ]);

  const warning = page.getByTestId('project-import-env-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('2 environment files');
  await expect(warning).toContainText('.env');
  await expect(warning).toContainText('service/.env.production');

  const files = page.getByTestId('project-import-files');
  await expect(files.getByRole('button', { name: '.env', exact: true })).toBeVisible();
  await expect(files.getByRole('button', { name: 'service/.env.production' })).toBeVisible();
  // .gitignore has no supported extension, so it is skipped rather than read.
  await expect(files.getByRole('button', { name: '.gitignore' })).toHaveCount(0);
});

test('shows no env warning for an upload without env files', async ({ page }) => {
  await importZip(page, [WORKFLOW, { path: 'flow/README.md', content: '# flow\n' }]);

  await expect(page.getByTestId('project-import-env-warning')).toHaveCount(0);
});
