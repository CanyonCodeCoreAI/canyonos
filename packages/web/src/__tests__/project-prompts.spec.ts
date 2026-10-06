import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type {
  Prompt,
  PromptListItem,
  SystemPrompt,
  SystemPromptCreate,
} from '@canyonos/api/prompts';

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

const INTENT_V2: SystemPrompt = {
  version: 'IntentAgent-parse-11223344-v2',
  content: 'Classify intent.',
  updated_at: '2026-09-10T10:00:00.000Z',
};
const INTENT_V3: SystemPrompt = {
  version: 'IntentAgent-parse-0a1b2c3d-v3',
  content: 'Classify the user intent.\nAnswer with JSON.',
  updated_at: '2026-09-20T10:00:00.000Z',
};
const INTENT: Prompt = {
  name: 'IntentAgent.parse',
  live: INTENT_V3,
  versions: [INTENT_V3, INTENT_V2],
};

const SUMMARIZE_V1: SystemPrompt = {
  version: 'summarize-9f8e7d6c-v1',
  content: 'Summarize the input.',
  updated_at: null,
};
const SUMMARIZE: Prompt = { name: 'summarize', live: SUMMARIZE_V1, versions: [SUMMARIZE_V1] };

const EDIT: SystemPromptCreate = { content: 'Classify the intent strictly.' };
const INTENT_V4: SystemPrompt = {
  version: 'IntentAgent-parse-5e6f7a8b-v4',
  ...EDIT,
  updated_at: '2026-09-29T12:00:00.000Z',
};

const summaryOf = ({ name, live }: Prompt): PromptListItem => ({ name, live });

// Stubbed rather than seeded: the web e2e job runs the API with no controller Redis behind it, so
// every prompt call would otherwise answer 502.
interface PromptsStub {
  /** How many times the screen read the listing, so a spec can prove a retry or a refetch. */
  list_reads: number;
  /** How many times a card read its prompt's history. */
  prompt_reads: number;
  /** What reads answer; a write stub rewrites it the way the API would. */
  prompts: Prompt[];
}

type FirstRead = 'ok' | 'fails' | 'not_running';

async function stubPrompts(
  page: Page,
  prompts: readonly Prompt[],
  {
    first = 'ok',
    first_prompt = 'ok',
  }: { readonly first?: FirstRead; readonly first_prompt?: 'ok' | 'fails' } = {}
): Promise<PromptsStub> {
  const stub: PromptsStub = { list_reads: 0, prompt_reads: 0, prompts: [...prompts] };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === PROMPTS_PATH,
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.list_reads += 1;
      if (stub.list_reads === 1 && first === 'fails')
        return failJson(route, 'Could not read prompts');
      if (stub.list_reads === 1 && first === 'not_running') {
        return fulfillJson(
          route,
          { error: 'canyonos.project_not_running', message: 'No running controller' },
          404
        );
      }
      const body: PromptListItem[] = stub.prompts.map(summaryOf);
      return fulfillJson(route, body);
    }
  );
  await page.route(
    (url) =>
      url.origin === apiOrigin &&
      url.pathname.startsWith(`${PROMPTS_PATH}/`) &&
      !url.pathname.endsWith('/versions') &&
      !url.pathname.endsWith('/live'),
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.prompt_reads += 1;
      if (stub.prompt_reads === 1 && first_prompt === 'fails') {
        return failJson(route, 'Could not read the prompt');
      }
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
      const prompt = stub.prompts.find((stored) => stored.name === name);
      return prompt
        ? fulfillJson(route, prompt)
        : fulfillJson(route, { error: 'prompts.prompt_not_found', message: 'No such prompt' }, 404);
    }
  );
  return stub;
}

interface WriteRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Captures every write under the prompts path and answers it the way the API would, or fails. */
async function stubPromptWrites(
  page: Page,
  stub: PromptsStub,
  {
    created = INTENT_V4,
    fails = false,
  }: { readonly created?: SystemPrompt; readonly fails?: boolean } = {}
): Promise<WriteRequest[]> {
  const requests: WriteRequest[] = [];
  await page.route(
    (url) =>
      url.origin === apiOrigin &&
      (url.pathname.endsWith('/versions') || url.pathname.endsWith('/live')) &&
      url.pathname.startsWith(`${PROMPTS_PATH}/`),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON() as { content?: string; version?: string };
      requests.push({ method: request.method(), path, body });
      if (fails) return failJson(route, 'The running controller could not be reached');
      const name = decodeURIComponent(path.split('/').at(-2)!);
      const prompt = stub.prompts.find((stored) => stored.name === name)!;
      if (path.endsWith('/versions')) {
        stub.prompts = stub.prompts.map((stored) =>
          stored === prompt ? { ...stored, versions: [created, ...stored.versions] } : stored
        );
        return fulfillJson(route, created, 201);
      }
      const live = prompt.versions.find((stored) => stored.version === body.version)!;
      stub.prompts = stub.prompts.map((stored) =>
        stored === prompt ? { ...stored, live } : stored
      );
      return fulfillJson(route, { name, live });
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

const screen = (page: Page) => page.getByTestId('project-prompts-screen');
const card = (page: Page, name: string) =>
  screen(page).locator(`[data-testid="prompt-card"][data-name="${name}"]`);
const toggle = (card: Locator) => card.getByTestId('prompt-toggle');
const versionRow = (card: Locator, version: string) =>
  card.locator(`[data-testid="prompt-version"][data-version="${version}"]`);

async function openCard(page: Page, name: string): Promise<Locator> {
  const opened = card(page, name);
  await toggle(opened).click();
  await expect(opened.getByTestId('prompt-body')).toBeVisible();
  return opened;
}

async function openEditor(page: Page, name: string) {
  const opened = await openCard(page, name);
  await opened.getByTestId('prompt-edit').click();
  return {
    card: opened,
    content: opened.getByRole('textbox', { name: 'System prompt' }),
    save: opened.getByTestId('prompt-save'),
    cancel: opened.getByRole('button', { name: 'Cancel', exact: true }),
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
  await expect(screen(page)).toHaveAttribute('data-state', 'list');
  await expect(card(page, 'IntentAgent.parse')).toBeVisible();
  await expect(prompts).toHaveAttribute('aria-current', 'page');
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
});

test('a closed card names the function, its live version and the first line of its text, reading nothing else', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  await page.goto(PROMPTS_PATH);

  const intent = card(page, 'IntentAgent.parse');
  await expect(intent).toHaveAttribute('data-state', 'closed');
  await expect(toggle(intent)).toContainText('IntentAgent.parse');
  await expect(intent.getByTestId('prompt-live')).toHaveText('v3 live');
  await expect(intent.getByTestId('prompt-preview')).toHaveText('Classify the user intent.');
  await expect(toggle(intent)).not.toContainText('versions');
  await expect(intent.getByTestId('prompt-body')).toHaveCount(0);

  const summarize = card(page, 'summarize');
  await expect(summarize.getByTestId('prompt-live')).toHaveText('v1 live');
  expect(stub.list_reads).toBe(1);
  expect(stub.prompt_reads).toBe(0);
});

test('opening a card reads its history and shows the live version over every version, and closing hides it', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  await page.goto(PROMPTS_PATH);

  const intent = await openCard(page, 'IntentAgent.parse');
  expect(stub.prompt_reads).toBe(1);
  await expect(intent).toHaveAttribute('data-state', 'open');
  await expect(intent.getByTestId('prompt-preview')).toBeHidden();
  const panel = intent.getByTestId('prompt-live-panel');
  await expect(panel).toContainText('v3');
  await expect(panel.getByText('Live', { exact: true })).toBeVisible();
  await expect(intent.getByTestId('prompt-text')).toHaveText(INTENT_V3.content);
  await expect(intent.getByTestId('prompt-hint')).toHaveText(
    'Agents get this version on every call.'
  );
  await intent.getByTestId('prompt-edit').hover();
  await expect(page.getByRole('tooltip', { name: 'Edit prompt' })).toBeVisible();

  const versions = intent.getByRole('navigation', { name: 'Versions of IntentAgent.parse' });
  await expect(versions.getByTestId('prompt-version')).toHaveCount(2);
  await expect(versionRow(intent, INTENT_V3.version)).toHaveAttribute('data-active', 'true');
  await expect(versionRow(intent, INTENT_V3.version)).toContainText('live');
  await expect(versionRow(intent, INTENT_V2.version)).toHaveAttribute('data-active', 'false');
  await expect(intent.getByTestId('prompt-version-text')).toHaveCount(0);
  await expect(card(page, 'summarize')).toHaveAttribute('data-state', 'closed');

  await toggle(intent).click();
  await expect(intent).toHaveAttribute('data-state', 'closed');
  await expect(intent.getByTestId('prompt-body')).toHaveCount(0);
});

test('a history that fails to read shows the error in the card and Retry reads it again', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT], { first_prompt: 'fails' });
  await page.goto(PROMPTS_PATH);

  const intent = card(page, 'IntentAgent.parse');
  await toggle(intent).click();
  const error = intent.getByTestId('prompt-body-error');
  await expect(error).toContainText('Could not load its versions.');
  await expect(intent.getByTestId('prompt-body')).toHaveCount(0);
  expect(stub.prompt_reads).toBe(1);

  await intent.getByTestId('prompt-body-retry').click();
  await expect(intent.getByTestId('prompt-body')).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(intent.getByTestId('prompt-text')).toHaveText(INTENT_V3.content);
  expect(stub.prompt_reads).toBe(2);
});

test('an older version opens to its text, and Make live switches agents to it', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  const writes = await stubPromptWrites(page, stub);
  await page.goto(PROMPTS_PATH);

  const intent = await openCard(page, 'IntentAgent.parse');
  const row = versionRow(intent, INTENT_V2.version);
  await row.getByRole('button').first().click();
  await expect(row.getByTestId('prompt-version-text')).toHaveText(INTENT_V2.content);
  await expect(row).toContainText('Agents get v3. Make v2 live to switch them.');
  // The live version on screen does not move while an older one is being read.
  await expect(intent.getByTestId('prompt-text')).toHaveText(INTENT_V3.content);
  await expect(intent.getByTestId('prompt-live')).toHaveText('v3 live');

  await row.getByTestId('prompt-make-live').click();
  await expect(page.getByTestId('app-toast')).toContainText(
    'v2 of IntentAgent.parse is live. Running agents switch within 10 seconds.'
  );
  expect(writes).toEqual([
    {
      method: 'PUT',
      path: `${PROMPTS_PATH}/IntentAgent.parse/live`,
      body: { version: INTENT_V2.version },
    },
  ]);

  // Both the listing (header marker) and the history (rows, panel) re-read after the switch.
  await expect.poll(() => stub.list_reads).toBe(2);
  await expect.poll(() => stub.prompt_reads).toBe(2);
  await expect(intent.getByTestId('prompt-live')).toHaveText('v2 live');
  await expect(intent.getByTestId('prompt-text')).toHaveText(INTENT_V2.content);
  await expect(intent.getByTestId('prompt-live-panel')).toContainText('v2');
  await expect(versionRow(intent, INTENT_V2.version)).toHaveAttribute('data-active', 'true');
  await expect(versionRow(intent, INTENT_V3.version)).toHaveAttribute('data-active', 'false');
  await expect(versionRow(intent, INTENT_V2.version).getByTestId('prompt-make-live')).toBeHidden();
});

test('a failed Make live shows the error in the row and keeps the live version', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const writes = await stubPromptWrites(page, stub, { fails: true });
  await page.goto(PROMPTS_PATH);

  const intent = await openCard(page, 'IntentAgent.parse');
  const row = versionRow(intent, INTENT_V2.version);
  await row.getByRole('button').first().click();
  await row.getByTestId('prompt-make-live').click();

  await expect(row.getByTestId('prompt-live-error')).toHaveText(
    'The running controller could not be reached'
  );
  expect(writes).toHaveLength(1);
  await expect(row.getByTestId('prompt-make-live')).toBeEnabled();
  await expect(intent.getByTestId('prompt-live')).toHaveText('v3 live');
  expect(stub.list_reads).toBe(1);
  expect(stub.prompt_reads).toBe(1);
});

test('saving an edit creates the next version, listed but not live, and closes the editor', async ({
  page,
}) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  const writes = await stubPromptWrites(page, stub);
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'IntentAgent.parse');
  await expect(editor.content).toHaveValue(INTENT_V3.content);
  await expect(editor.content).toBeFocused();
  await expect(editor.card.getByTestId('prompt-text')).toBeHidden();
  await expect(editor.card.getByTestId('prompt-edit')).toBeHidden();
  await expect(editor.save).toHaveText('Save as v4');
  await expect(editor.save).toBeEnabled();
  await expect(editor.card.getByTestId('prompt-editor-hint')).toHaveText(
    'Saving adds v4. Agents keep getting v3 until you make v4 live.'
  );

  await editor.content.fill('   ');
  await expect(editor.save).toBeDisabled();

  await editor.content.fill(EDIT.content);
  await expect(editor.save).toBeEnabled();
  expect(stub.prompt_reads).toBe(1);

  await editor.save.click();
  await expect(page.getByTestId('app-toast')).toContainText(
    'Saved v4 of IntentAgent.parse. Agents still get v3.'
  );
  expect(writes).toEqual([
    { method: 'POST', path: `${PROMPTS_PATH}/IntentAgent.parse/versions`, body: EDIT },
  ]);

  // A save changes the history but not what is live, so only the card re-reads.
  await expect.poll(() => stub.prompt_reads).toBe(2);
  expect(stub.list_reads).toBe(1);
  await expect(editor.card.getByTestId('prompt-editor')).toHaveCount(0);
  await expect(editor.card.getByTestId('prompt-text')).toHaveText(INTENT_V3.content);
  await expect(editor.card.getByTestId('prompt-live')).toHaveText('v3 live');
  const added = versionRow(editor.card, INTENT_V4.version);
  await expect(editor.card.getByTestId('prompt-version')).toHaveCount(3);
  await expect(added).toHaveAttribute('data-active', 'false');
  await added.getByRole('button').first().click();
  await expect(added.getByTestId('prompt-version-text')).toHaveText(EDIT.content);
  await expect(added.getByTestId('prompt-make-live')).toHaveText('Make v4 live');
});

test('Cmd+Enter in the editor saves', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const writes = await stubPromptWrites(page, stub);
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'IntentAgent.parse');
  await editor.content.fill(EDIT.content);
  await editor.content.press('ControlOrMeta+Enter');

  await expect(page.getByTestId('app-toast')).toContainText('Saved v4 of IntentAgent.parse');
  expect(writes).toEqual([
    { method: 'POST', path: `${PROMPTS_PATH}/IntentAgent.parse/versions`, body: EDIT },
  ]);
});

test('cancelling an edit closes the editor without saving', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const writes = await stubPromptWrites(page, stub);
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'IntentAgent.parse');
  await editor.content.fill('discarded');
  await editor.cancel.click();

  await expect(editor.card.getByTestId('prompt-editor')).toBeHidden();
  await expect(editor.card.getByTestId('prompt-text')).toHaveText(INTENT_V3.content);
  await expect(editor.card.getByTestId('prompt-edit')).toBeVisible();
  expect(writes).toEqual([]);
  expect(stub.list_reads).toBe(1);
  expect(stub.prompt_reads).toBe(1);
});

test('a failed save shows the error and keeps the draft on screen', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT]);
  const writes = await stubPromptWrites(page, stub, { fails: true });
  await page.goto(PROMPTS_PATH);

  const editor = await openEditor(page, 'IntentAgent.parse');
  await editor.content.fill(EDIT.content);
  await editor.save.click();

  await expect(editor.card.getByTestId('prompt-save-error')).toHaveText(
    'The running controller could not be reached'
  );
  expect(writes).toHaveLength(1);
  await expect(editor.content).toHaveValue(EDIT.content);
  await expect(editor.save).toBeEnabled();
  expect(stub.prompt_reads).toBe(1);
});

test('a failed listing shows the error and Retry reads again', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT], { first: 'fails' });
  await page.goto(PROMPTS_PATH);

  await expect(screen(page)).toHaveAttribute('data-state', 'error');
  const error = page.getByTestId('project-prompt-error');
  await expect(error).toHaveText(/Could not load prompts\./);
  expect(stub.list_reads).toBe(1);

  await page.getByTestId('project-prompt-retry').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'list');
  await expect(card(page, 'IntentAgent.parse')).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(stub.list_reads).toBe(2);
});

test('a project that is not running says so instead of a generic error', async ({ page }) => {
  await openSession(page);
  await stubPrompts(page, [INTENT], { first: 'not_running' });
  await page.goto(PROMPTS_PATH);

  await expect(screen(page)).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('project-prompt-error')).toContainText(
    'This project is not running, so its prompts cannot be read.'
  );
});

test('a project with no prompts shows the empty state', async ({ page }) => {
  await openSession(page);
  await stubPrompts(page, []);
  await page.goto(PROMPTS_PATH);

  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('project-prompt-empty')).toHaveText(
    'No prompts yet. Add config/prompts.yaml to the project and deploy it again.'
  );
  await expect(page.getByTestId('project-prompt-error')).toHaveCount(0);
});

test('cards open and close independently of each other', async ({ page }) => {
  await openSession(page);
  const stub = await stubPrompts(page, [INTENT, SUMMARIZE]);
  await page.goto(PROMPTS_PATH);

  const intent = await openCard(page, 'IntentAgent.parse');
  const summarize = await openCard(page, 'summarize');
  await expect(intent).toHaveAttribute('data-state', 'open');
  await expect(summarize).toHaveAttribute('data-state', 'open');
  await expect(summarize.getByTestId('prompt-text')).toHaveText(SUMMARIZE_V1.content);
  expect(stub.prompt_reads).toBe(2);

  await toggle(intent).click();
  await expect(intent).toHaveAttribute('data-state', 'closed');
  await expect(summarize).toHaveAttribute('data-state', 'open');
});
