import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type {
  MonitoringEndpointsResponse,
  MonitoringErrorSummaryResponse,
  MonitoringReplica,
} from '@canyonos/api/monitoring';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, failJson, fulfillJson } from './helpers/projects';
import { PROJECT, stubFleetSpend, stubProjectDashboard, stubProjectsList } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const STATUS_PATH = `/projects/${PROJECT.id}/status`;
const MONITORING_PATH = `/projects/${PROJECT.id}/monitoring`;
const WORKFLOW_URL = 'http://203.0.113.7:8080';

const REPLICAS: MonitoringReplica[] = [
  { agent: 'fraud_workflow', replica: 'fraud_workflow-1', queue_length: 2, active_requests: 3 },
  { agent: 'ScoringAgent', replica: 'ScoringAgent-1', queue_length: 4, active_requests: 5 },
  { agent: 'ScoringAgent', replica: 'ScoringAgent-2', queue_length: null, active_requests: null },
];

const ENDPOINTS: MonitoringEndpointsResponse = {
  project_id: PROJECT.id,
  endpoints: [{ name: 'fraud_workflow', url: WORKFLOW_URL }],
};

const ERROR_SUMMARY: MonitoringErrorSummaryResponse = {
  project_id: PROJECT.id,
  time_window: '1d',
  total: 7,
  by_type: [],
  by_agent: [],
};

type Handler = (route: Route) => Promise<void>;

interface StatusStub {
  readonly endpoints?: Handler;
  readonly replicas?: Handler;
}

// Stubbed rather than seeded: the web e2e job runs the API with no controller Redis behind it.
async function openStatus(page: Page, stub: StatusStub = {}): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);

  const handlers: Record<string, Handler> = {
    [`${MONITORING_PATH}/endpoints`]: stub.endpoints ?? ((route) => fulfillJson(route, ENDPOINTS)),
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

test('a running project shows its endpoint, the summary tiles and the containers by agent', async ({
  page,
}) => {
  await openStatus(page);

  await expect(page.getByTestId('status-badge')).toHaveText('Running');
  await expect(page.getByTestId('status-badge')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('status-endpoint-url')).toHaveText(`${WORKFLOW_URL}/main`);
  await expect(page.getByTestId('status-endpoint-curl')).toContainText(
    `curl -X POST ${WORKFLOW_URL}/main`
  );

  await expect(page.getByTestId('status-tile-replicas-value')).toHaveText('3');
  await expect(page.getByTestId('status-tile-agents-value')).toHaveText('2');
  // Only the workflow replica's requests count; the agent replicas serve those same requests.
  await expect(page.getByTestId('status-tile-active-value')).toHaveText('3');
  await expect(page.getByTestId('status-tile-errors-value')).toHaveText('7');

  await expect(page.getByTestId('metrics-containers-count')).toHaveText('3');
  const scoring = page.getByTestId('metrics-containers-agent-ScoringAgent');
  await expect(scoring.getByTestId('metrics-containers-agent-count-ScoringAgent')).toHaveText('2');
  await expect(scoring.getByTestId('metrics-containers-replica-ScoringAgent-1')).toHaveText('4');
  await expect(scoring.getByTestId('metrics-containers-replica-ScoringAgent-2')).toHaveText('0');
  const workflow = page.getByTestId('metrics-containers-agent-fraud_workflow');
  await expect(workflow.getByTestId('metrics-containers-replica-fraud_workflow-1')).toHaveText('2');
});

test('a project with no running controller says so and still counts what reports up', async ({
  page,
}) => {
  await openStatus(page, { endpoints: notRunning });

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
  await openStatus(page, { endpoints: (route) => failJson(route) });

  await expect(page.getByTestId('status-badge')).toHaveText('Status unknown');
  await expect(page.getByTestId('status-endpoint-message')).toHaveText(
    'Could not read the workflow endpoint.'
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
