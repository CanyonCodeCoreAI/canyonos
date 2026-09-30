import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { PromptEdit, PromptItem, PromptsResponse } from '@canyonos/api/prompts';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, failJson, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const PROMPTS_PATH = `/projects/${PROJECT.id}/prompts`;

const INTENT: PromptItem = {
  name: 'intent.parse',
  version: 'intent-parse-0a1b2c3d-3',
  system: 'Classify the user intent.',
  user: 'Query: {query}',
  updated_at: '2026-09-20T10:00:00.000Z',
};

const SUMMARIZE: PromptItem = {
  name: 'summarize',
  version: 'summarize-9f8e7d6c-1',
  system: 'Summarize the input.',
  user: '{text}',
  updated_at: null,
};

const EDIT: PromptEdit = { system: 'Classify the intent strictly.', user: 'Q: {query}' };
const SAVED: PromptItem = {
  ...INTENT,
  ...EDIT,
  version: 'intent-parse-5e6f7a8b-4',
  updated_at: '2026-09-29T12:00:00.000Z',
};

// Stubbed rather than seeded: the web e2e job runs the API with no controller Redis behind it, so
// every prompt call would otherwise answer 502.
interface PromptsStub {
  /** How many times the screen read the list, so a spec can prove a retry or a refetch happened. */
  reads: number;
  /** What the next read answers; a save stub rewrites it the way the controller config would. */
  items: PromptItem[];
}

async function stubPrompts(
  page: Page,
  items: readonly PromptItem[],
  { fail_first = false }: { readonly fail_first?: boolean } = {}
): Promise<PromptsStub> {
  const stub: PromptsStub = { reads: 0, items: [...items] };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === PROMPTS_PATH,
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.reads += 1;
      if (fail_first && stub.reads === 1) return failJson(route, 'Could not read prompts');
      const body: PromptsResponse = { project_id: PROJECT.id, items: stub.items };
      return fulfillJson(route, body);
    }
  );
  return stub;
}

interface SaveRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Captures every save under the prompts path and answers each with `saved`, or a failure. */
async function stubPromptSave(
  page: Page,
  stub: PromptsStub,
  { saved = SAVED, fails = false }: { readonly saved?: PromptItem; readonly fails?: boolean } = {}
): Promise<SaveRequest[]> {
  const requests: SaveRequest[] = [];
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname.startsWith(`${PROMPTS_PATH}/`),
    (route) => {
      const request = route.request();
      requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
      if (fails) return failJson(route, 'The running controller could not be reached');
      stub.items = stub.items.map((item) => (item.name === saved.name ? saved : item));
      return fulfillJson(route, saved);
    }
  );
  return requests;
}

async function openSession(page: Page): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
}

const panel = (page: Page) => page.getByTestId('project-prompt-management');
const promptRow = (page: Page, name: string) =>
  panel(page).getByRole('button', { name, exact: true });

async function openEditor(page: Page, name: string) {
  await promptRow(page, name).click();
  await page.getByTestId('prompt-edit').click();
  return {
    system: panel(page).getByRole('textbox', { name: 'System', exact: true }),
    user: panel(page).getByRole('textbox', { name: 'User', exact: true }),
    save: page.getByTestId('prompt-save'),
    cancel: panel(page).getByRole('button', { name: 'Cancel', exact: true }),
  };
}

test('@smoke the Prompts row opens the prompt screen and is the row marked current', async ({
  page,
}) => {
  await openSession(page);
  await stubPrompts(page, [INTENT, SUMMARIZE]);
  const prompts = page.getByTestId(`nav-project-prompts-${PROJECT.id}`);
  const manage = page.getByTestId(`nav-project-manage-${PROJECT.id}`);

  await page.goto('/projects');
  await expect(page.getByTestId(`nav-project-${PROJECT.id}`)).toBeVisible();
  await expect(prompts).toHaveCount(0);

  await page.getByTestId(`nav-project-toggle-${PROJECT.id}`).click();
  await expect(prompts).toBeVisible();
  await expect(prompts).not.toHaveAttribute('aria-current', 'page');

  await prompts.click();
  await expectPath(page, PROMPTS_PATH);
  await expect(page.getByTestId('project-prompts-screen')).toBeVisible();
  await expect(promptRow(page, 'intent.parse')).toBeVisible();
  await expect(prompts).toHaveAttribute('aria-current', 'page');
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
});

test('lists the current version of each prompt and opens it to its text', async ({ page }) => {
  await openSession(page);
  await stubPrompts(page, [INTENT, SUMMARIZE]);
  await page.goto(PROMPTS_PATH);

  const intent = promptRow(page, 'intent.parse');
  const summarize = promptRow(page, 'summarize');
  await expect(intent).toHaveAttribute('aria-expanded', 'false');
  await expect(summarize).toHaveAttribute('aria-expanded', 'false');
  // The header row is the version, split into its parts.
  await expect(intent).toContainText('intent');
  await expect(intent).toContainText('parse');
  await expect(intent).toContainText('0a1b2c3d');
  await expect(intent).toContainText('3');
  await expect(panel(page).getByText(INTENT.system)).toHaveCount(0);

  await intent.click();
  await expect(intent).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).getByText(INTENT.system)).toBeVisible();
  await expect(panel(page).getByText(INTENT.user)).toBeVisible();
  await expect(page.getByTestId('prompt-edit')).toBeVisible();
  await expect(panel(page).getByText(SUMMARIZE.system)).toHaveCount(0);
});

test('saving an edit sends it as a new version, toasts it, and re-reads the list', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  const saves = await stubPromptSave(page, stub);
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'intent.parse');
  await expect(editor.system).toHaveValue(INTENT.system);
  await expect(editor.user).toHaveValue(INTENT.user);
  await expect(editor.save).toBeEnabled();

  await editor.system.fill('');
  await expect(editor.save).toBeDisabled();

  await editor.system.fill(EDIT.system);
  await editor.user.fill(EDIT.user);
  await expect(editor.save).toBeEnabled();
  expect(stub.reads).toBe(1);

  await editor.save.click();
  await expect(page.getByTestId('app-toast')).toContainText(
    'Saved intent.parse as intent-parse-5e6f7a8b-4'
  );
  expect(saves).toEqual([{ method: 'PUT', path: `${PROMPTS_PATH}/intent.parse`, body: EDIT }]);

  await expect.poll(() => stub.reads).toBe(2);
  const intent = promptRow(page, 'intent.parse');
  await expect(intent).toContainText('5e6f7a8b');
  await expect(intent).toContainText('4');
  await expect(panel(page).getByText(EDIT.system)).toBeVisible();
  await expect(panel(page).getByText(EDIT.user)).toBeVisible();
  await expect(editor.save).toHaveCount(0);
  await expect(page.getByTestId('prompt-edit')).toBeVisible();
});

test('cancelling an edit restores the read view without saving', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const saves = await stubPromptSave(page, stub);
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'intent.parse');
  await editor.system.fill('discarded');
  await editor.cancel.click();

  await expect(editor.save).toHaveCount(0);
  await expect(panel(page).getByText(INTENT.system)).toBeVisible();
  await expect(panel(page).getByText('discarded')).toHaveCount(0);
  await expect(page.getByTestId('prompt-edit')).toBeVisible();
  expect(saves).toEqual([]);
  expect(stub.reads).toBe(1);
});

test('a failed read shows the error and Retry reads again', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT], { fail_first: true });
  await page.goto(PROMPTS_PATH);

  const error = page.getByTestId('project-prompt-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Could not load prompts.');
  expect(stub.reads).toBe(1);

  await error.getByRole('button', { name: 'Retry' }).click();
  await expect(promptRow(page, 'intent.parse')).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(stub.reads).toBe(2);
});

test('a config with no prompts shows the empty state', async ({ page }) => {
  await openSession(page);
  await stubPrompts(page, []);
  await page.goto(PROMPTS_PATH);

  await expect(page.getByTestId('project-prompt-empty')).toHaveText(
    'No prompts. Add config/prompts.yaml to your project.'
  );
  await expect(page.getByTestId('project-prompt-error')).toHaveCount(0);
});

test('a failed save toasts the error and keeps the edit on screen', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const saves = await stubPromptSave(page, stub, { fails: true });
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'intent.parse');
  await editor.system.fill(EDIT.system);
  await editor.save.click();

  await expect(page.getByTestId('app-toast')).toContainText('Could not save intent.parse');
  expect(saves).toHaveLength(1);
  await expect(editor.system).toHaveValue(EDIT.system);
  await expect(editor.save).toBeEnabled();
  await expect(page.getByTestId('prompt-edit')).toHaveCount(0);
  expect(stub.reads).toBe(1);
});
