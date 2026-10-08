import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { authenticate } from './helpers/auth';
import { stubFleetSpend, stubProjectsList } from './helpers/session';

const DARK_FAVICON = '/cc-favicon.svg';
const LIGHT_FAVICON = '/cc-favicon-light.svg';

async function openDashboard(page: Page, colorScheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await authenticate(page);
  await stubProjectsList(page, []);
  await stubFleetSpend(page);
  await page.goto('/projects');
  await expect(page.getByTestId('theme-toggle')).toBeVisible();
}

async function expectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const html = page.locator('html');
  const favicon = page.locator('#theme-favicon');
  if (theme === 'dark') {
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(favicon).toHaveAttribute('href', DARK_FAVICON);
    return;
  }
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(favicon).toHaveAttribute('href', LIGHT_FAVICON);
}

const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem('cc-theme'));

for (const colorScheme of ['light', 'dark'] as const) {
  test(`with no stored choice the theme follows a ${colorScheme} system preference`, async ({
    page,
  }) => {
    await openDashboard(page, colorScheme);

    await expectTheme(page, colorScheme);
    expect(await storedTheme(page)).toBeNull();
  });
}

test('with no stored choice the theme follows the system preference as it changes', async ({
  page,
}) => {
  await openDashboard(page, 'light');
  await expectTheme(page, 'light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
});

test('the toggle switches the theme and the choice survives a reload', async ({ page }) => {
  await openDashboard(page, 'light');
  const toggle = page.getByTestId('theme-toggle');

  await toggle.click();
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBe('dark');

  await page.reload();
  await expectTheme(page, 'dark');

  await toggle.click();
  await expectTheme(page, 'light');
  expect(await storedTheme(page)).toBe('light');

  await page.reload();
  await expectTheme(page, 'light');
});

test('a stored choice wins over the system preference', async ({ page }) => {
  await openDashboard(page, 'dark');

  await page.getByTestId('theme-toggle').click();
  await expectTheme(page, 'light');

  await page.reload();
  await expectTheme(page, 'light');
});

test('a manual choice holds when the system preference changes afterwards', async ({ page }) => {
  await openDashboard(page, 'light');

  await page.getByTestId('theme-toggle').focus();
  await page.keyboard.press('Enter');
  await expectTheme(page, 'dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'dark');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Space');
  await expectTheme(page, 'light');

  await page.reload();
  await expectTheme(page, 'light');
});

test('blocked storage still lets the theme follow the system and the toggle switch it', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    for (const method of ['getItem', 'setItem'] as const) {
      const native = Object.getOwnPropertyDescriptor(Storage.prototype, method)!.value as (
        this: Storage,
        ...args: string[]
      ) => unknown;
      Storage.prototype[method] = function (this: Storage, name: string, ...rest: string[]) {
        if (name === key) throw new DOMException('blocked', 'SecurityError');
        return native.call(this, name, ...rest);
      } as never;
    }
  }, 'cc-theme');
  await openDashboard(page, 'dark');
  await expectTheme(page, 'dark');

  await page.getByTestId('theme-toggle').click();
  await expectTheme(page, 'light');
});
