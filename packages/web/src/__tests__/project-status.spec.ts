// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type {
  MonitoringEndpointResponse,
  MonitoringErrorSummaryResponse,
  MonitoringReplica,
} from '@canyonos/api/monitoring';

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
const PROJECT_PATH = `/projects/${PROJECT.id}`;
const STATUS_PATH = `${PROJECT_PATH}/status`;
const MONITORING_PATH = `/projects/${PROJECT.id}/monitoring`;
const ENDPOINT_URL = 'http://203.0.113.7:8080/main';
const STATUS_URL = 'http://203.0.113.7:8080/status';
const RANGE = { from: '2026-10-07T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };

const REPLICAS: MonitoringReplica[] = [
  {
    agent: 'fraud_workflow',
    replica: 'fraud_workflow-1',
    queue_length: 2,
    active_requests: 3,
    draining: false,
  },
  {
    agent: 'ScoringAgent',
    replica: 'ScoringAgent-1',
    queue_length: 4,
    active_requests: 5,
    draining: false,
  },
  {
    agent: 'ScoringAgent',
    replica: 'ScoringAgent-2',
    queue_length: null,
    active_requests: null,
    draining: false,
  },
  {
    agent: 'ScoringAgent',
    replica: 'ScoringAgent-3',
    queue_length: 1,
    active_requests: 1,
    draining: true,
  },
];

const ENDPOINT: MonitoringEndpointResponse = {
  project_id: PROJECT.id,
  endpoint: {
    url: ENDPOINT_URL,
    status_url: STATUS_URL,
    agent: 'fraud_workflow',
    method: 'main',
    arguments: ['transaction'],
    example_body: { transaction: 'your query' },
  },
};

const ERROR_SUMMARY: MonitoringErrorSummaryResponse = {
  project_id: PROJECT.id,
  ...RANGE,
  total: 7,
  by_type: [],
  by_agent: [],
};

type Handler = (route: Route) => Promise<void>;

interface StatusStub {
  readonly endpoint?: Handler;
  readonly replicas?: Handler;
}

// Stubbed rather than seeded: the web e2e job runs the API with no controller Redis behind it.
async function openStatus(page: Page, stub: StatusStub = {}): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);

  const handlers: Record<string, Handler> = {
    [`${MONITORING_PATH}/endpoint`]: stub.endpoint ?? ((route) => fulfillJson(route, ENDPOINT)),
    [`${MONITORING_PATH}/replicas`]:
      stub.replicas ??
      ((route) => fulfillJson(route, { project_id: PROJECT.id, replicas: REPLICAS })),
    [`${MONITORING_PATH}/errors/summary`]: (route) => fulfillJson(route, ERROR_SUMMARY),
  };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname in handlers,
    (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return handlers[new URL(route.request().url()).pathname]!(route);
    }
  );

  await page.goto(STATUS_PATH);
  await expect(page.getByTestId('status-screen')).toBeVisible();
}

const notRunning: Handler = (route) =>
  fulfillJson(
    route,
    { error: 'canyonos.project_not_running', message: 'No running controller' },
    404
  );

const STILL_RUNNING =
  'This project is still running. Run `canyonos stop` in its folder, then delete it.';

/** Answers the project's DELETE and records each one; reads fall through to the page stubs. */
async function stubDelete(page: Page, handler: Handler): Promise<string[]> {
  const deletes: string[] = [];
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === PROJECT_PATH,
    (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      deletes.push(route.request().url());
      return handler(route);
    }
  );
  return deletes;
}

test('a running project shows its endpoint, the summary tiles and the containers by agent', async ({
  page,
}) => {
  await openStatus(page);

  await expect(page.getByTestId('status-badge')).toHaveText('Running');
  await expect(page.getByTestId('status-badge')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('status-endpoint-url')).toHaveText(ENDPOINT_URL);
  await expect(page.getByTestId('status-endpoint-curl')).toContainText(
    `curl -X POST ${ENDPOINT_URL}`
  );
  await expect(page.getByTestId('status-endpoint-curl')).toContainText(
    `-d '{"transaction":"your query"}'`
  );
  await expect(page.getByTestId('status-endpoint-status-curl')).toHaveText(
    `curl ${STATUS_URL}/<request_id>`
  );

  await expect(page.getByTestId('status-tile-replicas-value')).toHaveText('3');
  await expect(page.getByTestId('status-tile-agents-value')).toHaveText('2');
  // Only the endpoint agent's replicas count; the other agents serve those same requests.
  await expect(page.getByTestId('status-tile-active-value')).toHaveText('3');
  await expect(page.getByTestId('status-tile-errors-value')).toHaveText('7');

  // A draining replica is shown, but only serving ones are counted.
  await expect(page.getByTestId('metrics-containers-count')).toHaveText('3');
  await expect(page.getByTestId('metrics-containers-draining')).toHaveText('1 draining');
  const scoring = page.getByTestId('metrics-containers-agent-ScoringAgent');
  await expect(scoring.getByTestId('metrics-containers-agent-count-ScoringAgent')).toHaveText('2');
  await expect(scoring.getByTestId('metrics-containers-replica-ScoringAgent-1')).toHaveText('4');
  await expect(scoring.getByTestId('metrics-containers-replica-ScoringAgent-2')).toHaveText('0');
  await expect(scoring.getByTestId('metrics-containers-replica-ScoringAgent-3')).toHaveAttribute(
    'data-state',
    'draining'
  );
  const workflow = page.getByTestId('metrics-containers-agent-fraud_workflow');
  await expect(workflow.getByTestId('metrics-containers-replica-fraud_workflow-1')).toHaveText('2');
});

test('a project with no running controller says so and still counts what reports up', async ({
  page,
}) => {
  await openStatus(page, { endpoint: notRunning });

  await expect(page.getByTestId('status-badge')).toHaveText('Not running');
  await expect(page.getByTestId('status-endpoint-message')).toHaveText(
    'Deploy the project to get an endpoint.'
  );
  await expect(page.getByTestId('status-endpoint-url')).toHaveCount(0);
  await expect(page.getByTestId('status-tile-replicas-value')).toHaveText('3');
  await expect(page.getByTestId('status-tile-agents-value')).toHaveText('2');
  await expect(page.getByTestId('status-tile-active-value')).toHaveText('0');
});

test('an endpoint read that fails for another reason does not claim the project is down', async ({
  page,
}) => {
  await openStatus(page, { endpoint: (route) => failJson(route) });

  await expect(page.getByTestId('status-badge')).toHaveText('Status unknown');
  await expect(page.getByTestId('status-endpoint-message')).toHaveText(
    'Could not read the endpoint.'
  );
});

test('a failed replicas read shows the containers error, not the empty state', async ({ page }) => {
  await openStatus(page, { replicas: (route) => failJson(route) });

  await expect(page.getByTestId('metrics-containers-error')).toContainText(
    'Could not load containers.'
  );
  await expect(page.getByTestId('metrics-containers-empty')).toHaveCount(0);
  await expect(page.getByTestId('status-tile-replicas')).toHaveAttribute(
    'data-state',
    'unavailable'
  );
});

test('no replicas up shows the empty containers state', async ({ page }) => {
  await openStatus(page, {
    replicas: (route) => fulfillJson(route, { project_id: PROJECT.id, replicas: [] }),
  });

  await expect(page.getByTestId('metrics-containers-empty')).toContainText('No containers up.');
  await expect(page.getByTestId('metrics-containers-error')).toHaveCount(0);
  await expect(page.getByTestId('status-tile-replicas-value')).toHaveText('0');
  await expect(page.getByTestId('status-tile-agents-value')).toHaveText('0');
});

test('a running project cannot be deleted; the dialog says to stop it first', async ({ page }) => {
  await openStatus(page);
  const deletes = await stubDelete(page, (route) => fulfillJson(route, { project_id: PROJECT.id }));
  await expect(page.getByTestId('status-badge')).toHaveText('Running');

  await page.getByTestId('status-delete-project').click();
  const dialog = page.getByTestId('status-delete-dialog');
  await expect(dialog).toContainText(`${PROJECT.name} is still running`);
  await expect(page.getByTestId('status-delete-confirm')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  expect(deletes).toEqual([]);
});

test('deleting a stopped project removes it and returns to the projects list', async ({ page }) => {
  await openStatus(page, { endpoint: notRunning });
  const deletes = await stubDelete(page, (route) => fulfillJson(route, { project_id: PROJECT.id }));
  await expect(page.getByTestId('status-badge')).toHaveText('Not running');

  await page.getByTestId('status-delete-project').click();
  await expect(page.getByTestId('status-delete-dialog')).toContainText(`Delete ${PROJECT.name}?`);
  await page.getByTestId('status-delete-confirm').click();

  await expect(page.getByTestId('app-toast')).toContainText('Project deleted.');
  await expectPath(page, '/projects');
  expect(deletes).toHaveLength(1);
});

test('a delete the API refuses keeps the dialog open with the reason', async ({ page }) => {
  await openStatus(page, { endpoint: notRunning });
  await stubDelete(page, (route) =>
    fulfillJson(route, { error: 'projects.running', message: STILL_RUNNING }, 409)
  );
  await expect(page.getByTestId('status-badge')).toHaveText('Not running');

  await page.getByTestId('status-delete-project').click();
  await page.getByTestId('status-delete-confirm').click();

  const dialog = page.getByTestId('status-delete-dialog');
  await expect(dialog.getByTestId('status-delete-error')).toHaveText(STILL_RUNNING);
  await expect(page.getByTestId('status-delete-confirm')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expectPath(page, STATUS_PATH);
});
