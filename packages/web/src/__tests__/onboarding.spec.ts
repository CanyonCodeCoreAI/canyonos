import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { authenticate } from './helpers/auth';

const apiBaseUrl = process.env.VITE_API_URL ?? 'http://localhost:3000';

// The web E2E runs against the persistent dev database, so users and companies
// survive across runs. Everything the specs touch is minted per-run: a fresh
// `@cc-forge.test` email starts as an ONBOARDING user (a reused one would already
// be ACTIVE and get redirected away from /onboarding), and each company name is
// unique so it is unambiguous in the select.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqueEmail = (prefix: string) => `${prefix}-${unique()}@cc-forge.test`;
const uniqueCompanyName = (prefix: string) => `${prefix} ${unique()}`;

// Mint a genuine bearer token through the OTP bypass (code `111111`), then seed a
// company through the real API so the join flow has something to select. The token
// returned by /auth/verify authorizes the /companies write directly.
async function seedCompanyViaApi(page: Page, name: string): Promise<void> {
  const verify = await page.request.post(`${apiBaseUrl}/auth/verify`, {
    data: { email: uniqueEmail('company-seed'), code: '111111' },
  });
  if (!verify.ok()) {
    throw new Error(`Seed auth failed (${verify.status()}): ${await verify.text()}`);
  }
  const { token } = await verify.json();

  const created = await page.request.post(`${apiBaseUrl}/companies`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  });
  if (!created.ok()) {
    throw new Error(`Company seed failed (${created.status()}): ${await created.text()}`);
  }
}

test('@smoke create-company path onboards a fresh user and lands on projects', async ({ page }) => {
  await authenticate(page, uniqueEmail('onboard-create'));
  await page.goto('/onboarding');

  // The flow opens on the select step; its "create company" affordance is present.
  await expect(page.getByTestId('create-company')).toBeVisible();
  await expect(page.getByTestId('join-company')).toBeVisible();

  await page.getByTestId('create-company').click();

  const companyName = uniqueCompanyName('E2E Create Co');
  await page.getByTestId('company-name').fill(companyName);
  await page.getByTestId('submit-company').click();

  // On success the user becomes ACTIVE and the app navigates to `/`, which lands
  // on the authenticated projects overview.
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});

test('join-existing-company path links a fresh user to a company created via the API', async ({
  page,
}) => {
  const companyName = uniqueCompanyName('E2E Join Co');
  await seedCompanyViaApi(page, companyName);

  await authenticate(page, uniqueEmail('onboard-join'));
  await page.goto('/onboarding');

  // Open the shadcn Select and pick the seeded company by its visible name.
  await page.getByTestId('company-select').click();
  await page.getByRole('option', { name: companyName }).click();

  await page.getByTestId('join-company').click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId('projects-overview')).toBeVisible();
});
