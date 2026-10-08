import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { PROJECT, stubFleetSpend, stubProjectsList } from './helpers/session';

const SIDEBAR_DEFAULT_WIDTH_REM = 17.625;
const SIDEBAR_MIN_WIDTH_REM = 12.5;
const SIDEBAR_MAX_WIDTH_REM = 30;

async function openDashboard(page: Page) {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubFleetSpend(page);
  await page.goto('/projects');
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
}

async function rootFontSize(page: Page) {
  return page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  );
}

async function declaredSidebarWidth(page: Page) {
  return page
    .locator('[data-slot=sidebar-wrapper]')
    .evaluate((wrapper) => getComputedStyle(wrapper).getPropertyValue('--sidebar-width').trim());
}

async function dragHandleTo(page: Page, x: number) {
  const box = await page.getByTestId('sidebar-resize-handle').boundingBox();
  if (!box) throw new Error('resize handle is not rendered');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

async function sidebarWidthRem(page: Page) {
  const box = await page.getByTestId('app-sidebar').boundingBox();
  return (box?.width ?? 0) / (await rootFontSize(page));
}

test('the sidebar opens at its default width, declared in rem', async ({ page }) => {
  await openDashboard(page);
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(SIDEBAR_DEFAULT_WIDTH_REM);
  expect(await declaredSidebarWidth(page)).toBe(`${SIDEBAR_DEFAULT_WIDTH_REM}rem`);
});

test('dragging the handle widens the sidebar and clamps it at the max width', async ({ page }) => {
  await openDashboard(page);
  const root_px = await rootFontSize(page);

  await dragHandleTo(page, 22.5 * root_px);
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(22.5);
  expect(await declaredSidebarWidth(page)).toBe('22.5rem');

  await dragHandleTo(page, 900);
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(SIDEBAR_MAX_WIDTH_REM);
});

test('the default width and the clamp follow a larger root font size', async ({ page }) => {
  await openDashboard(page);
  await page.addStyleTag({ content: 'html { font-size: 20px; }' });
  const sidebar = page.getByTestId('app-sidebar');

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(SIDEBAR_DEFAULT_WIDTH_REM * 20);

  await dragHandleTo(page, 1000);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(SIDEBAR_MAX_WIDTH_REM * 20);

  await dragHandleTo(page, 150);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(SIDEBAR_MIN_WIDTH_REM * 20);
});

test('dragging below the collapse threshold collapses the sidebar, dragging out reopens it', async ({
  page,
}) => {
  await openDashboard(page);
  const root_px = await rootFontSize(page);
  const sidebar = page.locator('[data-slot=sidebar]');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');

  await dragHandleTo(page, 2.5 * root_px);
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await expect(sidebar).toHaveAttribute('data-collapsible', 'icon');

  await dragHandleTo(page, 18.75 * root_px);
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(18.75);
});

test('the handle is a vertical separator that reports its width in rem', async ({ page }) => {
  await openDashboard(page);
  const root_px = await rootFontSize(page);
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH_REM));
  await expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH_REM));
  await expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH_REM));

  await dragHandleTo(page, 22.5 * root_px);
  await expect(handle).toHaveAttribute('aria-valuenow', '22.5');
});

test('arrow keys on the focused handle resize the sidebar', async ({ page }) => {
  await openDashboard(page);
  await dragHandleTo(page, 18.75 * (await rootFontSize(page)));
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(18.75);

  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(19.75);
  await expect(handle).toHaveAttribute('aria-valuenow', '19.75');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(17.75);
});

test('Enter on the focused handle collapses and restores the sidebar', async ({ page }) => {
  await openDashboard(page);
  const sidebar = page.locator('[data-slot=sidebar]');
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await dragHandleTo(page, 20 * (await rootFontSize(page)));
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(20);

  await handle.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await page.keyboard.press('ArrowLeft');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

  await page.keyboard.press('Enter');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect.poll(() => sidebarWidthRem(page)).toBeCloseTo(20);

  await page.keyboard.press('Enter');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
});
