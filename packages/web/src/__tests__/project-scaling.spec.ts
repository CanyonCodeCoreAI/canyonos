import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

import type { ScalingPolicy, ScalingResponse } from '@canyonos/api/scaling';

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
const SCALING_PATH = `/projects/${PROJECT.id}/scaling`;
const UNREACHABLE = 'The running controller could not be reached';

const SUMMARIZER_POLICY: ScalingPolicy = {
  min_replicas: 2,
  max_replicas: 8,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 40,
  scale_down_below: 5,
};

const ENRICHER_POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'queue_length_total',
  scale_up_above: 6,
  scale_down_below: 2,
};

// Inserted out of name order so the screen, not the fixture, is what puts enricher first.
const CONFIGURED: ScalingResponse = {
  agents: ['classifier', 'enricher', 'router', 'summarizer'],
  policies: { summarizer: SUMMARIZER_POLICY, enricher: ENRICHER_POLICY },
  invalid: [],
};

const EMPTY: ScalingResponse = { agents: ['classifier', 'router'], policies: {}, invalid: [] };

type Respond = (route: Route) => Promise<void>;

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Stubbed rather than seeded: the web e2e job runs the API with no controller Redis behind it, so
// every scaling call would otherwise answer 502. Fields are mutable so a test can change what the
// next call answers mid-flow.
interface ScalingStub {
  reads: number;
  config: ScalingResponse;
  read_hold: Promise<void> | null;
  read_failure: Respond | null;
  writes: WriteRequest[];
  write_hold: Promise<void> | null;
  write_failure: Respond | null;
}

interface WriteRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

async function stubScaling(page: Page, config: ScalingResponse): Promise<ScalingStub> {
  const stub: ScalingStub = {
    reads: 0,
    config: structuredClone(config),
    read_hold: null,
    read_failure: null,
    writes: [],
    write_hold: null,
    write_failure: null,
  };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.reads += 1;
      if (stub.read_hold) await stub.read_hold;
      if (stub.read_failure) return stub.read_failure(route);
      return fulfillJson(route, stub.config);
    }
  );
  // Writes behave like the controller config: a PUT stores the policy, a DELETE drops it.
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname.startsWith(`${SCALING_PATH}/`),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const agent_name = decodeURIComponent(path.slice(`${SCALING_PATH}/`.length));
      stub.writes.push({ method: request.method(), path, body: request.postDataJSON() });
      if (stub.write_hold) await stub.write_hold;
      if (stub.write_failure) return stub.write_failure(route);
      const policies = { ...stub.config.policies };
      const invalid = stub.config.invalid.filter((name) => name !== agent_name);
      if (request.method() === 'DELETE') {
        delete policies[agent_name];
        stub.config = { ...stub.config, policies, invalid };
        return fulfillJson(route, { agent_name });
      }
      const policy = request.postDataJSON() as ScalingPolicy;
      stub.config = { ...stub.config, policies: { ...policies, [agent_name]: policy }, invalid };
      return fulfillJson(route, policy);
    }
  );
  return stub;
}

async function openSession(page: Page): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
}

async function openScaling(page: Page, config: ScalingResponse): Promise<ScalingStub> {
  await openSession(page);
  const stub = await stubScaling(page, config);
  await page.goto(SCALING_PATH);
  return stub;
}

const screen = (page: Page) => page.getByTestId('scaling-screen');
const allCards = (page: Page) => screen(page).locator('[data-testid^="scaling-policy-"]');
const draftCards = (page: Page) => page.getByTestId('scaling-policy-draft');
const savedCard = (page: Page, agent_name: string) =>
  page.locator(`[data-testid="scaling-policy-saved"][data-agent="${agent_name}"]`);
const invalidCard = (page: Page, agent_name: string) =>
  page.locator(`[data-testid="scaling-policy-invalid"][data-agent="${agent_name}"]`);
const addButton = (page: Page) => page.getByTestId('scaling-add-policy');
const toast = (page: Page) => page.getByTestId('app-toast');

async function addDraft(page: Page, kind: 'throughput' | 'queue_length'): Promise<void> {
  await addButton(page).click();
  await page.getByTestId(`scaling-add-${kind}`).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

async function pickAgent(card: PolicyCard, agent_name: string): Promise<void> {
  await card.agent.click();
  await card.root.page().getByRole('option', { name: agent_name, exact: true }).click();
  await expect(card.agent).toHaveText(agent_name);
}

async function agentOptions(card: PolicyCard): Promise<Locator> {
  await card.agent.click();
  return card.root.page().getByRole('option');
}

function stepper(card: Locator, test_id: string) {
  return {
    value: card.getByTestId(`${test_id}-value`),
    increase: card.getByTestId(`${test_id}-increase`),
    decrease: card.getByTestId(`${test_id}-decrease`),
  };
}

function policyCard(root: Locator) {
  return {
    root,
    agent: root.getByTestId('policy-agent'),
    save: root.getByTestId('policy-save'),
    discard: root.getByTestId('policy-discard'),
    delete: root.getByTestId('policy-delete'),
    error: root.getByRole('alert'),
    scale_up: stepper(root, 'policy-scale-up'),
    scale_down: stepper(root, 'policy-scale-down'),
    min_replicas: stepper(root, 'policy-min-replicas'),
    max_replicas: stepper(root, 'policy-max-replicas'),
  };
}

type PolicyCard = ReturnType<typeof policyCard>;

async function expectValues(card: PolicyCard, policy: Omit<ScalingPolicy, 'metric'>) {
  await expect(card.scale_up.value).toHaveText(String(policy.scale_up_above));
  await expect(card.scale_down.value).toHaveText(String(policy.scale_down_below));
  await expect(card.min_replicas.value).toHaveText(String(policy.min_replicas));
  await expect(card.max_replicas.value).toHaveText(String(policy.max_replicas));
}

test('@smoke the Scaling row opens the scaling screen and is the row marked current', async ({
  page,
}) => {
  await openSession(page);
  await stubScaling(page, CONFIGURED);
  const scaling = page.getByTestId(`nav-project-scaling-${PROJECT.id}`);
  const manage = page.getByTestId(`nav-project-manage-${PROJECT.id}`);
  const prompts = page.getByTestId(`nav-project-prompts-${PROJECT.id}`);

  await page.goto('/projects');
  await expect(page.getByTestId(`nav-project-${PROJECT.id}`)).toBeVisible();
  await expect(scaling).toHaveCount(0);

  await page.getByTestId(`nav-project-toggle-${PROJECT.id}`).click();
  await expect(scaling).toBeVisible();
  await expect(scaling).not.toHaveAttribute('aria-current', 'page');

  await scaling.click();
  await expectPath(page, SCALING_PATH);
  await expect(screen(page).getByRole('heading', { name: 'Scaling', level: 1 })).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-state', 'list');
  await expect(allCards(page)).toHaveCount(2);
  await expect(scaling).toHaveAttribute('aria-current', 'page');
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
  await expect(prompts).not.toHaveAttribute('aria-current', 'page');
});

test.describe('screen states', () => {
  test('loading: a pending read shows the loading state, never the empty state', async ({
    page,
  }) => {
    await openSession(page);
    const stub = await stubScaling(page, CONFIGURED);
    const hold = deferred();
    stub.read_hold = hold.promise;
    await page.goto(SCALING_PATH);

    try {
      await expect.poll(() => stub.reads).toBe(1);
      await expect(screen(page)).toHaveAttribute('data-state', 'loading');
      await expect(page.getByTestId('scaling-loading')).toBeVisible();
      await expect(page.getByTestId('scaling-empty')).toHaveCount(0);
      await expect(addButton(page)).toBeDisabled();
    } finally {
      hold.release();
    }

    await expect(screen(page)).toHaveAttribute('data-state', 'list');
    await expect(page.getByTestId('scaling-loading')).toHaveCount(0);
    await expect(allCards(page)).toHaveCount(2);
    await expect(addButton(page)).toBeEnabled();
  });

  for (const failure of [
    { status: 404, message: 'Project is not running in the controller' },
    { status: 502, message: UNREACHABLE },
  ]) {
    test(`error: a failed read (${failure.status}) shows only the error, and Add is disabled`, async ({
      page,
    }) => {
      await openSession(page);
      const stub = await stubScaling(page, CONFIGURED);
      stub.read_failure = (route) =>
        fulfillJson(route, { error: 'test.failure', message: failure.message }, failure.status);
      await page.goto(SCALING_PATH);

      await expect(page.getByTestId('scaling-error')).toContainText(failure.message);
      await expect(screen(page)).toHaveAttribute('data-state', 'error');
      await expect(page.getByTestId('scaling-empty')).toHaveCount(0);
      await expect(allCards(page)).toHaveCount(0);
      await expect(addButton(page)).toBeDisabled();
      expect(stub.reads).toBe(1);
    });
  }

  test('error -> Retry -> ready: Retry re-reads and replaces the error with the policies', async ({
    page,
  }) => {
    await openSession(page);
    const stub = await stubScaling(page, CONFIGURED);
    stub.read_failure = (route) => failJson(route, UNREACHABLE);
    await page.goto(SCALING_PATH);
    await expect(page.getByTestId('scaling-error')).toContainText(UNREACHABLE);
    expect(stub.reads).toBe(1);

    stub.read_failure = null;
    const hold = deferred();
    stub.read_hold = hold.promise;
    await page.getByTestId('scaling-retry').click();
    try {
      await expect.poll(() => stub.reads).toBe(2);
      await expect(screen(page)).toHaveAttribute('data-state', 'loading');
      await expect(page.getByTestId('scaling-error')).toHaveCount(0);
    } finally {
      hold.release();
    }

    await expect(screen(page)).toHaveAttribute('data-state', 'list');
    await expect(allCards(page)).toHaveCount(2);
    await expect(addButton(page)).toBeEnabled();
    expect(stub.reads).toBe(2);
  });

  test('empty -> list: no policies shows the empty state until a draft is added', async ({
    page,
  }) => {
    await openScaling(page, EMPTY);

    await expect(page.getByTestId('scaling-empty')).toHaveText('No scaling policies yet.');
    await expect(screen(page)).toHaveAttribute('data-state', 'empty');
    await expect(allCards(page)).toHaveCount(0);
    await expect(screen(page).getByRole('alert')).toHaveCount(0);

    await addDraft(page, 'throughput');
    await expect(screen(page)).toHaveAttribute('data-state', 'list');
    await expect(page.getByTestId('scaling-empty')).toHaveCount(0);
    await expect(draftCards(page)).toHaveCount(1);
  });

  test('list: saved cards render locked to their agent, sorted by agent name', async ({ page }) => {
    await openScaling(page, CONFIGURED);

    await expect(allCards(page)).toHaveCount(2);
    await expect(allCards(page).nth(0)).toHaveAttribute('data-agent', 'enricher');
    await expect(allCards(page).nth(1)).toHaveAttribute('data-agent', 'summarizer');

    const enricher = policyCard(savedCard(page, 'enricher'));
    await expect(enricher.root).toHaveAttribute('data-kind', 'queue_length');
    await expect(enricher.root.getByRole('heading', { name: 'Queue length' })).toBeVisible();
    await expect(enricher.agent).toHaveText('enricher');
    await expect(enricher.root.getByRole('combobox')).toHaveCount(0);
    await expect(enricher.discard).toHaveCount(0);
    await expectValues(enricher, ENRICHER_POLICY);

    const summarizer = policyCard(savedCard(page, 'summarizer'));
    await expect(summarizer.root).toHaveAttribute('data-kind', 'throughput');
    await expect(summarizer.root.getByRole('heading', { name: 'Throughput' })).toBeVisible();
    await expectValues(summarizer, SUMMARIZER_POLICY);
  });
});

test.describe('drafts', () => {
  test('a new draft starts unpicked with the kind defaults and cannot save yet', async ({
    page,
  }) => {
    await openScaling(page, CONFIGURED);
    await addDraft(page, 'queue_length');

    const draft = policyCard(draftCards(page));
    await expect(draft.root).toHaveAttribute('data-kind', 'queue_length');
    await expect(draft.agent).toHaveText('Select an agent');
    await expect(draft.save).toBeDisabled();
    await expect(draft.delete).toHaveCount(0);
    await expectValues(draft, {
      scale_up_above: 3,
      scale_down_below: 1,
      min_replicas: 1,
      max_replicas: 5,
    });
    await expect(await agentOptions(draft)).toHaveText(['classifier', 'router']);
  });

  test('an agent claimed by one draft is not offered in another, and Add disables when none is free', async ({
    page,
  }) => {
    await openScaling(page, EMPTY);
    await addDraft(page, 'throughput');
    await addDraft(page, 'queue_length');
    const first = policyCard(draftCards(page).and(page.locator('[data-kind="throughput"]')));
    const second = policyCard(draftCards(page).and(page.locator('[data-kind="queue_length"]')));

    await pickAgent(first, 'classifier');
    await expect(await agentOptions(second)).toHaveText(['router']);
    await page.getByRole('option', { name: 'router', exact: true }).click();
    await expect(second.agent).toHaveText('router');
    await expect(addButton(page)).toBeDisabled();

    await expect(await agentOptions(first)).toHaveText(['classifier']);
    await page.keyboard.press('Escape');

    await first.discard.click();
    await expect(draftCards(page)).toHaveCount(1);
    await expect(second.agent).toHaveText('router');
    await expect(addButton(page)).toBeEnabled();
  });

  test('Discard removes the draft without a request and returns to the empty state', async ({
    page,
  }) => {
    const stub = await openScaling(page, EMPTY);
    await addDraft(page, 'throughput');
    const draft = policyCard(draftCards(page));
    await pickAgent(draft, 'router');

    await draft.discard.click();
    await expect(draftCards(page)).toHaveCount(0);
    await expect(page.getByTestId('scaling-empty')).toBeVisible();
    expect(stub.writes).toEqual([]);
    expect(stub.reads).toBe(1);
  });

  test('saving a draft PUTs it, toasts, re-reads, and turns the draft into a saved card', async ({
    page,
  }) => {
    const stub = await openScaling(page, CONFIGURED);
    await expect(allCards(page)).toHaveCount(2);
    await addDraft(page, 'throughput');
    const draft = policyCard(draftCards(page));
    await pickAgent(draft, 'router');
    await draft.scale_up.increase.click();
    await draft.scale_up.increase.click();
    await draft.scale_down.increase.click();
    await draft.max_replicas.increase.click();
    await draft.min_replicas.increase.click();
    expect(stub.writes).toEqual([]);

    const hold = deferred();
    stub.write_hold = hold.promise;
    await draft.save.click();
    try {
      await expect(draft.save).toHaveText('Saving…');
      await expect(draft.save).toBeDisabled();
      await expect(draft.discard).toBeDisabled();
      await expect(draft.agent).toBeDisabled();
    } finally {
      hold.release();
    }

    await expect(toast(page)).toContainText('Scaling policy saved for router');
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
        path: `${SCALING_PATH}/router`,
        body: {
          min_replicas: 2,
          max_replicas: 6,
          metric: 'requests_per_minute_per_replica',
          scale_up_above: 12,
          scale_down_below: 2,
        },
      },
    ]);
    await expect.poll(() => stub.reads).toBe(2);
    await expect(draftCards(page)).toHaveCount(0);
    await expect(allCards(page)).toHaveCount(3);
    await expect(allCards(page).nth(1)).toHaveAttribute('data-agent', 'router');
    const router = policyCard(savedCard(page, 'router'));
    await expect(router.root).toHaveAttribute('data-kind', 'throughput');
    await expectValues(router, {
      scale_up_above: 12,
      scale_down_below: 2,
      min_replicas: 2,
      max_replicas: 6,
    });

    await addDraft(page, 'queue_length');
    await expect(await agentOptions(policyCard(draftCards(page)))).toHaveText(['classifier']);
  });

  test('a failed draft save alerts in the card, keeps the draft and its values, and does not re-read', async ({
    page,
  }) => {
    const stub = await openScaling(page, EMPTY);
    stub.write_failure = (route) => failJson(route, UNREACHABLE);
    await addDraft(page, 'throughput');
    const draft = policyCard(draftCards(page));
    await pickAgent(draft, 'classifier');
    await draft.scale_up.increase.click();
    await draft.save.click();

    await expect(draft.error).toHaveText(UNREACHABLE);
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
        path: `${SCALING_PATH}/classifier`,
        body: {
          min_replicas: 1,
          max_replicas: 5,
          metric: 'requests_per_minute_per_replica',
          scale_up_above: 11,
          scale_down_below: 1,
        },
      },
    ]);
    await expect(draft.agent).toHaveText('classifier');
    await expect(draft.agent).toBeEnabled();
    await expectValues(draft, {
      scale_up_above: 11,
      scale_down_below: 1,
      min_replicas: 1,
      max_replicas: 5,
    });
    await expect(draft.save).toBeEnabled();
    await expect(draftCards(page)).toHaveCount(1);
    await expect(toast(page)).toHaveCount(0);
    expect(stub.reads).toBe(1);
  });
});

test.describe('saved cards', () => {
  test('editing a saved policy PUTs the exact values, toasts, and re-reads', async ({ page }) => {
    const stub = await openScaling(page, CONFIGURED);
    const summarizer = policyCard(savedCard(page, 'summarizer'));
    await summarizer.max_replicas.decrease.click();
    await summarizer.min_replicas.decrease.click();
    await summarizer.scale_down.decrease.click();

    await summarizer.save.click();
    await expect(toast(page)).toContainText('Scaling policy saved for summarizer');
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
        path: `${SCALING_PATH}/summarizer`,
        body: {
          min_replicas: 1,
          max_replicas: 7,
          metric: 'requests_per_minute_per_replica',
          scale_up_above: 40,
          scale_down_below: 4,
        },
      },
    ]);
    await expect.poll(() => stub.reads).toBe(2);
    await expectValues(summarizer, {
      scale_up_above: 40,
      scale_down_below: 4,
      min_replicas: 1,
      max_replicas: 7,
    });
    await expect(summarizer.error).toHaveCount(0);
  });

  test('Delete sends DELETE for that agent, and the card is gone after the re-read', async ({
    page,
  }) => {
    const stub = await openScaling(page, CONFIGURED);
    const enricher = policyCard(savedCard(page, 'enricher'));

    const hold = deferred();
    stub.write_hold = hold.promise;
    await enricher.delete.click();
    try {
      await expect(enricher.delete).toHaveText('Deleting…');
      await expect(enricher.delete).toBeDisabled();
      await expect(enricher.save).toBeDisabled();
    } finally {
      hold.release();
    }

    await expect(toast(page)).toContainText('Scaling policy deleted for enricher');
    expect(stub.writes).toEqual([
      { method: 'DELETE', path: `${SCALING_PATH}/enricher`, body: null },
    ]);
    await expect.poll(() => stub.reads).toBe(2);
    await expect(savedCard(page, 'enricher')).toHaveCount(0);
    await expect(allCards(page)).toHaveCount(1);

    await addDraft(page, 'throughput');
    await expect(await agentOptions(policyCard(draftCards(page)))).toHaveText([
      'classifier',
      'enricher',
      'router',
    ]);
  });

  test('deleting the last policy returns to the empty state', async ({ page }) => {
    await openScaling(page, { ...EMPTY, policies: { router: ENRICHER_POLICY } });
    await policyCard(savedCard(page, 'router')).delete.click();

    await expect(page.getByTestId('scaling-empty')).toBeVisible();
    await expect(allCards(page)).toHaveCount(0);
  });

  test('a failed delete alerts in the card and keeps it', async ({ page }) => {
    const stub = await openScaling(page, CONFIGURED);
    stub.write_failure = (route) =>
      fulfillJson(
        route,
        { error: 'scaling.policy_not_found', message: 'No scaling policy for enricher' },
        404
      );
    const enricher = policyCard(savedCard(page, 'enricher'));
    await enricher.delete.click();

    await expect(enricher.error).toHaveText('No scaling policy for enricher');
    await expect(enricher.delete).toHaveText('Delete');
    await expect(enricher.delete).toBeEnabled();
    await expectValues(enricher, ENRICHER_POLICY);
    await expect(toast(page)).toHaveCount(0);
    expect(stub.reads).toBe(1);
  });
});

test.describe('invalid cards', () => {
  const WITH_INVALID: ScalingResponse = { ...CONFIGURED, invalid: ['classifier'] };

  test('an invalid stored policy gets its own card, is not offered to drafts, and can be deleted', async ({
    page,
  }) => {
    const stub = await openScaling(page, WITH_INVALID);
    const classifier = invalidCard(page, 'classifier');
    await expect(classifier).toBeVisible();
    await expect(classifier.getByTestId('policy-invalid')).toContainText(
      'the controller ignores it'
    );
    await expect(classifier.getByTestId('policy-save')).toHaveCount(0);
    await expect(allCards(page)).toHaveCount(3);

    await addDraft(page, 'throughput');
    await expect(await agentOptions(policyCard(draftCards(page)))).toHaveText(['router']);
    await page.keyboard.press('Escape');

    await classifier.getByTestId('policy-delete').click();
    await expect(toast(page)).toContainText('Scaling policy deleted for classifier');
    expect(stub.writes).toEqual([
      { method: 'DELETE', path: `${SCALING_PATH}/classifier`, body: null },
    ]);
    await expect(invalidCard(page, 'classifier')).toHaveCount(0);
    await expect(await agentOptions(policyCard(draftCards(page)))).toHaveText([
      'classifier',
      'router',
    ]);
  });

  test('only invalid policies still count as a list, not the empty state', async ({ page }) => {
    await openScaling(page, { ...EMPTY, invalid: ['router'] });
    await expect(invalidCard(page, 'router')).toBeVisible();
    await expect(page.getByTestId('scaling-empty')).toHaveCount(0);
  });
});

test('Add is disabled when every running agent already has a policy', async ({ page }) => {
  await openScaling(page, {
    agents: ['enricher', 'summarizer', 'router'],
    policies: { summarizer: SUMMARIZER_POLICY, enricher: ENRICHER_POLICY },
    invalid: ['router'],
  });
  await expect(allCards(page)).toHaveCount(3);
  await expect(addButton(page)).toBeDisabled();
});

test.describe('steppers', () => {
  test('min replicas never goes below 1', async ({ page }) => {
    await openScaling(page, CONFIGURED);
    const summarizer = policyCard(savedCard(page, 'summarizer'));
    await expect(summarizer.min_replicas.decrease).toBeEnabled();
    await summarizer.min_replicas.decrease.click();
    await expect(summarizer.min_replicas.value).toHaveText('1');
    await expect(summarizer.min_replicas.decrease).toBeDisabled();

    await addDraft(page, 'throughput');
    const draft = policyCard(draftCards(page));
    await expect(draft.min_replicas.value).toHaveText('1');
    await expect(draft.min_replicas.decrease).toBeDisabled();
  });

  test('min replicas stays at or below max, and scale-down below scale-up', async ({ page }) => {
    await openScaling(page, EMPTY);
    await addDraft(page, 'queue_length');
    const draft = policyCard(draftCards(page));

    for (let step = 0; step < 4; step += 1) await draft.min_replicas.increase.click();
    await expect(draft.min_replicas.value).toHaveText('5');
    await expect(draft.min_replicas.increase).toBeDisabled();
    await expect(draft.max_replicas.decrease).toBeDisabled();

    await draft.max_replicas.increase.click();
    await expect(draft.max_replicas.value).toHaveText('6');
    await expect(draft.min_replicas.increase).toBeEnabled();
    await expect(draft.max_replicas.decrease).toBeEnabled();

    await draft.scale_down.increase.click();
    await expect(draft.scale_down.value).toHaveText('2');
    await expect(draft.scale_down.increase).toBeDisabled();
    await expect(draft.scale_up.decrease).toBeDisabled();

    await draft.scale_up.increase.click();
    await expect(draft.scale_up.value).toHaveText('4');
    await expect(draft.scale_down.increase).toBeEnabled();
    await expect(draft.scale_up.decrease).toBeEnabled();
  });
});

test('cards and stepper buttons have accessible names', async ({ page }) => {
  await openScaling(page, { ...CONFIGURED, invalid: ['classifier'] });
  await addDraft(page, 'queue_length');

  const summarizer = page.getByRole('region', { name: 'Throughput policy for summarizer' });
  await expect(summarizer).toHaveAttribute('data-testid', 'scaling-policy-saved');
  await expect(
    page.getByRole('region', { name: 'Queue length policy for enricher' })
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Invalid policy for classifier' })).toHaveAttribute(
    'data-testid',
    'scaling-policy-invalid'
  );
  await expect(page.getByRole('region', { name: 'New queue length policy' })).toHaveAttribute(
    'data-testid',
    'scaling-policy-draft'
  );

  for (const name of [
    'Increase scale-up threshold',
    'Decrease scale-up threshold',
    'Increase scale-down threshold',
    'Decrease scale-down threshold',
    'Increase min replicas',
    'Decrease min replicas',
    'Increase max replicas',
    'Decrease max replicas',
  ]) {
    await expect(summarizer.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
  await summarizer.getByRole('button', { name: 'Increase max replicas' }).click();
  await expect(summarizer.getByTestId('policy-max-replicas-value')).toHaveText('9');
});
