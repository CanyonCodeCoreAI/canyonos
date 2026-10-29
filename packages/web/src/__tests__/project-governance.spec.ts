// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type { GovernanceAgent, GovernanceResponse } from '@canyonos/api/governance';
import type { ScalingPolicy, ScalingStatus } from '@canyonos/api/scaling';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import {
  expectPath,
  PROJECT,
  stubFleetSpend,
  stubProjectDashboard,
  stubProjectsList,
} from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const GOVERNANCE_PATH = `/projects/${PROJECT.id}/governance`;
const AGENTS_PATH = `${GOVERNANCE_PATH}/agents/`;
const SAVED_TOAST = "Governance rules saved. They apply on the controller's next poll.";
const NOT_RUNNING =
  'This project is not running, so its governance rules cannot be read. Deploy it, then retry.';

const SINCE = '2026-10-20T12:00:00.000Z';

function agent(name: string, fields: Partial<GovernanceAgent> = {}): GovernanceAgent {
  return {
    name,
    replicas_running: 1,
    replicas_expected: 1,
    desired_replicas: 1,
    status: 'up',
    unmet_requires: [],
    models: ['gpt-5.5', 'gpt-5.5-mini'],
    rules: { requires: [], spend: null },
    spend: null,
    scaling_policy_present: false,
    ...fields,
  };
}

const GOVERNANCE: GovernanceResponse = {
  agents: [
    agent('Workflow'),
    agent('TestRunnerAgent', { scaling_policy_present: true }),
    agent('ReviewAgent', { status: 'down', replicas_running: 0 }),
    agent('MergeAgent', {
      replicas_running: 1,
      replicas_expected: 2,
      desired_replicas: 2,
      rules: {
        requires: ['TestRunnerAgent'],
        spend: {
          since: SINCE,
          rules: [
            { above_usd: 5, action: { kind: 'switch_model', model: 'gpt-5.5-mini' } },
            { above_usd: 10, action: { kind: 'deny' } },
          ],
        },
      },
      spend: { since: SINCE, usd: 7, tripped_rule_index: 0 },
    }),
  ],
  edges: [
    { source: 'Workflow', target: 'TestRunnerAgent' },
    { source: 'Workflow', target: 'ReviewAgent' },
    { source: 'Workflow', target: 'MergeAgent' },
  ],
};

type Respond = (route: Route) => Promise<void>;

interface WriteRequest {
  readonly path: string;
  readonly body: unknown;
}

// Stubbed: the web e2e job runs the API with no controller Redis behind it.
interface GovernanceStub {
  reads: number;
  read_failure: Respond | null;
  writes: WriteRequest[];
  write_failure: Respond | null;
}

async function stubGovernance(
  page: Page,
  governance: GovernanceResponse = GOVERNANCE
): Promise<GovernanceStub> {
  const stub: GovernanceStub = { reads: 0, read_failure: null, writes: [], write_failure: null };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === GOVERNANCE_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.reads += 1;
      if (stub.read_failure) return stub.read_failure(route);
      return fulfillJson(route, governance);
    }
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname.startsWith(AGENTS_PATH),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'PUT') return route.continue();
      stub.writes.push({
        path: new URL(request.url()).pathname.slice(AGENTS_PATH.length),
        body: request.postDataJSON(),
      });
      if (stub.write_failure) return stub.write_failure(route);
      return fulfillJson(route, governance);
    }
  );
  return stub;
}

const SCALING_PATH = `/projects/${PROJECT.id}/scaling`;
const SCALING_SAVED_TOAST =
  "Scaling policy saved. Agents pick it up on the controller's next poll.";

const QUEUE_POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'queue_length_total',
  scale_up_above: 6,
  scale_down_below: 2,
};

const QUEUE_POLICY_DEFAULTS: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'queue_length_total',
  scale_up_above: 3,
  scale_down_below: 1,
};

interface ScalingStub {
  policy: ScalingStatus;
  writes: unknown[];
}

// A PUT stores the policy, so the re-read after a save answers what was sent.
async function stubScaling(page: Page, policy: ScalingStatus): Promise<ScalingStub> {
  const stub: ScalingStub = { policy, writes: [] };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING_PATH,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') return fulfillJson(route, stub.policy);
      if (request.method() !== 'PUT') return route.continue();
      const sent = request.postDataJSON() as ScalingPolicy;
      stub.writes.push(sent);
      stub.policy = { status: 'applied', policy: sent };
      return fulfillJson(route, sent);
    }
  );
  return stub;
}

async function openSession(page: Page): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
  await stubScaling(page, { status: 'none' });
}

async function openGovernance(
  page: Page,
  search = '',
  governance: GovernanceResponse = GOVERNANCE
): Promise<GovernanceStub> {
  await openSession(page);
  const stub = await stubGovernance(page, governance);
  await page.goto(`${GOVERNANCE_PATH}${search}`);
  await expect(screen(page)).toHaveAttribute('data-state', 'ready');
  return stub;
}

const screen = (page: Page) => page.getByTestId('governance-screen');
const canvas = (page: Page) => page.getByTestId('governance-canvas');
const node = (page: Page, name: string) => page.getByTestId(`governance-node-${name}`);
const drawer = (page: Page) => page.getByRole('dialog');
const toast = (page: Page) => page.getByTestId('app-toast');

test('the Governance row under Configuration opens the governance screen', async ({ page }) => {
  await openSession(page);
  await stubGovernance(page);
  const row = page.getByTestId(`nav-project-governance-${PROJECT.id}`);

  await page.goto('/projects');
  await page.getByTestId(`nav-project-toggle-${PROJECT.id}`).click();
  await page.getByRole('button', { name: 'Configuration' }).click();
  await row.click();

  await expectPath(page, GOVERNANCE_PATH);
  await expect(screen(page).getByRole('heading', { name: 'Governance', level: 1 })).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'page');
});

test('the canvas draws one node per agent and one edge per call', async ({ page }) => {
  await openGovernance(page);

  for (const { name } of GOVERNANCE.agents) await expect(node(page, name)).toBeVisible();
  await expect(canvas(page).locator('.react-flow__edge')).toHaveCount(GOVERNANCE.edges.length);
});

test('a node says its state in text and in tone', async ({ page }) => {
  await openGovernance(page);

  await expect(node(page, 'ReviewAgent').locator('[data-tone]')).toHaveAttribute(
    'data-tone',
    'down'
  );
  await expect(node(page, 'ReviewAgent')).toContainText('Down');
  await expect(node(page, 'MergeAgent').locator('[data-tone]')).toHaveAttribute(
    'data-tone',
    'warning'
  );
  await expect(node(page, 'MergeAgent')).toContainText('Cap tripped');
  await expect(node(page, 'MergeAgent')).toContainText('1/2 replicas · $7.00 since Oct 20, 2026');
  await expect(node(page, 'MergeAgent')).not.toContainText('cap $5.00');
  await expect(node(page, 'Workflow').locator('[data-tone]')).toHaveAttribute('data-tone', 'ok');
  await expect(node(page, 'Workflow')).toContainText('1/1 replicas');
  await expect(node(page, 'Workflow')).toContainText('Online');
});

test('a node lists its required agents and spend rules below its card', async ({ page }) => {
  await openGovernance(page);

  const rows = node(page, 'MergeAgent').getByRole('listitem');
  await expect(rows).toHaveText([
    'Requires TestRunnerAgent',
    'Above $5.00 → gpt-5.5-mini',
    'Above $10.00 → deny',
  ]);
  await expect(node(page, 'Workflow').getByRole('listitem')).toHaveCount(0);
});

test('Sync reads the agents again', async ({ page }) => {
  const stub = await openGovernance(page);
  const sync = page.getByTestId('governance-sync');
  await expect(sync).toBeEnabled();
  const before = stub.reads;

  await sync.click();

  await expect.poll(() => stub.reads).toBeGreaterThan(before);
  await expect(sync).toBeEnabled();
});

test('clicking a node opens its drawer through the URL, and closing it clears the URL', async ({
  page,
}) => {
  await openGovernance(page);
  const canvasWidth = (await canvas(page).boundingBox())?.width;

  await node(page, 'MergeAgent').click();

  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe('MergeAgent');
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('heading', { name: 'MergeAgent' })).toBeVisible();

  expect((await canvas(page).boundingBox())?.width).toBe(canvasWidth);

  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('agent')).toBe(false);
});

test('the drawer opens over the canvas, inside its box', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');

  await expect(screen(page).getByTestId('governance-drawer')).toBeVisible();
  const box = await canvas(page).boundingBox();
  const right = Math.ceil((box?.x ?? 0) + (box?.width ?? 0)) + 1;
  // Measured once the sheet has slid in: mid-slide it still reaches past the canvas edge.
  await expect
    .poll(async () => {
      const panel = await drawer(page).boundingBox();
      return (panel?.x ?? Infinity) + (panel?.width ?? 0);
    })
    .toBeLessThanOrEqual(right);
  expect((await drawer(page).boundingBox())?.x).toBeGreaterThan(box?.x ?? Infinity);
});

test('clicking the canvas beside the drawer closes it', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');
  const box = await canvas(page).boundingBox();

  await page.mouse.click((box?.x ?? 0) + 24, (box?.y ?? 0) + 24);

  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('agent')).toBe(false);
});

test('the Close button closes the drawer and clears the URL', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');

  await drawer(page).getByRole('button', { name: 'Close' }).click();

  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('agent')).toBe(false);
});

test('the drawer shows the stored rules and the spend against them', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');
  const form = drawer(page);

  const requires = form.getByRole('toolbar', { name: 'Requires' });
  await expect(requires.getByRole('button')).toHaveText([
    'Workflow',
    'TestRunnerAgent',
    'ReviewAgent',
  ]);
  await expect(requires.getByRole('button', { name: 'TestRunnerAgent' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(requires.getByRole('button', { name: 'ReviewAgent' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );

  const rules = form.getByTestId('governance-spend-rule');
  await expect(rules).toHaveCount(2);
  await expect(rules.nth(0).getByLabel('Above USD')).toHaveValue('5');
  await expect(rules.nth(0).getByRole('combobox', { name: 'Action' })).toHaveText('Switch model');
  await expect(rules.nth(0).getByRole('combobox', { name: 'Model' })).toHaveText('gpt-5.5-mini');
  await expect(rules.nth(1).getByLabel('Above USD')).toHaveValue('10');
  await expect(rules.nth(1).getByRole('combobox', { name: 'Action' })).toHaveText('Refuse calls');
  await expect(rules.nth(1).getByRole('combobox', { name: 'Model' })).toHaveCount(0);

  await expect(form.getByTestId('governance-spend')).toHaveText(
    '$7.00 since Oct 20, 2026 · cap $5.00 · switched to gpt-5.5-mini'
  );
});

test('saving sends the edited rules and confirms', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=MergeAgent');
  const form = drawer(page);
  const rules = form.getByTestId('governance-spend-rule');

  await form
    .getByRole('toolbar', { name: 'Requires' })
    .getByRole('button', { name: 'ReviewAgent' })
    .click();
  await rules.nth(0).getByLabel('Above USD').fill('6');
  await rules.nth(0).getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'gpt-5.5', exact: true }).click();
  await form.getByRole('button', { name: 'Save rules' }).click();

  await expect(toast(page)).toContainText(SAVED_TOAST);
  expect(stub.writes).toEqual([
    {
      path: 'MergeAgent',
      body: {
        requires: ['TestRunnerAgent', 'ReviewAgent'],
        spend: {
          since: SINCE,
          rules: [
            { above_usd: 6, action: { kind: 'switch_model', model: 'gpt-5.5' } },
            { above_usd: 10, action: { kind: 'deny' } },
          ],
        },
      },
    },
  ]);
});

test('a rule can be added and the counter restarted from now', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=Workflow');
  const form = drawer(page);

  await form.getByRole('button', { name: 'Add rule' }).click();
  await form.getByTestId('governance-spend-rule').getByLabel('Above USD').fill('3');
  await form.getByRole('button', { name: 'From now' }).click();
  await form.getByRole('button', { name: 'Save rules' }).click();

  await expect(toast(page)).toContainText(SAVED_TOAST);
  const [write] = stub.writes;
  expect(write?.path).toBe('Workflow');
  const body = write?.body as { requires: string[]; spend: { since: string; rules: unknown[] } };
  expect(body.requires).toEqual([]);
  expect(body.spend.rules).toEqual([{ above_usd: 3, action: { kind: 'deny' } }]);
  expect(Math.abs(Date.parse(body.spend.since) - Date.now())).toBeLessThan(60_000);
});

test('with no llms.yaml a switch_model rule takes any model id typed in', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=Workflow', {
    agents: [agent('Workflow', { models: null })],
    edges: [],
  });
  const form = drawer(page);

  await form.getByRole('button', { name: 'Add rule' }).click();
  const rule = form.getByTestId('governance-spend-rule');
  await rule.getByLabel('Above USD').fill('4');
  await rule.getByRole('combobox', { name: 'Action' }).click();
  await page.getByRole('option', { name: 'Switch model' }).click();
  await rule.getByRole('textbox', { name: 'Model' }).fill('meta.llama3-8b-instruct-v1:0');
  await form.getByRole('button', { name: 'Save rules' }).click();

  await expect(toast(page)).toContainText(SAVED_TOAST);
  const body = stub.writes[0]?.body as { spend: { rules: unknown[] } };
  expect(body.spend.rules).toEqual([
    { above_usd: 4, action: { kind: 'switch_model', model: 'meta.llama3-8b-instruct-v1:0' } },
  ]);
});

test('Stop agent sends stopped and warns that a scaling policy restarts it', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=TestRunnerAgent');
  const form = drawer(page);

  await expect(form.getByTestId('governance-stop-note')).toHaveText(
    'A scaling policy is set, so the controller starts it again at its minimum replicas.'
  );
  await form.getByRole('button', { name: 'Stop agent' }).click();

  await expect(toast(page)).toContainText('TestRunnerAgent stopped.');
  expect(stub.writes).toEqual([{ path: 'TestRunnerAgent/stopped', body: { stopped: true } }]);
});

test('Stop agent carries no scaling note when no policy is set', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');

  await expect(drawer(page).getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await expect(drawer(page).getByTestId('governance-stop-note')).toHaveCount(0);
});

test('a 422 on save shows the API message in the drawer', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=MergeAgent');
  stub.write_failure = (route) =>
    fulfillJson(
      route,
      {
        error: 'governance.unknown_agent',
        message: 'MergeAgent is not an agent of the running project',
      },
      422
    );

  await drawer(page).getByRole('button', { name: 'Save rules' }).click();

  await expect(drawer(page).getByTestId('governance-form-error')).toHaveText(
    'MergeAgent is not an agent of the running project'
  );
  await expect(toast(page)).toHaveCount(0);
});

test('a project that is not running says so', async ({ page }) => {
  await openSession(page);
  const stub = await stubGovernance(page);
  stub.read_failure = (route) =>
    fulfillJson(
      route,
      { error: 'canyonos.project_not_running', message: 'Project is not running' },
      404
    );
  await page.goto(GOVERNANCE_PATH);

  await expect(page.getByTestId('governance-error')).toContainText(NOT_RUNNING);
  await expect(screen(page)).toHaveAttribute('data-state', 'error');
  await expect(canvas(page)).toHaveCount(0);
});

const STOPPED_AND_WAITING: GovernanceResponse = {
  agents: [
    agent('TestRunnerAgent', {
      status: 'stopped',
      replicas_running: 0,
      desired_replicas: 0,
      scaling_policy_present: true,
    }),
    agent('MergeAgent', {
      unmet_requires: ['TestRunnerAgent'],
      rules: { requires: ['TestRunnerAgent'], spend: null },
    }),
    agent('ReviewAgent', { status: 'unknown', replicas_running: 0 }),
  ],
  edges: [],
};

test('a stopped node and a node with no reading say so in text', async ({ page }) => {
  await openGovernance(page, '', STOPPED_AND_WAITING);

  await expect(node(page, 'TestRunnerAgent')).toContainText('Stopped');
  await expect(node(page, 'TestRunnerAgent').locator('[data-tone]')).toHaveAttribute(
    'data-tone',
    'warning'
  );
  await expect(node(page, 'ReviewAgent')).toContainText('No reading yet');
  await expect(node(page, 'ReviewAgent').locator('[data-tone]')).toHaveCount(0);
});

test('a node whose required agent is not up warns that it requires it', async ({ page }) => {
  await openGovernance(page, '', STOPPED_AND_WAITING);

  await expect(node(page, 'MergeAgent')).toContainText('Requires TestRunnerAgent');
  await expect(node(page, 'MergeAgent').locator('[data-tone]')).toHaveAttribute(
    'data-tone',
    'warning'
  );
});

test('Start agent on a stopped agent sends stopped false, with no scaling note', async ({
  page,
}) => {
  const stub = await openGovernance(page, '?agent=TestRunnerAgent', STOPPED_AND_WAITING);
  const form = drawer(page);

  await expect(form.getByTestId('governance-stop-note')).toHaveCount(0);
  await form.getByRole('button', { name: 'Start agent' }).click();

  await expect(toast(page)).toContainText('TestRunnerAgent started.');
  expect(stub.writes).toEqual([{ path: 'TestRunnerAgent/stopped', body: { stopped: false } }]);
});

test('the drawer names the required agents that are not up', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent', STOPPED_AND_WAITING);

  await expect(drawer(page).getByTestId('governance-unmet')).toHaveText(
    'Not up right now: TestRunnerAgent. Calls to this agent are refused.'
  );
});

test('a failed poll keeps the canvas and the open drawer, and says so', async ({ page }) => {
  const stub = await openGovernance(page, '?agent=MergeAgent');
  const threshold = drawer(page)
    .getByTestId('governance-spend-rule')
    .nth(0)
    .getByLabel('Above USD');
  await threshold.fill('8');
  stub.read_failure = (route) =>
    fulfillJson(
      route,
      { error: 'canyonos.controller_unreachable', message: 'Controller unreachable' },
      502
    );

  await expect(page.getByTestId('governance-refresh-error')).toContainText(
    'The running controller could not be reached.'
  );
  await expect(screen(page)).toHaveAttribute('data-state', 'ready');
  await expect(node(page, 'MergeAgent')).toBeVisible();
  await expect(threshold).toHaveValue('8');
});

const policyLine = (page: Page) => page.getByTestId('governance-policy-line');
const policySheet = (page: Page) => page.getByTestId('governance-policy-sheet');

test('the toolbar says the stored scaling policy in one line', async ({ page }) => {
  await openSession(page);
  await stubScaling(page, { status: 'applied', policy: QUEUE_POLICY });
  await stubGovernance(page);
  await page.goto(GOVERNANCE_PATH);

  await expect(policyLine(page)).toHaveText('queue · up > 6 · down < 2 · 1–3 replicas');
});

test('the toolbar says when there is no policy and when it is invalid', async ({ page }) => {
  await openGovernance(page);
  await expect(policyLine(page)).toHaveText('No scaling policy');

  await stubScaling(page, { status: 'invalid', reason: 'max_replicas: too low' });
  await page.reload();
  await expect(policyLine(page)).toHaveText('Policy invalid');
});

test('Scaling policy opens the policy form over the canvas, through the URL', async ({ page }) => {
  await openGovernance(page);

  await page.getByTestId('governance-policy').click();

  await expect.poll(() => new URL(page.url()).searchParams.get('panel')).toBe('policy');
  await expect(
    drawer(page).getByRole('heading', { name: 'Scaling policy', exact: true })
  ).toBeVisible();
  await expect(policySheet(page).getByTestId('scaling-policy-none')).toBeVisible();
  const box = await canvas(page).boundingBox();
  const panel = await drawer(page).boundingBox();
  expect(panel?.x).toBeGreaterThan(box?.x ?? Infinity);

  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('panel')).toBe(false);
});

test('saving the policy in the sheet goes through PUT and updates the line', async ({ page }) => {
  await openSession(page);
  const scaling = await stubScaling(page, { status: 'none' });
  await stubGovernance(page);
  await page.goto(`${GOVERNANCE_PATH}?panel=policy`);
  const sheet = policySheet(page);

  await sheet.getByTestId('policy-add').click();
  await sheet.getByTestId('policy-kind-queue_length').click();
  await sheet.getByTestId('policy-max-replicas-decrease').click();
  await sheet.getByTestId('policy-max-replicas-decrease').click();
  await sheet.getByTestId('policy-save').click();

  await expect(toast(page)).toContainText(SCALING_SAVED_TOAST);
  expect(scaling.writes).toEqual([QUEUE_POLICY_DEFAULTS]);
  await expect(policyLine(page)).toHaveText('queue · up > 3 · down < 1 · 1–3 replicas');
  await expect(sheet.getByTestId('scaling-policy-applied')).toBeVisible();
});

test('opening the policy closes an open agent drawer', async ({ page }) => {
  await openGovernance(page, '?agent=MergeAgent');
  await expect(page.getByTestId('governance-drawer')).toBeVisible();

  await page.goto(`${GOVERNANCE_PATH}?agent=MergeAgent&panel=policy`);

  await expect(policySheet(page)).toBeVisible();
  await expect(page.getByTestId('governance-drawer')).toHaveCount(0);
  await expect(drawer(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('panel')).toBe(false);
  expect(new URL(page.url()).searchParams.has('agent')).toBe(false);
});

test('opening an agent closes the policy sheet', async ({ page }) => {
  await openGovernance(page, '?panel=policy');
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);

  await node(page, 'MergeAgent').click();

  await expect(page.getByTestId('governance-drawer')).toBeVisible();
  await expect(policySheet(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('panel')).toBe(false);
});
