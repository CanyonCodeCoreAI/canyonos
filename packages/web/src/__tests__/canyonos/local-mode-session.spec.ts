import { expect, test } from '@playwright/test';

import {
  ADMIN_EMAIL,
  BYPASS_CODE,
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubLocalSession,
  stubProjectDashboard,
  stubProjectsList,
} from './local-mode.helpers';

test('signs itself in as the local admin, with exactly one attempt per cold load', async ({
  page,
}) => {
  const session = await stubLocalSession(page);
  await stubProjectsList(page, [PROJECT]);
  await stubFleetSpend(page);

  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview')).toBeVisible();

  expect(session.verify_bodies).toEqual([{ email: ADMIN_EMAIL, code: BYPASS_CODE }]);
});

test('@smoke a deep link opens signed in, never showing the sign-in form', async ({ page }) => {
  await stubLocalSession(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);

  await page.goto(`/projects/${PROJECT.id}`);

  await expect(page.getByTestId('project-screen')).toBeVisible();
  await expectPath(page, `/projects/${PROJECT.id}`);
  await expect(page.getByTestId('auth-email-input')).toHaveCount(0);
});

test('a failed sign-in reports why on /login and retries from there', async ({ page }) => {
  const session = await stubLocalSession(page, { fails: true });
  await stubProjectsList(page, [PROJECT]);
  await stubFleetSpend(page);

  await page.goto('/projects');

  await expectPath(page, '/login');
  const failure = page.getByTestId('canyonos-local-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Invalid or expired code');
  // The email form belongs to a hosted workspace; a local install has one account and no form.
  await expect(page.getByTestId('auth-email-input')).toHaveCount(0);

  session.fails = false;
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
  expect(session.verify_bodies).toHaveLength(2);
});

test('the retry control is reachable and fires from the keyboard', async ({ page }) => {
  const session = await stubLocalSession(page, { fails: true });
  await stubProjectsList(page, [PROJECT]);
  await stubFleetSpend(page);

  await page.goto('/projects');
  await expect(page.getByTestId('canyonos-local-error')).toBeVisible();

  const retry = page.getByRole('button', { name: 'Retry' });
  await retry.focus();
  await expect(retry).toBeFocused();

  session.fails = false;
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('projects-overview')).toBeVisible();
  await expectPath(page, '/projects');
});
