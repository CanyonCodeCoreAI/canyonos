// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, Route } from '@playwright/test';

import type { GovernanceAgent, GovernanceResponse } from '@canyonos/api/governance';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type { ScalingPolicy, ScalingResponse, ScalingStatus } from '@canyonos/api/scaling';

import { authenticate, TEST_API_KEY } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import { expectPath } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const SEEDED_PROJECT_NAME = 'Canyon Code Demo Flow';

/** The project the API's dev seed makes, found the way the dashboard lists it. */
async function seededProject(request: APIRequestContext): Promise<ProjectSummary> {
  const response = await request.get(`${apiBaseUrl}/projects`, {
    headers: { authorization: `Bearer ${TEST_API_KEY}` },
  });
  const projects = (await response.json()) as ProjectSummary[];
  return projects.find(({ name }) => name === SEEDED_PROJECT_NAME)!;
}

type ControllerAnswer = (route: Route) => unknown;

/**
 * The API decides every call to `pathname`: its 401 reaches the page as it is. Past that
 * check the API asks the project's controller, which this suite does not run, so its answer stands
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

let project: ProjectSummary;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  project = await seededProject(request);
  await request.dispose();
});

test('the API key saves a scaling policy through the API and sees it stored', async ({ page }) => {
  let stored: ScalingStatus = { status: 'none' };
  const reads = await answerPastAuth(page, `/projects/${project.id}/scaling`, {
    GET: (): ScalingResponse => ({ projects: { app: stored } }),
  });
  const writes = await answerPastAuth(page, `/projects/${project.id}/scaling/app`, {
    PUT: (route) => {
      const policy = route.request().postDataJSON() as ScalingPolicy;
      stored = { status: 'applied', policy };
      return policy;
    },
  });
  await answerPastAuth(page, `/projects/${project.id}/scaling/agents`, {
    GET: () => ({ agents: [] }),
  });
  await authenticate(page);

  await page.goto(`/projects/${project.id}/scaling`);
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
  await expectPath(page, `/projects/${project.id}/scaling`);
});

const governanceAgent = (name: string, status: GovernanceAgent['status']): GovernanceAgent => ({
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
  agents: [governanceAgent('Workflow', 'up'), governanceAgent('PriceAgent', status)],
  edges: [{ source: 'Workflow', target: 'PriceAgent' }],
});

test('the API key reads governance and stops an agent through the API', async ({ page }) => {
  let status: GovernanceAgent['status'] = 'up';
  const reads = await answerPastAuth(page, `/projects/${project.id}/governance`, {
    GET: () => governanceWith(status),
  });
  const writes = await answerPastAuth(
    page,
    `/projects/${project.id}/governance/agents/PriceAgent/stopped`,
    {
      PUT: (route) => {
        status = (route.request().postDataJSON() as { stopped: boolean }).stopped
          ? 'stopped'
          : 'up';
        return governanceWith(status);
      },
    }
  );
  await answerPastAuth(page, `/projects/${project.id}/scaling`, {
    GET: (): ScalingResponse => ({ projects: { app: { status: 'none' } } }),
  });
  await authenticate(page);

  await page.goto(`/projects/${project.id}/governance?agent=PriceAgent`);
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
    await answerPastAuth(page, `/projects/${project.id}/prompts`, { GET: listing }),
    await answerPastAuth(page, `/projects/${project.id}/prompts/summarize`, { GET: () => prompt }),
    await answerPastAuth(page, `/projects/${project.id}/prompts/summarize/live`, {
      PUT: (route) => {
        const { version } = route.request().postDataJSON() as { version: string };
        prompt = { ...prompt, live: prompt.versions.find((stored) => stored.version === version)! };
        return listing()[0];
      },
    }),
  ];
  await authenticate(page);

  await page.goto(`/projects/${project.id}/prompts`);
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
