import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type {
  MonitoringLlmCall,
  MonitoringSeriesResponse,
  MonitoringTrace,
} from '@canyonos/api/monitoring';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import { PROJECT, stubFleetSpend, stubProjectDashboard, stubProjectsList } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;
const MONITORING_PATH = `/projects/${PROJECT.id}/monitoring`;
const API_BASE = `/projects/${PROJECT.id}/monitoring`;

const PLAIN_TRACE: MonitoringTrace = {
  at: '2026-10-06 12:00:00',
  trace_id: 'trace-plain',
  name: 'checkout',
  agents: ['CartAgent'],
  span_count: 1,
  duration_ms: 120,
  failed: false,
  spans: [
    {
      span_id: 'span-plain',
      parent_span_id: null,
      name: 'cart.total',
      agent: 'CartAgent',
      offset_ms: 0,
      duration_ms: 120,
      failed: false,
      status_message: null,
      llm: null,
    },
  ],
};

const LLM_TRACE: MonitoringTrace = {
  at: '2026-10-06 12:05:00',
  trace_id: 'trace-llm',
  name: 'quote',
  agents: ['PriceAgent'],
  span_count: 3,
  duration_ms: 2400,
  failed: false,
  spans: [
    {
      span_id: 'span-root',
      parent_span_id: null,
      name: 'quote.run',
      agent: 'PriceAgent',
      offset_ms: 0,
      duration_ms: 2400,
      failed: false,
      status_message: null,
      llm: null,
    },
    {
      span_id: 'span-chat',
      parent_span_id: 'span-root',
      name: 'chat',
      agent: 'PriceAgent',
      offset_ms: 100,
      duration_ms: 1500,
      failed: false,
      status_message: null,
      llm: {
        model: 'gpt-test',
        input_tokens: 1200,
        output_tokens: 45,
        cost: 0.0123,
        input: 'What does the blue mug cost?',
        output: 'The blue mug costs $4.',
      },
    },
    {
      span_id: 'span-summary',
      parent_span_id: 'span-root',
      name: 'summarize',
      agent: 'PriceAgent',
      offset_ms: 1700,
      duration_ms: 600,
      failed: false,
      status_message: null,
      llm: {
        model: 'gpt-test',
        input_tokens: 80,
        output_tokens: 20,
        cost: 0.001,
        input: null,
        output: null,
      },
    },
  ],
};

const LLM_CALL: MonitoringLlmCall = {
  at: '2026-10-06 12:05:00',
  name: 'chat',
  model: 'gpt-test',
  agent: 'PriceAgent',
  duration_ms: 1500,
  input_tokens: 1200,
  output_tokens: 45,
  cache_hit_ratio: null,
  cost: 0.0123,
  failed: false,
  status_message: null,
  trace_id: LLM_TRACE.trace_id,
  span_id: 'span-chat',
  input: 'What does the blue mug cost?',
  output: 'The blue mug costs $4.',
  attributes: {},
};

const EMPTY_SERIES: MonitoringSeriesResponse = {
  project_id: PROJECT.id,
  time_window: '1d',
  bucket_seconds: 3600,
  bucket_start_ats: [],
  series: [],
};

// Stubbed rather than seeded: the web e2e job runs the API with no ClickHouse behind it.
async function openMonitoring(
  page: Page,
  { traces, search = '' }: { readonly traces: MonitoringTrace[]; readonly search?: string }
): Promise<void> {
  await authenticate(page);
  await stubProjectsList(page, [PROJECT]);
  await stubProjectDashboard(page, PROJECT);
  await stubFleetSpend(page);
  const answers: Record<string, unknown> = {
    [`${API_BASE}/series`]: EMPTY_SERIES,
    [`${API_BASE}/traces`]: { project_id: PROJECT.id, time_window: '1d', traces },
    [`${API_BASE}/llm`]: { project_id: PROJECT.id, time_window: '1d', calls: [LLM_CALL] },
  };
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname in answers,
    (route) => fulfillJson(route, answers[new URL(route.request().url()).pathname])
  );
  await page.goto(`${MONITORING_PATH}${search}`);
  await expect(page.getByTestId('monitoring-screen')).toBeVisible();
}

const viewOption = (page: Page, name: string) =>
  page.getByTestId('trace-view-toggle').getByRole('radio', { name, exact: true });

const searchParam = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

test('the default view lists every trace with its LLM call count and cost', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE] });

  await expect(viewOption(page, 'All traces')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('traces-table').getByRole('button')).toHaveCount(2);
  await expect(page.getByTestId('trace-row-llm-0')).toHaveText('—');
  await expect(page.getByTestId('trace-row-llm-1')).toHaveText('2 · $0.0133');
});

test('"With LLM calls" keeps only traces that made an LLM call', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE] });

  await viewOption(page, 'With LLM calls').click();

  await expect.poll(() => searchParam(page, 'view')).toBe('llm_traces');
  await expect(page.getByTestId('traces-table').getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('trace-row-toggle-0')).toContainText('quote');
});

test('"With LLM calls" says so when no trace made an LLM call', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE], search: '?view=llm_traces' });

  await expect(page.getByTestId('traces-empty')).toContainText(
    'No traces with LLM calls in this window.'
  );
});

test('a view in the URL renders that view on load', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE], search: '?view=llm_traces' });

  await expect(viewOption(page, 'With LLM calls')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('traces-table').getByRole('button')).toHaveCount(1);
});

test('"LLM calls" lists the calls, and "Open trace" lands on that trace expanded', async ({
  page,
}) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE] });

  await viewOption(page, 'LLM calls').click();
  await expect(page.getByTestId('llm-table')).toBeVisible();
  await expect(page.getByTestId('traces-table')).toHaveCount(0);

  await page.getByTestId('llm-row-toggle-0').click();
  await page.getByTestId('llm-row-open-trace-0').click();

  await expect.poll(() => searchParam(page, 'view')).toBe('traces');
  expect(searchParam(page, 'trace')).toBe(LLM_TRACE.trace_id);
  await expect(viewOption(page, 'All traces')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('trace-row-toggle-1')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('trace-spans-1')).toContainText(`trace_id ${LLM_TRACE.trace_id}`);
  await expect(page.getByTestId('trace-row-toggle-0')).toHaveAttribute('aria-expanded', 'false');
});

test('collapsing the trace from the URL drops it from the URL', async ({ page }) => {
  await openMonitoring(page, {
    traces: [PLAIN_TRACE, LLM_TRACE],
    search: `?view=traces&trace=${LLM_TRACE.trace_id}`,
  });
  await expect(page.getByTestId('trace-spans-1')).toBeVisible();

  await page.getByTestId('trace-row-toggle-1').click();

  await expect.poll(() => searchParam(page, 'trace')).toBeNull();
  await expect(page.getByTestId('trace-spans-1')).toHaveCount(0);
});

test('expanding an LLM span shows its model, tokens, cost and payloads', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE] });

  await page.getByTestId('trace-row-toggle-1').click();
  const spans = page.getByTestId('trace-spans-1');
  await expect(spans.getByTestId('span-row-toggle-span-root')).toHaveCount(0);
  await expect(page.getByTestId('span-llm-span-chat')).toHaveCount(0);

  await spans.getByTestId('span-row-toggle-span-chat').click();

  const details = page.getByTestId('span-llm-span-chat');
  await expect(details).toContainText('gpt-test · 1,200 in · 45 out · $0.0123');
  await expect(details).toContainText('What does the blue mug cost?');
  await expect(details).toContainText('The blue mug costs $4.');
});

test('trace and LLM span rows expand and collapse from the keyboard', async ({ page }) => {
  await openMonitoring(page, { traces: [PLAIN_TRACE, LLM_TRACE] });

  const trace = page.getByTestId('trace-row-toggle-1');
  await trace.focus();
  await page.keyboard.press('Enter');
  await expect(trace).toHaveAttribute('aria-expanded', 'true');

  const span = page.getByTestId('span-row-toggle-span-chat');
  await span.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('span-llm-span-chat')).toContainText('gpt-test');

  await trace.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trace-spans-1')).toHaveCount(0);
});
