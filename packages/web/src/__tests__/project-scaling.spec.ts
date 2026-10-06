import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

import type { ScalingAgent, ScalingPolicy, ScalingStatus } from '@canyonos/api/scaling';

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
const AGENTS_PATH = `${SCALING_PATH}/agents`;
const UNREACHABLE = 'The running controller could not be reached';
const SAVED_TOAST = "Scaling policy saved. Agents pick it up on the controller's next poll.";
const DELETED_TOAST =
  'Scaling policy deleted. Agents keep their current replicas until the next reload.';

const THROUGHPUT_POLICY: ScalingPolicy = {
  min_replicas: 2,
  max_replicas: 8,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 40,
  scale_down_below: 5,
};

const QUEUE_POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'queue_length_total',
  scale_up_above: 6,
  scale_down_below: 2,
};

const APPLIED: ScalingStatus = { status: 'applied', policy: THROUGHPUT_POLICY };
const NONE: ScalingStatus = { status: 'none' };
const INVALID: ScalingStatus = {
  status: 'invalid',
  reason: 'max_replicas: max_replicas must be greater than or equal to min_replicas',
};

const AGENTS: ScalingAgent[] = [
  {
    name: 'PriceAgent',
    replicas_expected: 2,
    replicas_running: 1,
    load: {
      queue_length_total: 3,
      requests_per_minute_per_replica: 12.5,
      observed_at: '2026-10-06T12:00:00.000Z',
    },
  },
  { name: 'RiskAgent', replicas_expected: 1, replicas_running: 1, load: null },
];

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
  policy: ScalingStatus;
  read_hold: Promise<void> | null;
  read_failure: Respond | null;
  writes: WriteRequest[];
  write_hold: Promise<void> | null;
  write_failure: Respond | null;
  agent_reads: number;
  agents: ScalingAgent[];
  agents_failure: Respond | null;
}

interface WriteRequest {
  readonly method: string;
  readonly body: unknown;
}

async function stubScaling(
  page: Page,
  policy: ScalingStatus,
  agents: ScalingAgent[] = AGENTS
): Promise<ScalingStub> {
  const stub: ScalingStub = {
    reads: 0,
    policy: structuredClone(policy),
    read_hold: null,
    read_failure: null,
    writes: [],
    write_hold: null,
    write_failure: null,
    agent_reads: 0,
    agents: structuredClone(agents),
    agents_failure: null,
  };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === AGENTS_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      stub.agent_reads += 1;
      if (stub.agents_failure) return stub.agents_failure(route);
      return fulfillJson(route, { agents: stub.agents });
    }
  );
  // Writes behave like the controller config: a PUT stores the policy, a DELETE drops it.
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === SCALING_PATH,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        stub.reads += 1;
        if (stub.read_hold) await stub.read_hold;
        if (stub.read_failure) return stub.read_failure(route);
        return fulfillJson(route, stub.policy);
      }
      if (request.method() !== 'PUT' && request.method() !== 'DELETE') return route.continue();
      stub.writes.push({ method: request.method(), body: request.postDataJSON() });
      if (stub.write_hold) await stub.write_hold;
      if (stub.write_failure) return stub.write_failure(route);
      if (request.method() === 'DELETE') {
        stub.policy = NONE;
        return fulfillJson(route, NONE);
      }
      const policy = request.postDataJSON() as ScalingPolicy;
      stub.policy = { status: 'applied', policy };
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

async function openScaling(
  page: Page,
  policy: ScalingStatus,
  agents: ScalingAgent[] = AGENTS
): Promise<ScalingStub> {
  await openSession(page);
  const stub = await stubScaling(page, policy, agents);
  await page.goto(SCALING_PATH);
  await expect(screen(page)).toHaveAttribute('data-state', 'ready');
  return stub;
}

const screen = (page: Page) => page.getByTestId('scaling-screen');
const policyCard = (page: Page) => page.getByTestId('scaling-policy');
const noneCard = (page: Page) => page.getByTestId('scaling-policy-none');
const appliedCard = (page: Page) => page.getByTestId('scaling-policy-applied');
const invalidCard = (page: Page) => page.getByTestId('scaling-policy-invalid');
const editorCard = (page: Page) => page.getByTestId('scaling-policy-editor');
const agentsPanel = (page: Page) => page.getByTestId('scaling-agents');
const toast = (page: Page) => page.getByTestId('app-toast');

function stepper(root: Locator, test_id: string) {
  return {
    value: root.getByTestId(`${test_id}-value`),
    increase: root.getByTestId(`${test_id}-increase`),
    decrease: root.getByTestId(`${test_id}-decrease`),
  };
}

function editor(page: Page) {
  const root = editorCard(page);
  return {
    root,
    save: root.getByTestId('policy-save'),
    cancel: root.getByTestId('policy-cancel'),
    kind: (kind: 'throughput' | 'queue_length') => root.getByTestId(`policy-kind-${kind}`),
    error: root.getByRole('alert'),
    scale_up: stepper(root, 'policy-scale-up-threshold'),
    scale_down: stepper(root, 'policy-scale-down-threshold'),
    min_replicas: stepper(root, 'policy-min-replicas'),
    max_replicas: stepper(root, 'policy-max-replicas'),
  };
}

type Editor = ReturnType<typeof editor>;

async function expectEditorValues(form: Editor, values: Omit<ScalingPolicy, 'metric'>) {
  await expect(form.scale_up.value).toHaveValue(String(values.scale_up_above));
  await expect(form.scale_down.value).toHaveValue(String(values.scale_down_below));
  await expect(form.min_replicas.value).toHaveValue(String(values.min_replicas));
  await expect(form.max_replicas.value).toHaveValue(String(values.max_replicas));
}

async function expectAppliedValues(card: Locator, values: Omit<ScalingPolicy, 'metric'>) {
  await expect(card.getByTestId('policy-scale-up-threshold-value')).toHaveText(
    String(values.scale_up_above)
  );
  await expect(card.getByTestId('policy-scale-down-threshold-value')).toHaveText(
    String(values.scale_down_below)
  );
  await expect(card.getByTestId('policy-min-replicas-value')).toHaveText(
    String(values.min_replicas)
  );
  await expect(card.getByTestId('policy-max-replicas-value')).toHaveText(
    String(values.max_replicas)
  );
}

test('@smoke the Scaling row opens the scaling screen and is the row marked current', async ({
  page,
}) => {
  await openSession(page);
  await stubScaling(page, APPLIED);
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
  await expect(screen(page)).toHaveAttribute('data-state', 'ready');
  await expect(appliedCard(page)).toBeVisible();
  await expect(scaling).toHaveAttribute('aria-current', 'page');
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
  await expect(prompts).not.toHaveAttribute('aria-current', 'page');
});

test.describe('screen states', () => {
  test('loading: a pending read shows the loading state and no card', async ({ page }) => {
    await openSession(page);
    const stub = await stubScaling(page, NONE);
    const hold = deferred();
    stub.read_hold = hold.promise;
    await page.goto(SCALING_PATH);

    try {
      await expect.poll(() => stub.reads).toBe(1);
      await expect(screen(page)).toHaveAttribute('data-state', 'loading');
      await expect(page.getByTestId('scaling-loading')).toBeVisible();
      await expect(policyCard(page)).toHaveCount(0);
      await expect(agentsPanel(page)).toHaveCount(0);
    } finally {
      hold.release();
    }

    await expect(screen(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('scaling-loading')).toHaveCount(0);
    await expect(noneCard(page)).toBeVisible();
  });

  for (const failure of [
    {
      status: 404,
      code: 'canyonos.project_not_running',
      message: 'This project is not running, so its scaling policy cannot be read.',
    },
    { status: 502, code: 'canyonos.controller_unreachable', message: UNREACHABLE },
    { status: 500, code: 'test.failure', message: 'Controlled test failure' },
  ]) {
    test(`error: a failed read (${failure.status}) shows only the error`, async ({ page }) => {
      await openSession(page);
      const stub = await stubScaling(page, NONE);
      stub.read_failure = (route) =>
        fulfillJson(route, { error: failure.code, message: failure.message }, failure.status);
      await page.goto(SCALING_PATH);

      await expect(page.getByTestId('scaling-error')).toContainText(failure.message);
      await expect(screen(page)).toHaveAttribute('data-state', 'error');
      await expect(policyCard(page)).toHaveCount(0);
      await expect(agentsPanel(page)).toHaveCount(0);
      expect(stub.reads).toBe(1);
    });
  }

  test('error -> Retry -> ready: Retry re-reads and replaces the error with the policy', async ({
    page,
  }) => {
    await openSession(page);
    const stub = await stubScaling(page, APPLIED);
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

    await expect(screen(page)).toHaveAttribute('data-state', 'ready');
    await expect(appliedCard(page)).toBeVisible();
    expect(stub.reads).toBe(2);
  });

  test('none: no stored policy shows the empty card with Add policy', async ({ page }) => {
    await openScaling(page, NONE);

    await expect(policyCard(page)).toHaveAttribute('data-policy', 'none');
    await expect(policyCard(page)).toHaveAttribute('data-state', 'closed');
    await expect(noneCard(page)).toContainText(
      'keeps its current replica count until the next reload'
    );
    await expect(noneCard(page).getByTestId('policy-add')).toBeEnabled();
    await expect(editorCard(page)).toHaveCount(0);
    await expect(screen(page).getByRole('alert')).toHaveCount(0);
  });

  for (const { kind, heading, policy } of [
    { kind: 'throughput', heading: 'Throughput policy', policy: THROUGHPUT_POLICY },
    { kind: 'queue_length', heading: 'Queue length policy', policy: QUEUE_POLICY },
  ]) {
    test(`applied: a stored ${kind} policy reads as three plain rules`, async ({ page }) => {
      await openScaling(page, { status: 'applied', policy });

      const card = appliedCard(page);
      await expect(card).toHaveAttribute('data-kind', kind);
      await expect(card).toHaveAttribute('data-state', 'viewing');
      await expect(card.getByRole('heading', { name: heading })).toBeVisible();
      await expectAppliedValues(card, policy);
      await expect(card.getByTestId('policy-edit')).toBeEnabled();
      await expect(card.getByTestId('policy-delete')).toBeEnabled();
      await expect(page.getByTestId('scaling-scope')).toContainText(
        'One policy for the whole workflow'
      );
    });
  }

  test('invalid: a stored policy the controller skips shows its reason and only Delete', async ({
    page,
  }) => {
    await openScaling(page, INVALID);

    const card = invalidCard(page);
    await expect(card).toHaveAttribute('data-state', 'viewing');
    await expect(card.getByTestId('policy-invalid')).toContainText(INVALID.reason);
    await expect(card.getByTestId('policy-invalid')).toContainText('the controller ignores it');
    await expect(card.getByTestId('policy-delete')).toBeEnabled();
    await expect(card.getByTestId('policy-replace')).toBeEnabled();
    await expect(card.getByTestId('policy-edit')).toHaveCount(0);
    await expect(noneCard(page)).toHaveCount(0);
  });
});

test.describe('adding a policy', () => {
  test('Add policy opens the editor on the throughput defaults', async ({ page }) => {
    const stub = await openScaling(page, NONE);

    await noneCard(page).getByTestId('policy-add').click();

    const form = editor(page);
    await expect(form.root).toHaveAttribute('data-state', 'editing');
    await expect(form.root).toHaveAttribute('data-kind', 'throughput');
    await expect(form.root).toHaveAccessibleName('New scaling policy');
    await expect(form.kind('throughput')).toHaveAttribute('aria-checked', 'true');
    await expectEditorValues(form, {
      scale_up_above: 10,
      scale_down_below: 1,
      min_replicas: 1,
      max_replicas: 5,
    });
    await expect(form.save).toBeEnabled();
    await expect(policyCard(page)).toHaveAttribute('data-state', 'open');
    await expect(noneCard(page)).toBeHidden();
    expect(stub.writes).toEqual([]);
  });

  test('switching to queue length resets the thresholds and keeps the replicas', async ({
    page,
  }) => {
    await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);
    await form.max_replicas.increase.click();

    await form.kind('queue_length').click();

    await expect(form.root).toHaveAttribute('data-kind', 'queue_length');
    await expect(form.kind('queue_length')).toHaveAttribute('aria-checked', 'true');
    await expect(form.root).toContainText('waiting requests');
    await expectEditorValues(form, {
      scale_up_above: 3,
      scale_down_below: 1,
      min_replicas: 1,
      max_replicas: 6,
    });
  });

  test('Cancel drops the draft without a request and returns to the empty card', async ({
    page,
  }) => {
    const stub = await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);
    await form.scale_up.increase.click();

    await form.cancel.click();

    await expect(editorCard(page)).toHaveCount(0);
    await expect(noneCard(page)).toBeVisible();
    await expect(policyCard(page)).toHaveAttribute('data-state', 'closed');
    expect(stub.writes).toEqual([]);
    expect(stub.reads).toBe(1);
  });

  test('Save policy PUTs the values, shows saving, toasts, re-reads, and shows the applied card', async ({
    page,
  }) => {
    const stub = await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);
    await form.scale_up.increase.click();
    await form.scale_up.increase.click();
    await form.scale_down.increase.click();
    await form.max_replicas.increase.click();
    await form.min_replicas.increase.click();
    expect(stub.writes).toEqual([]);

    const hold = deferred();
    stub.write_hold = hold.promise;
    await form.save.click();
    try {
      await expect(form.root).toHaveAttribute('data-state', 'saving');
      await expect(form.save).toHaveText('Saving…');
      await expect(form.save).toBeDisabled();
      await expect(form.cancel).toBeDisabled();
      await expect(form.scale_up.increase).toBeDisabled();
    } finally {
      hold.release();
    }

    await expect(toast(page)).toContainText(SAVED_TOAST);
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
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
    await expect(editorCard(page)).toHaveCount(0);
    const card = appliedCard(page);
    await expect(card).toHaveAttribute('data-kind', 'throughput');
    await expectAppliedValues(card, {
      scale_up_above: 12,
      scale_down_below: 2,
      min_replicas: 2,
      max_replicas: 6,
    });
    await expect.poll(() => stub.agent_reads).toBeGreaterThan(1);
  });

  test('a failed save alerts in the editor, keeps the values, and does not re-read', async ({
    page,
  }) => {
    const stub = await openScaling(page, NONE);
    stub.write_failure = (route) => failJson(route, UNREACHABLE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);
    await form.scale_up.increase.click();

    await form.save.click();

    await expect(form.error).toHaveText(UNREACHABLE);
    await expect(form.root).toHaveAttribute('data-state', 'editing');
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
        body: {
          min_replicas: 1,
          max_replicas: 5,
          metric: 'requests_per_minute_per_replica',
          scale_up_above: 11,
          scale_down_below: 1,
        },
      },
    ]);
    await expectEditorValues(form, {
      scale_up_above: 11,
      scale_down_below: 1,
      min_replicas: 1,
      max_replicas: 5,
    });
    await expect(form.save).toBeEnabled();
    await expect(toast(page)).toHaveCount(0);
    expect(stub.reads).toBe(1);
  });

  test('a 422 from the API is shown with its message', async ({ page }) => {
    const stub = await openScaling(page, NONE);
    stub.write_failure = (route) =>
      fulfillJson(
        route,
        {
          error: 'validation.failed',
          message: 'Validation failed',
          details: [
            {
              summary: 'scale_down_below must be less than scale_up_above',
              message: 'scale_down_below must be less than scale_up_above',
              path: 'scale_down_below',
            },
          ],
        },
        422
      );
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);

    await form.save.click();

    await expect(form.error).toHaveText('scale_down_below must be less than scale_up_above');
    await expect(form.root).toHaveAttribute('data-state', 'editing');
  });
});

test.describe('editing the applied policy', () => {
  test('Edit opens the editor on the stored values and its kind', async ({ page }) => {
    await openScaling(page, { status: 'applied', policy: QUEUE_POLICY });

    await appliedCard(page).getByTestId('policy-edit').click();

    const form = editor(page);
    await expect(form.root).toHaveAttribute('data-kind', 'queue_length');
    await expect(form.root).toHaveAccessibleName('Edit scaling policy');
    await expectEditorValues(form, QUEUE_POLICY);
    await expect(appliedCard(page)).toBeHidden();
  });

  test('Cancel returns to the applied card unchanged', async ({ page }) => {
    const stub = await openScaling(page, APPLIED);
    await appliedCard(page).getByTestId('policy-edit').click();
    const form = editor(page);
    await form.max_replicas.decrease.click();

    await form.cancel.click();

    await expectAppliedValues(appliedCard(page), THROUGHPUT_POLICY);
    expect(stub.writes).toEqual([]);
  });

  test('Save policy PUTs the exact values, toasts, and re-reads', async ({ page }) => {
    const stub = await openScaling(page, APPLIED);
    await appliedCard(page).getByTestId('policy-edit').click();
    const form = editor(page);
    await form.max_replicas.decrease.click();
    await form.min_replicas.decrease.click();
    await form.scale_down.decrease.click();

    await form.save.click();

    await expect(toast(page)).toContainText(SAVED_TOAST);
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
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
    await expectAppliedValues(appliedCard(page), {
      scale_up_above: 40,
      scale_down_below: 4,
      min_replicas: 1,
      max_replicas: 7,
    });
    await expect(screen(page).getByRole('alert')).toHaveCount(0);
  });

  test('Delete policy sends DELETE, shows deleting, toasts, and the empty card returns', async ({
    page,
  }) => {
    const stub = await openScaling(page, APPLIED);
    const card = appliedCard(page);

    const hold = deferred();
    stub.write_hold = hold.promise;
    await card.getByTestId('policy-delete').click();
    try {
      await expect(card).toHaveAttribute('data-state', 'deleting');
      await expect(card.getByTestId('policy-delete')).toBeDisabled();
      await expect(card.getByTestId('policy-edit')).toBeDisabled();
    } finally {
      hold.release();
    }

    await expect(toast(page)).toContainText(DELETED_TOAST);
    expect(stub.writes).toEqual([{ method: 'DELETE', body: null }]);
    await expect.poll(() => stub.reads).toBe(2);
    await expect(appliedCard(page)).toHaveCount(0);
    await expect(noneCard(page)).toBeVisible();
  });

  test('a failed delete alerts in the card and keeps it editable', async ({ page }) => {
    const stub = await openScaling(page, APPLIED);
    stub.write_failure = (route) =>
      fulfillJson(
        route,
        { error: 'scaling.policy_not_found', message: 'No scaling policy is stored' },
        404
      );
    const card = appliedCard(page);

    await card.getByTestId('policy-delete').click();

    await expect(card.getByRole('alert')).toHaveText('No scaling policy is stored');
    await expect(card).toHaveAttribute('data-state', 'viewing');
    await expect(card.getByTestId('policy-delete')).toBeEnabled();
    await expect(card.getByTestId('policy-edit')).toBeEnabled();
    await expectAppliedValues(card, THROUGHPUT_POLICY);
    await expect(toast(page)).toHaveCount(0);
    expect(stub.reads).toBe(1);
  });
});

test.describe('invalid policy', () => {
  test('Delete policy clears it and the empty card returns', async ({ page }) => {
    const stub = await openScaling(page, INVALID);

    await invalidCard(page).getByTestId('policy-delete').click();

    await expect(toast(page)).toContainText(DELETED_TOAST);
    expect(stub.writes).toEqual([{ method: 'DELETE', body: null }]);
    await expect(invalidCard(page)).toHaveCount(0);
    await expect(noneCard(page)).toBeVisible();
  });

  test('a failed delete alerts in the card', async ({ page }) => {
    const stub = await openScaling(page, INVALID);
    stub.write_failure = (route) => failJson(route, UNREACHABLE);

    await invalidCard(page).getByTestId('policy-delete').click();

    await expect(invalidCard(page).getByRole('alert')).toHaveText(UNREACHABLE);
    await expect(invalidCard(page)).toHaveAttribute('data-state', 'viewing');
    await expect(invalidCard(page).getByTestId('policy-delete')).toBeEnabled();
  });

  test('Replace policy opens a new draft and saving it overwrites the invalid one', async ({
    page,
  }) => {
    const stub = await openScaling(page, INVALID);

    await invalidCard(page).getByTestId('policy-replace').click();

    const form = editor(page);
    await expect(form.root).toHaveAccessibleName('New scaling policy');
    await expect(invalidCard(page)).toBeHidden();
    await form.save.click();
    await expect(toast(page)).toContainText(SAVED_TOAST);
    expect(stub.writes).toEqual([
      {
        method: 'PUT',
        body: {
          min_replicas: 1,
          max_replicas: 5,
          metric: 'requests_per_minute_per_replica',
          scale_up_above: 10,
          scale_down_below: 1,
        },
      },
    ]);
    await expect(appliedCard(page)).toBeVisible();
  });
});

test.describe('editor values', () => {
  test('replica counts can be typed and are clamped to their bounds on commit', async ({
    page,
  }) => {
    await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);

    await form.max_replicas.value.fill('12');
    await form.max_replicas.value.press('Enter');
    await expect(form.max_replicas.value).toHaveValue('12');
    await expect(form.root).toHaveAttribute('data-state', 'editing');

    await form.min_replicas.value.fill('20');
    await form.min_replicas.value.blur();
    await expect(form.min_replicas.value).toHaveValue('12');

    await form.min_replicas.value.fill('abc');
    await form.min_replicas.value.blur();
    await expect(form.min_replicas.value).toHaveValue('12');

    await form.min_replicas.value.fill('0');
    await form.min_replicas.value.blur();
    await expect(form.min_replicas.value).toHaveValue('1');
  });

  test('a typed value pulled back inside its bounds says which rule did it, briefly', async ({
    page,
  }) => {
    await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);
    const notice = page.getByTestId('policy-scale-down-threshold-notice');

    await form.scale_down.value.fill('50');
    await form.scale_down.value.press('Tab');

    await expect(form.scale_down.value).toHaveValue('9');
    await expect(form.scale_down.value).toHaveAttribute('aria-invalid', 'true');
    await expect(notice).toHaveText('Kept at 9: scale down must stay below scale up');
    await form.scale_down.value.fill('3');
    await expect(notice).toHaveCount(0);
    await expect(form.scale_down.value).not.toHaveAttribute('aria-invalid', 'true');
    await form.scale_down.value.press('Tab');
    await expect(form.scale_down.value).toHaveValue('3');

    await form.min_replicas.value.fill('abc');
    await form.min_replicas.value.press('Tab');
    await expect(form.min_replicas.value).toHaveValue('1');
    await expect(page.getByTestId('policy-min-replicas-notice')).toHaveText('Whole numbers only');

    await form.max_replicas.value.fill('0');
    await form.max_replicas.value.press('Tab');
    await expect(form.max_replicas.value).toHaveValue('1');
    await expect(page.getByTestId('policy-max-replicas-notice')).toHaveText(
      'Kept at 1: max replicas cannot drop below min replicas'
    );
  });

  test('min replicas never goes below 1', async ({ page }) => {
    await openScaling(page, APPLIED);
    await appliedCard(page).getByTestId('policy-edit').click();
    const form = editor(page);
    await expect(form.min_replicas.decrease).toBeEnabled();

    await form.min_replicas.decrease.click();

    await expect(form.min_replicas.value).toHaveValue('1');
    await expect(form.min_replicas.decrease).toBeDisabled();
  });

  test('min replicas stays at or below max, and scale-down below scale-up', async ({ page }) => {
    await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    await editor(page).kind('queue_length').click();
    const form = editor(page);
    await expect(form.min_replicas.value).toHaveValue('1');
    await expect(form.min_replicas.decrease).toBeDisabled();

    for (let step = 0; step < 4; step += 1) await form.min_replicas.increase.click();
    await expect(form.min_replicas.value).toHaveValue('5');
    await expect(form.min_replicas.increase).toBeDisabled();
    await expect(form.max_replicas.decrease).toBeDisabled();

    await form.max_replicas.increase.click();
    await expect(form.max_replicas.value).toHaveValue('6');
    await expect(form.min_replicas.increase).toBeEnabled();
    await expect(form.max_replicas.decrease).toBeEnabled();

    await form.scale_down.increase.click();
    await expect(form.scale_down.value).toHaveValue('2');
    await expect(form.scale_down.increase).toBeDisabled();
    await expect(form.scale_up.decrease).toBeDisabled();

    await form.scale_up.increase.click();
    await expect(form.scale_up.value).toHaveValue('4');
    await expect(form.scale_down.increase).toBeEnabled();
    await expect(form.scale_up.decrease).toBeEnabled();
  });

  test('Enter in a value commits it and does not save the policy', async ({ page }) => {
    const stub = await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').click();
    const form = editor(page);

    await form.scale_up.value.fill('15');
    await form.scale_up.value.press('Enter');

    await expect(form.scale_up.value).toHaveValue('15');
    expect(stub.writes).toEqual([]);
    await expect(form.root).toHaveAttribute('data-state', 'editing');
  });

  test('the editor is fully keyboard operable', async ({ page }) => {
    const stub = await openScaling(page, NONE);
    await noneCard(page).getByTestId('policy-add').focus();
    await page.keyboard.press('Enter');
    const form = editor(page);
    await expect(form.root).toBeVisible();

    await form.kind('queue_length').focus();
    await page.keyboard.press('Enter');
    await expect(form.kind('queue_length')).toHaveAttribute('aria-checked', 'true');
    await form.kind('throughput').focus();
    await page.keyboard.press('Enter');
    await expect(form.kind('throughput')).toHaveAttribute('aria-checked', 'true');
    await form.scale_up.increase.focus();
    await page.keyboard.press('Enter');
    await expect(form.scale_up.value).toHaveValue('11');
    await form.save.focus();
    await page.keyboard.press('Enter');

    await expect(toast(page)).toContainText(SAVED_TOAST);
    expect(stub.writes).toHaveLength(1);
  });
});

test.describe('agents', () => {
  test('lists each agent with its replicas, the count it is heading to, and its load', async ({
    page,
  }) => {
    await openScaling(page, APPLIED);

    const panel = agentsPanel(page);
    await expect(panel).toHaveAttribute('data-state', 'list');
    const rows = panel.getByTestId('scaling-agent');
    await expect(rows).toHaveCount(2);
    const price = rows.filter({ has: page.getByText('PriceAgent') });
    await expect(price.getByTestId('scaling-agent-replicas')).toHaveText('1heading to 2');
    await expect(price.getByTestId('scaling-agent-replicas')).toHaveAttribute(
      'data-moving',
      'true'
    );
    await expect(price).toContainText('12.5');
    await expect(price).toContainText('3');
    const risk = rows.filter({ has: page.getByText('RiskAgent') });
    await expect(risk.getByTestId('scaling-agent-replicas')).toHaveText('1');
    await expect(risk.getByTestId('scaling-agent-replicas')).toHaveAttribute(
      'data-moving',
      'false'
    );
    await expect(risk).toContainText('–');
    await expect(
      panel.getByTestId('scaling-agents-column-requests_per_minute_per_replica')
    ).toHaveAttribute('data-watched', 'true');
    await expect(panel.getByTestId('scaling-agents-column-queue_length_total')).toHaveAttribute(
      'data-watched',
      'false'
    );
  });

  test('marks the queue column when a queue policy is applied, and none without a policy', async ({
    page,
  }) => {
    await openScaling(page, { status: 'applied', policy: QUEUE_POLICY });
    const panel = agentsPanel(page);
    await expect(panel.getByTestId('scaling-agents-column-queue_length_total')).toHaveAttribute(
      'data-watched',
      'true'
    );

    await openScaling(page, NONE);
    await expect(
      agentsPanel(page).getByTestId('scaling-agents-column-queue_length_total')
    ).toHaveAttribute('data-watched', 'false');
    await expect(
      agentsPanel(page).getByTestId('scaling-agents-column-requests_per_minute_per_replica')
    ).toHaveAttribute('data-watched', 'false');
  });

  test('polls, so a replica change shows up without a reload', async ({ page }) => {
    const stub = await openScaling(page, APPLIED);
    const price = agentsPanel(page)
      .getByTestId('scaling-agent')
      .filter({ has: page.getByText('PriceAgent') });
    await expect(price.getByTestId('scaling-agent-replicas')).toHaveText('1heading to 2');

    stub.agents = [{ ...AGENTS[0]!, replicas_running: 2 }, AGENTS[1]!];

    await expect(price.getByTestId('scaling-agent-replicas')).toHaveText('2', { timeout: 15_000 });
    expect(stub.agent_reads).toBeGreaterThan(1);
  });

  test('empty: a controller with no agents yet says so', async ({ page }) => {
    await openScaling(page, NONE, []);

    await expect(agentsPanel(page)).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('scaling-agents-empty')).toContainText(
      'has not published any agents'
    );
  });

  test('error -> Retry: a failed agents read shows its own error and retries alone', async ({
    page,
  }) => {
    await openSession(page);
    const stub = await stubScaling(page, APPLIED);
    stub.agents_failure = (route) => failJson(route, UNREACHABLE);
    await page.goto(SCALING_PATH);

    await expect(agentsPanel(page)).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('scaling-agents-error')).toContainText(UNREACHABLE);
    await expect(appliedCard(page)).toBeVisible();
    const policy_reads = stub.reads;

    stub.agents_failure = null;
    await page.getByTestId('scaling-agents-retry').click();

    await expect(agentsPanel(page)).toHaveAttribute('data-state', 'list');
    expect(stub.reads).toBe(policy_reads);
  });
});

test('cards, controls and steppers have accessible names', async ({ page }) => {
  await openScaling(page, APPLIED);

  const card = page.getByRole('region', { name: 'Scaling policy' });
  await expect(card).toHaveAttribute('data-testid', 'scaling-policy');
  await expect(card.getByRole('button', { name: 'Edit policy', exact: true })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Delete policy', exact: true })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Agents' })).toHaveAttribute(
    'data-testid',
    'scaling-agents'
  );

  await card.getByRole('button', { name: 'Edit policy', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit scaling policy' });
  await expect(form.getByRole('radiogroup', { name: 'Load to watch' })).toBeVisible();
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
    await expect(form.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
  for (const name of [
    'scale-up threshold',
    'scale-down threshold',
    'min replicas',
    'max replicas',
  ]) {
    await expect(form.getByRole('textbox', { name, exact: true })).toHaveCount(1);
  }
  await form.getByRole('button', { name: 'Increase max replicas' }).click();
  await expect(form.getByRole('textbox', { name: 'max replicas', exact: true })).toHaveValue('9');
});
