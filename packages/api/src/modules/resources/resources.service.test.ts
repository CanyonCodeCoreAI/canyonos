import { describe, expect, test } from 'bun:test';

import { build_overview } from './resources.service';
import type { FleetProjectRow } from './resources.repo';

const row = (overrides: Partial<FleetProjectRow> & { project_id: string }): FleetProjectRow => ({
  name: overrides.project_id,
  created_at: '2026-01-01T00:00:00.000Z',
  request_count: 0,
  block_count: 0,
  failed_block_count: 0,
  tokens: 0,
  total_cost: '0',
  avg_latency_ms: null,
  ...overrides,
});

const kpi = (overview: { kpis: { id: string; value: string }[] }, id: string): string =>
  overview.kpis.find((entry) => entry.id === id)!.value;

describe('build_overview', () => {
  test('sums spend, requests and tokens across the fleet', () => {
    const overview = build_overview(
      [
        row({
          project_id: 'alpha',
          request_count: 2,
          block_count: 2,
          tokens: 1_200_000,
          total_cost: '1',
          avg_latency_ms: 2000,
        }),
        row({
          project_id: 'bravo',
          request_count: 1,
          block_count: 1,
          tokens: 300_000,
          total_cost: '1',
          avg_latency_ms: 2000,
        }),
        row({ project_id: 'charlie' }),
      ],
      '30d'
    );

    expect(kpi(overview, 'total_spend')).toBe('$2');
    expect(kpi(overview, 'requests')).toBe('3');
    expect(kpi(overview, 'tokens')).toBe('1.5M');
    expect(kpi(overview, 'avg_latency')).toBe('2.0 s');
    expect(overview.kpis.find((entry) => entry.id === 'active_projects')).toMatchObject({
      value: '2',
      sub_label: '3 total',
      tone: 'positive',
    });
    expect(overview.resources.find((resource) => resource.id === 'tokens')).toMatchObject({
      available: true,
      unit: 'M',
      pool: 1.5,
    });
  });

  test('weights fleet latency by block count and ignores projects with no completed block', () => {
    const overview = build_overview(
      [
        row({ project_id: 'slow', block_count: 3, avg_latency_ms: 3000, request_count: 1 }),
        row({ project_id: 'fast', block_count: 1, avg_latency_ms: 1000, request_count: 1 }),
        row({ project_id: 'idle', block_count: 0, avg_latency_ms: null }),
      ],
      '7d'
    );

    expect(kpi(overview, 'avg_latency')).toBe('2.5 s');
    expect(overview.projects.map((project) => project.avg_latency_ms)).toEqual([3000, 1000, 0]);
  });

  test('reports the failure share per project and cycles the palette', () => {
    const overview = build_overview(
      [
        row({ project_id: 'p1', block_count: 4, failed_block_count: 1 }),
        row({ project_id: 'p2' }),
        row({ project_id: 'p3' }),
        row({ project_id: 'p4' }),
        row({ project_id: 'p5' }),
        row({ project_id: 'p6' }),
        row({ project_id: 'p7' }),
      ],
      '1d'
    );

    expect(overview.projects[0]!.error_rate_pct).toBe(25);
    expect(overview.projects[1]!.error_rate_pct).toBe(0);
    expect(overview.projects.map((project) => project.color_index)).toEqual([0, 1, 2, 3, 4, 5, 0]);
  });

  test('zeroes every KPI and pool for an empty fleet', () => {
    const overview = build_overview([], '7d');

    expect(overview.projects).toEqual([]);
    expect(kpi(overview, 'total_spend')).toBe('$0');
    expect(kpi(overview, 'active_projects')).toBe('0');
    expect(kpi(overview, 'requests')).toBe('0');
    expect(kpi(overview, 'tokens')).toBe('0');
    expect(kpi(overview, 'avg_latency')).toBe('0 ms');
    expect(overview.kpis.find((entry) => entry.id === 'active_projects')).toMatchObject({
      sub_label: '0 total',
      tone: 'neutral',
    });
    expect(overview.resources.map((resource) => resource.id)).toEqual([
      'gpu',
      'cpu',
      'mem',
      'storage',
      'tokens',
    ]);
    expect(overview.resources.every((resource) => resource.pool === 0)).toBe(true);
  });

  test('names the window in every KPI sub-label', () => {
    const overview = build_overview([row({ project_id: 'only' })], '1q');

    expect(kpi(overview, 'total_spend')).toBe('$0');
    expect(overview.kpis.find((entry) => entry.id === 'requests')?.sub_label).toBe('last 90 days');
  });
});
