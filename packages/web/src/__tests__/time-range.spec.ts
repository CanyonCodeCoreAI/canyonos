// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { RequestListItem, RequestTrace } from '@canyonos/api/requests';

import { authenticate } from './helpers/auth';
import { apiBaseUrl, fulfillJson } from './helpers/projects';
import { PROJECT, stubProjectDashboard, stubProjectsList } from './helpers/session';

const apiOrigin = new URL(apiBaseUrl).origin;

test.use({ timezoneId: 'UTC' });

test.describe('the range control on the logs page', () => {
  const LOGS_PATH = `/projects/${PROJECT.id}/logs`;
  const NOW = new Date('2026-10-06T12:00:00.000Z');
  const DAY_MS = 86_400_000;

  /** Answers the logs list empty and records the range each read asked for. */
  async function stubLogs(page: Page): Promise<{ from: string; to: string }[]> {
    const ranges: { from: string; to: string }[] = [];
    await page.route(
      (url) =>
        url.origin === apiOrigin &&
        url.pathname.startsWith(`/projects/${PROJECT.id}/monitoring/logs`),
      (route) => {
        const url = new URL(route.request().url());
        const range = { from: url.searchParams.get('from')!, to: url.searchParams.get('to')! };
        if (url.pathname.endsWith('/sources'))
          return fulfillJson(route, { project_id: PROJECT.id, ...range, sources: [] });
        ranges.push(range);
        return fulfillJson(route, { project_id: PROJECT.id, ...range, logs: [] });
      }
    );
    return ranges;
  }

  const spanMs = ({ from, to }: { from: string; to: string }) => Date.parse(to) - Date.parse(from);

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await authenticate(page);
    await stubProjectsList(page, [PROJECT]);
    await stubProjectDashboard(page, PROJECT);
  });

  test('a preset sends a range of its length ending now', async ({ page }) => {
    const ranges = await stubLogs(page);
    await page.goto(LOGS_PATH);

    await expect.poll(() => ranges.length).toBeGreaterThan(0);
    expect(spanMs(ranges.at(-1)!)).toBe(7 * DAY_MS);
    expect(Date.parse(ranges.at(-1)!.to)).toBe(NOW.getTime());

    await page
      .getByTestId('project-window-toggle')
      .getByRole('radio', { name: '24 hours' })
      .click();
    await expect.poll(() => spanMs(ranges.at(-1)!)).toBe(DAY_MS);
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('24h');
  });

  test('a custom range sends the days and times picked, through the end of the To minute', async ({
    page,
  }) => {
    const ranges = await stubLogs(page);
    await page.goto(LOGS_PATH);
    await expect.poll(() => ranges.length).toBeGreaterThan(0);

    await page.getByTestId('time-range-custom').click();
    await page.getByRole('button', { name: /October 1st/ }).click();
    await page.getByRole('button', { name: /October 2nd/ }).click();
    await page.getByTestId('time-range-from-time').fill('14:00');
    await page.getByTestId('time-range-to-time').fill('09:30');
    await page.getByTestId('time-range-apply').click();

    await expect
      .poll(() => ranges.at(-1))
      .toEqual({ from: '2026-10-01T14:00:00.000Z', to: '2026-10-02T09:30:59.999Z' });
    expect(new URL(page.url()).searchParams.get('from')).toBe('2026-10-01T14:00:00.000Z');
    expect(new URL(page.url()).searchParams.get('to')).toBe('2026-10-02T09:30:59.999Z');
    await expect(page.getByTestId('time-range-custom')).toContainText('Oct 1');
    await expect(
      page.getByTestId('project-window-toggle').getByRole('radio', { checked: true })
    ).toHaveCount(0);
  });

  test('a range that ends before it starts cannot be applied', async ({ page }) => {
    await stubLogs(page);
    await page.goto(LOGS_PATH);

    await page.getByTestId('time-range-custom').click();
    await page.getByRole('button', { name: /October 1st/ }).click();
    await page.getByTestId('time-range-from-time').fill('14:00');
    await page.getByTestId('time-range-to-time').fill('09:30');

    await expect(page.getByTestId('time-range-apply')).toBeDisabled();
  });

  test('the 15-minute preset sends a 15-minute range ending now', async ({ page }) => {
    const ranges = await stubLogs(page);
    await page.goto(LOGS_PATH);
    await expect.poll(() => ranges.length).toBeGreaterThan(0);

    await page
      .getByTestId('project-window-toggle')
      .getByRole('radio', { name: '15 minutes' })
      .click();
    await expect.poll(() => spanMs(ranges.at(-1)!)).toBe(15 * 60_000);
    expect(Date.parse(ranges.at(-1)!.to)).toBe(NOW.getTime());
  });

  test('picking the shown preset again re-reads it up to the current time', async ({ page }) => {
    const ranges = await stubLogs(page);
    await page.goto(LOGS_PATH);
    await expect.poll(() => ranges.length).toBeGreaterThan(0);

    const later = NOW.getTime() + 5 * 60_000;
    await page.clock.setFixedTime(later);
    await page.getByTestId('project-window-toggle').getByRole('radio', { name: '7 days' }).click();

    await expect.poll(() => Date.parse(ranges.at(-1)!.to)).toBe(later);
    await expect(
      page.getByTestId('project-window-toggle').getByRole('radio', { name: '7 days' })
    ).toHaveAttribute('data-state', 'on');
  });

  test('a custom range ending today ends at the current time, never later', async ({ page }) => {
    const ranges = await stubLogs(page);
    await page.goto(LOGS_PATH);
    await expect.poll(() => ranges.length).toBeGreaterThan(0);

    await page.getByTestId('time-range-custom').click();
    await page.getByRole('button', { name: /October 5th/ }).click();
    await page.getByRole('button', { name: /October 6th/ }).click();
    await expect(page.getByTestId('time-range-to-time')).toHaveValue('12:00');

    await page.getByTestId('time-range-to-time').fill('23:00');
    await page.getByTestId('time-range-apply').click();

    await expect.poll(() => ranges.at(-1)!.to).toBe(NOW.toISOString());
  });

  for (const [name, search] of [
    ['a bound that is not an instant', 'from=yesterday&to=2026-10-06T10:00:00.000Z'],
    [
      'a range that ends before it starts',
      'from=2026-10-06T10:00:00.000Z&to=2026-10-05T10:00:00.000Z',
    ],
    ['a range missing its end', 'from=2026-10-06T10:00:00.000Z'],
  ]) {
    test(`a link with ${name} shows an error and falls back to the preset`, async ({ page }) => {
      const ranges = await stubLogs(page);
      await page.goto(`${LOGS_PATH}?range=24h&${search}`);

      await expect(page.getByTestId('app-toast')).toContainText(
        "There was an error reading this link's time range, so the page shows the last 24 hours."
      );
      await expect.poll(() => ranges.length).toBeGreaterThan(0);
      await expect.poll(() => spanMs(ranges.at(-1)!)).toBe(DAY_MS);
      await expect.poll(() => new URL(page.url()).searchParams.has('from')).toBe(false);
      expect(new URL(page.url()).searchParams.has('to')).toBe(false);
      expect(new URL(page.url()).searchParams.get('range')).toBe('24h');
    });
  }
});

test.describe('the range control on the project overview', () => {
  const OVERVIEW_PATH = `/projects/${PROJECT.id}`;
  const NOW = new Date('2026-10-06T12:00:03.200Z');
  const CUSTOM = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' };
  const CUSTOM_SEARCH = `?from=${CUSTOM.from}&to=${CUSTOM.to}`;

  const REQUEST: RequestListItem = {
    session_id: 'range-trace-0001',
    status: 'completed',
    created_at: '2026-10-02T10:00:00.000Z',
    started_at: '2026-10-02T10:00:00.000Z',
    finished_at: '2026-10-02T10:00:05.000Z',
    duration_ms: 5000,
    block_count: 1,
    failed_block_count: 0,
    error_count: 0,
    token_count: 120,
    llm_cost: '0.0100000000',
    harness_cost: '0.0010000000',
    total_cost: '0.0110000000',
  };

  const TRACE: RequestTrace = {
    project_id: PROJECT.id,
    session_id: REQUEST.session_id,
    status: 'completed',
    created_at: REQUEST.created_at,
    input: { prompt: 'Check the ledger' },
    output: { result: 'Ledger checked' },
    started_at: REQUEST.started_at,
    finished_at: REQUEST.finished_at,
    duration_ms: REQUEST.duration_ms,
    total_cost: REQUEST.total_cost,
    median_cost: '0.0055000000',
    cost_vs_median: 2,
    harness_cost: REQUEST.harness_cost,
    median_harness_cost: '0.0005000000',
    harness_cost_vs_median: 2,
    error_count: 0,
    token_count: REQUEST.token_count,
    median_token_count: 60,
    token_count_vs_median: 2,
    blocks: [],
  };

  /** Every dashboard read's path and the `to` it asked for, in the order the page sent them. */
  function trackReads(page: Page): { path: string; to: string | null }[] {
    const reads: { path: string; to: string | null }[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== apiOrigin) return;
      reads.push({ path: url.pathname, to: url.searchParams.get('to') });
    });
    return reads;
  }

  const countReads = (reads: readonly { path: string }[], path: string) =>
    reads.filter((read) => read.path === `${OVERVIEW_PATH}${path}`).length;

  async function stubOneRequest(page: Page): Promise<void> {
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === `${OVERVIEW_PATH}/requests`,
      (route) => {
        const url = new URL(route.request().url());
        return fulfillJson(route, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          total: 1,
          items: [REQUEST],
        });
      }
    );
    await page.route(
      (url) =>
        url.origin === apiOrigin &&
        url.pathname === `${OVERVIEW_PATH}/requests/${REQUEST.session_id}`,
      (route) => fulfillJson(route, TRACE)
    );
  }

  async function openQueryView(page: Page): Promise<void> {
    await page.getByRole('tab', { name: 'Per-Query view' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Per-Query view' })).toBeVisible();
  }

  // Room for several turns of the 5-second interval on a loaded machine.
  const POLL_WAIT = { timeout: 20_000 };

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await authenticate(page);
    await stubProjectsList(page, [PROJECT]);
    await stubProjectDashboard(page, PROJECT);
  });

  test('every section read on one tick asks for the same instant', async ({ page }) => {
    const reads = trackReads(page);
    await page.goto(OVERVIEW_PATH);
    await openQueryView(page);

    for (const path of ['/metrics/kpis', '/metrics/timeseries', '/metrics/blocks', '/requests']) {
      await expect.poll(() => countReads(reads, path)).toBeGreaterThan(0);
    }
    const instants = new Set(reads.filter((read) => read.to !== null).map((read) => read.to));
    expect(instants).toEqual(new Set(['2026-10-06T12:00:00.000Z']));
  });

  test('a custom range keeps re-reading, since requests still finish inside it', async ({
    page,
  }) => {
    const reads = trackReads(page);
    await page.goto(`${OVERVIEW_PATH}${CUSTOM_SEARCH}`);

    await expect.poll(() => countReads(reads, '/metrics/kpis')).toBeGreaterThan(0);
    const before = countReads(reads, '/metrics/kpis');
    await expect.poll(() => countReads(reads, '/metrics/kpis'), POLL_WAIT).toBeGreaterThan(before);
    expect(reads.filter((read) => read.path.endsWith('/metrics/kpis')).at(-1)!.to).toBe(CUSTOM.to);
  });

  test('picking the shown preset again re-reads the ranged sections and nothing else', async ({
    page,
  }) => {
    const reads = trackReads(page);
    await page.goto(OVERVIEW_PATH);
    await expect.poll(() => countReads(reads, '/metrics/kpis')).toBeGreaterThan(0);
    const project_reads = countReads(reads, '');
    const kpi_reads = countReads(reads, '/metrics/kpis');

    await page.getByTestId('project-window-toggle').getByRole('radio', { name: '7 days' }).click();

    await expect.poll(() => countReads(reads, '/metrics/kpis')).toBeGreaterThan(kpi_reads);
    expect(countReads(reads, '')).toBe(project_reads);
  });

  test('a query is compared against the medians of the range on screen', async ({ page }) => {
    const reads = trackReads(page);
    await stubOneRequest(page);
    await page.goto(`${OVERVIEW_PATH}${CUSTOM_SEARCH}`);
    await openQueryView(page);

    await page.getByTestId(`project-query-${REQUEST.session_id}`).click();

    await expect(page.getByTestId('project-query-drawer')).toBeVisible();
    const trace_read = reads.find(
      (read) => read.path === `${OVERVIEW_PATH}/requests/${REQUEST.session_id}`
    );
    expect(trace_read?.to).toBe(CUSTOM.to);
  });

  test('the run rate is the figure and unit the API reports', async ({ page }) => {
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === `${OVERVIEW_PATH}/metrics/kpis`,
      (route) => {
        const url = new URL(route.request().url());
        return fulfillJson(route, {
          project_id: PROJECT.id,
          generated_at: NOW.toISOString(),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          request_count: 3,
          block_count: 3,
          failed_block_count: 0,
          tokens: 300,
          per_block_tokens: 100,
          harness_cost: '0.0300000000',
          llm_cost: '0.3000000000',
          total_cost: '0.3300000000',
          recoverable_cost: '0.0000000000',
          per_block_cost: '0.1100000000',
          per_block_latency_ms: 1200,
          costed_block_count: 3,
          costed_request_count: 3,
          per_costed_request_cost: '0.1100000000',
          run_rate: '0.3300000000',
          run_rate_per: 'hour',
        });
      }
    );
    await page.goto(`${OVERVIEW_PATH}?range=15m`);

    await expect(page.getByTestId('project-timeseries-run-rate')).toContainText('/ hour');
  });

  test('a From later than the current time says why it cannot be applied', async ({ page }) => {
    await page.goto(OVERVIEW_PATH);

    await page.getByTestId('time-range-custom').click();
    await page.getByRole('button', { name: /October 6th/ }).click();
    await page.getByTestId('time-range-from-time').fill('14:00');

    await expect(page.getByTestId('time-range-custom-error')).toBeVisible();
    await expect(page.getByTestId('time-range-apply')).toBeDisabled();
  });
});
