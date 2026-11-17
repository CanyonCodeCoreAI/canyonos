// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, Route } from '@playwright/test';

import type { GovernanceAgent, GovernanceResponse } from '@canyonos/api/governance';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { Prompt, PromptListItem, SystemPrompt } from '@canyonos/api/prompts';
import type { ScalingPolicy, ScalingResponse, ScalingStatus } from '@canyonos/api/scaling';

import { setTokens, tokenFor } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import { expectPath } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const READ_REFUSAL = 'A write token reads only what it can change; send a read token for this';
const SEEDED_PROJECT_NAME = 'Canyon Code Demo Flow';

/** The project the API's dev seed makes, found the way the dashboard lists it. */
async function seededProject(request: APIRequestContext): Promise<ProjectSummary> {
  const response = await request.get(`${apiBaseUrl}/projects`, {
    headers: { authorization: `Bearer ${tokenFor('read')}` },
  });
  const projects = (await response.json()) as ProjectSummary[];
  return projects.find(({ name }) => name === SEEDED_PROJECT_NAME)!;
}

type ControllerAnswer = (route: Route) => unknown;

/**
 * The API decides every call to `pathname`: its 401 or 403 reaches the page as it is. Past that
 * check the API asks the project's controller, which this suite does not run, so its answer stands
 * in for the controller's. `statuses` keeps what the API said, to show it accepted the token.
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
      if (response.status() === 401 || response.status() === 403) {
        return route.fulfill({ response });
      }
      return fulfillJson(route, answer(route));
    }
  );
  return statuses;
}

const refusedByToken = (status: number) => status === 401 || status === 403;

async function signInWithWriteToken(page: Page): Promise<void> {
  await setTokens(page, { writeToken: tokenFor('write') });
}

let project: ProjectSummary;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  project = await seededProject(request);
  await request.dispose();
});

test('a write token alone opens a project, and its read-only sections show the refusal', async ({
  page,
}) => {
  await signInWithWriteToken(page);

  await page.goto(`/projects/${project.id}`);

  await expect(page.getByTestId('project-screen')).toBeVisible();
  await expect(page.getByTestId('project-layout-error')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText(project.name);
  await expect(page.getByTestId('project-screen').getByTestId('query-refused').first()).toHaveText(
    READ_REFUSAL
  );
});

test('a write token alone sees the refusal on the projects list and its logs', async ({ page }) => {
  await signInWithWriteToken(page);

  await page.goto('/projects');
  await expect(page.getByTestId('projects-overview').getByTestId('query-refused')).toHaveText(
    READ_REFUSAL
  );
  await expect(page.getByTestId('projects-error').getByTestId('query-refused')).toHaveText(
    READ_REFUSAL
  );

  await page.goto(`/projects/${project.id}/logs`);
  await expect(page.getByTestId('query-refused').first()).toHaveText(READ_REFUSAL);
});

test('a write token alone saves a scaling policy and sees it stored', async ({ page }) => {
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
  await signInWithWriteToken(page);

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
  expect([...reads, ...writes].some(refusedByToken)).toBe(false);
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

test('a write token alone reads governance and stops an agent', async ({ page }) => {
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
  await signInWithWriteToken(page);

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
  expect([...reads, ...writes].some(refusedByToken)).toBe(false);
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

test('a write token alone reads the prompts and makes an older version live', async ({ page }) => {
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
  await signInWithWriteToken(page);

  await page.goto(`/projects/${project.id}/prompts`);
  const card = page.locator('[data-testid="prompt-card"][data-name="summarize"]');
  await expect(card.getByTestId('prompt-live')).toHaveText('v2 live');
  await card.getByTestId('prompt-toggle').click();
  const row = card.locator(`[data-testid="prompt-version"][data-version="${V1.version}"]`);
  await row.getByRole('button').first().click();
  await row.getByTestId('prompt-make-live').click();

  await expect(page.getByTestId('app-toast')).toContainText('v1 of summarize is live.');
  await expect(card.getByTestId('prompt-live')).toHaveText('v1 live');
  expect(calls.flat().some(refusedByToken)).toBe(false);
});
