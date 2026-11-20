// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, Route } from '@playwright/test';

import type { GovernanceAgent, GovernanceResponse } from '@canyonos/api/governance';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type {
  ScalingAgentsResponse,
  ScalingPolicy,
  ScalingResponse,
  ScalingStatus,
} from '@canyonos/api/scaling';
import type { WorkflowSummary } from '@canyonos/api/workflows';

import { authenticate, TEST_API_KEY } from './helpers/auth';
import { expectPath } from './helpers/session';
import { apiBaseUrl, fulfillJson } from './helpers/workflows';

const apiOrigin = new URL(apiBaseUrl).origin;
const SEEDED_WORKFLOW_NAME = 'Canyon Code Demo Flow';

/** The workflow the API's dev seed makes, found the way the dashboard lists it. */
async function seededWorkflow(request: APIRequestContext): Promise<WorkflowSummary> {
  const response = await request.get(`${apiBaseUrl}/v1/workflows`, {
    headers: { authorization: `Bearer ${TEST_API_KEY}` },
  });
  const workflows = (await response.json()) as WorkflowSummary[];
  return workflows.find(({ name }) => name === SEEDED_WORKFLOW_NAME)!;
}

type ControllerAnswer = (route: Route) => unknown;

/**
 * The API decides every call to `pathname`: its 401 reaches the page as it is. Past that
 * check the API asks the workflow's controller, which this suite does not run, so its answer stands
 * in for the controller's. `statuses` keeps what the API said, to show it accepted the key.
 */
async function answerPastAuth(
  page: Page,
  pathname: string,
  answers: Partial<Record<string, ControllerAnswer>>
): Promise<number[]> {
  const statuses: number[] = [];
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === pathname,
    async (route) => {
      const answer = answers[route.request().method()];
      if (!answer) return route.fallback();
      const response = await route.fetch();
      statuses.push(response.status());
      if (response.status() === 401) {
        return route.fulfill({ response });
      }
      return fulfillJson(route, answer(route));
    }
  );
  return statuses;
}

const refused = (status: number) => status === 401;

let workflow: WorkflowSummary;
let workflow_api: string;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  workflow = await seededWorkflow(request);
  workflow_api = `/v1/workflow-groups/${workflow.workflow_group_id}/workflows/${workflow.id}`;
  await request.dispose();
});

test('the API key saves a scaling policy through the API and sees it stored', async ({ page }) => {
  let stored: ScalingStatus = { status: 'none' };
  const reads = await answerPastAuth(page, `${workflow_api}/scaling`, {
    GET: (): ScalingResponse => ({ workflows: { app: stored } }),
  });
  const writes = await answerPastAuth(page, `${workflow_api}/scaling`, {
    PUT: (route): ScalingPolicy => {
      const policy = route.request().postDataJSON() as ScalingPolicy;
      stored = { status: 'applied', policy };
      return policy;
    },
  });
  await answerPastAuth(page, `${workflow_api}/scaling/agents`, {
    GET: (): ScalingAgentsResponse => ({ agents: [] }),
  });
  await authenticate(page);

  await page.goto(`/workflows/${workflow.id}/scaling`);
  await expect(page.getByTestId('scaling-screen')).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('scaling-policy-none').getByTestId('policy-add').click();
  await page.getByTestId('policy-max-replicas-increase').click();
  await page.getByTestId('policy-save').click();

  await expect(page.getByTestId('app-toast')).toContainText('Scaling policy saved.');
  const applied = page.getByTestId('scaling-policy-applied');
  await expect(applied).toHaveAttribute('data-kind', 'throughput');
  await expect(applied.getByTestId('policy-max-replicas-value')).toHaveText('6');
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(writes).toHaveLength(1);
  expect([...reads, ...writes].some(refused)).toBe(false);
  await expectPath(page, `/workflows/${workflow.id}/scaling`);
});

const WORKFLOW_AGENT_ID = '8d2e6c1a-4b3f-5a7e-8c9d-1e2f3a4b5c6d';
const PRICE_AGENT_ID = '5b0f8a8e-2c1d-5e4f-9a3b-7c6d5e4f3a2b';

const governanceAgent = (
  agent_id: string,
  name: string,
  status: GovernanceAgent['status']
): GovernanceAgent => ({
  agent_id,
  name,
  replicas_running: status === 'stopped' ? 0 : 1,
  replicas_expected: status === 'stopped' ? 0 : 1,
  desired_replicas: status === 'stopped' ? 0 : 1,
  status,
  unmet_requires: [],
  models: [],
  rules: { requires: [], spend: null },
  spend: null,
  scaling_policy_present: false,
});

const governanceWith = (status: GovernanceAgent['status']): GovernanceResponse => ({
  agents: [
    governanceAgent(WORKFLOW_AGENT_ID, 'Workflow', 'up'),
    governanceAgent(PRICE_AGENT_ID, 'PriceAgent', status),
  ],
  edges: [{ source: WORKFLOW_AGENT_ID, target: PRICE_AGENT_ID }],
});

test('the API key reads governance and stops an agent through the API', async ({ page }) => {
  let status: GovernanceAgent['status'] = 'up';
  const reads = await answerPastAuth(page, `${workflow_api}/governance`, {
    GET: () => governanceWith(status),
  });
  const writes = await answerPastAuth(
    page,
    `${workflow_api}/governance/agents/${PRICE_AGENT_ID}/stopped`,
    {
      PUT: (route): GovernanceResponse => {
        status = (route.request().postDataJSON() as { stopped: boolean }).stopped
          ? 'stopped'
          : 'up';
        return governanceWith(status);
      },
    }
  );
  await answerPastAuth(page, `${workflow_api}/scaling`, {
    GET: (): ScalingResponse => ({ workflows: { app: { status: 'none' } } }),
  });
  await authenticate(page);

  await page.goto(`/workflows/${workflow.id}/governance?agent=${PRICE_AGENT_ID}`);
  const drawer = page.getByTestId('governance-drawer');
  await expect(drawer.getByTestId('governance-drawer-status')).toHaveAttribute('data-status', 'up');
  await drawer.getByRole('button', { name: 'Stop agent' }).click();

  await expect(page.getByTestId('app-toast')).toContainText('PriceAgent stopped.');
  await expect(drawer.getByTestId('governance-drawer-status')).toHaveAttribute(
    'data-status',
    'stopped'
  );
  expect(writes).toHaveLength(1);
  expect([...reads, ...writes].some(refused)).toBe(false);
});

const V1: SystemPrompt = {
  version: 'summarize-11223344-v1',
  content: 'Summarize the input.',
  updated_at: '2026-09-10T10:00:00.000Z',
};
const V2: SystemPrompt = {
  version: 'summarize-55667788-v2',
  content: 'Summarize the input in one line.',
  updated_at: '2026-09-20T10:00:00.000Z',
};

test('the API key reads the prompts and makes an older version live through the API', async ({
  page,
}) => {
  let prompt: Prompt = { name: 'summarize', live: V2, versions: [V2, V1] };
  const listing = (): PromptListItem[] => [{ name: prompt.name, live: prompt.live }];
  const calls = [
    await answerPastAuth(page, `${workflow_api}/prompts`, { GET: listing }),
    await answerPastAuth(page, `${workflow_api}/prompts/summarize`, {
      GET: (): Prompt => prompt,
    }),
    await answerPastAuth(page, `${workflow_api}/prompts/summarize/live`, {
      PUT: (route): PromptListItem => {
        const { version } = route.request().postDataJSON() as { version: string };
        prompt = { ...prompt, live: prompt.versions.find((stored) => stored.version === version)! };
        return listing()[0]!;
      },
    }),
  ];
  await authenticate(page);

  await page.goto(`/workflows/${workflow.id}/prompts`);
  const card = page.locator('[data-testid="prompt-card"][data-name="summarize"]');
  await expect(card.getByTestId('prompt-live')).toHaveText('v2 live');
  await card.getByTestId('prompt-toggle').click();
  const row = card.locator(`[data-testid="prompt-version"][data-version="${V1.version}"]`);
  await row.getByRole('button').first().click();
  await row.getByTestId('prompt-make-live').click();

  await expect(page.getByTestId('app-toast')).toContainText('v1 of summarize is live.');
  await expect(card.getByTestId('prompt-live')).toHaveText('v1 live');
  expect(calls.flat().some(refused)).toBe(false);
});
