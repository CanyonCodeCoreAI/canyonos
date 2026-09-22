import { expect, test } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { createProject, projectPath, uniqueProjectName } from './helpers/projects';

// Regression guard: the delete flow chains two modal Radix layers (the row's actions dropdown and
// the section-level confirmation dialog) with the project row unmounting the moment deletion
// succeeds. If either layer is still open when the row unmounts, Radix never restores the body
// pointer-events lock and the whole page freezes until a refresh.
test('deleting a project keeps the page interactive and drops the row', async ({ page }) => {
  const { token } = await authenticate(page);
  const keep = await createProject(page, token, { name: uniqueProjectName('Keep me') });
  const doomed = await createProject(page, token, { name: uniqueProjectName('Delete me') });

  await page.goto(projectPath(keep.project));
  await expect(page.getByTestId(`nav-project-${keep.project.id}`)).toBeVisible();
  await expect(page.getByTestId(`nav-project-${doomed.project.id}`)).toBeVisible();

  await page.getByTestId(`nav-project-actions-${doomed.project.id}`).click();
  await page.getByTestId(`nav-project-delete-${doomed.project.id}`).click();
  await expect(page.getByTestId('project-delete-dialog')).toBeVisible();
  await page.getByTestId('project-delete-confirm').click();

  await expect(page.getByTestId(`nav-project-${doomed.project.id}`)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');

  // Prove interactivity concretely: another sidebar control must still respond after deletion.
  await page.getByTestId(`nav-project-actions-${keep.project.id}`).click();
  await expect(page.getByTestId(`nav-project-delete-${keep.project.id}`)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('deleting the active project navigates home and leaves the page interactive', async ({
  page,
}) => {
  const { token } = await authenticate(page);
  const active = await createProject(page, token, { name: uniqueProjectName('Active delete') });

  await page.goto(projectPath(active.project));
  await expect(page.getByTestId(`nav-project-${active.project.id}`)).toBeVisible();

  await page.getByTestId(`nav-project-actions-${active.project.id}`).click();
  await page.getByTestId(`nav-project-delete-${active.project.id}`).click();
  await expect(page.getByTestId('project-delete-dialog')).toBeVisible();
  await page.getByTestId('project-delete-confirm').click();

  // Deleting the active project navigates home; the authenticated index (`/`) redirects to the
  // Projects Overview at /projects.
  await expect.poll(() => new URL(page.url()).pathname).toBe('/projects');
  await expect(page.getByTestId(`nav-project-${active.project.id}`)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');
});
