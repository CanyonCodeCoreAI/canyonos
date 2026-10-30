// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelMetricRollups, otelMetrics } from '@api/db/schema';
import { prune_expired_metrics } from '@api/modules/telemetry/telemetry.retention';
import { ROLLUP_NANOS } from '@api/modules/telemetry/telemetry.rollup';
import { config } from '@core/env';

import { setupE2ETests } from './e2e.setup';
import {
  attribute,
  encode_metrics_export,
  metrics_export,
  OTLP_CONTENT_TYPE,
  post_otlp,
} from './telemetry-test.utils';
import type { OtlpExportFixture } from './telemetry-test.utils';

setupE2ETests();

const SCOPE = 'canyonos.test.metrics';

// `otel_metrics` is an append-only log with no natural key, so each test reads back only its own
// rows through a service name no other test sends.
const SHAPE_SERVICE = 'otlp-metrics-shape';
const DELTA_SERVICE = 'otlp-metrics-delta';
const HISTOGRAM_SERVICE = 'otlp-metrics-histogram';
const NAMELESS_SERVICE = 'otlp-metrics-nameless';
const TIMELESS_SERVICE = 'otlp-metrics-timeless';
const UNTYPED_SUM_SERVICE = 'otlp-metrics-untyped-sum';
const VALUELESS_SERVICE = 'otlp-metrics-valueless';
const ROLLUP_A_SERVICE = 'otlp-rollup-a';
const ROLLUP_B_SERVICE = 'otlp-rollup-b';
const ROLLUP_MERGE_SERVICE = 'otlp-rollup-merge';
const ROLLUP_RETRY_SERVICE = 'otlp-rollup-retry';
const RETENTION_SERVICE = 'otlp-retention';
const RETENTION_REPEAT_SERVICE = 'otlp-retention-repeat';

// A rollup-aligned time within the raw retention, so the prune the API runs at startup never
// reaches these rows; the nanosecond tail checks the stored precision.
const NOW_UNIX_NANO = BigInt(Date.now()) * 1_000_000n;
const TIME_UNIX_NANO =
  NOW_UNIX_NANO - (NOW_UNIX_NANO % ROLLUP_NANOS) - 2n * 3_600_000_000_000n + 123_456_789n;
const TIME_TEXT = String(TIME_UNIX_NANO);

const DELTA = 1;
const CUMULATIVE = 2;

// The sibling every skip test sends alongside the metric it expects to be dropped.
const KEPT_GAUGE: OtlpExportFixture = {
  name: 'agent.kept',
  gauge: { dataPoints: [{ timeUnixNano: TIME_TEXT, asDouble: 1 }] },
};

const stored_metrics = (service_name: string) =>
  db
    .select()
    .from(otelMetrics)
    .where(eq(otelMetrics.service_name, service_name))
    .orderBy(otelMetrics.metric_name);

/**
 * Send one unusable metric next to `KEPT_GAUGE`. The sibling row proves the export was decoded and
 * ingested, so an empty result really means the bad metric was skipped rather than that the whole
 * export was lost.
 */
async function ingest_beside_kept_gauge(service_name: string, skipped: OtlpExportFixture) {
  const response = await post_otlp(
    '/v1/metrics',
    encode_metrics_export(metrics_export(service_name, SCOPE, [skipped, KEPT_GAUGE]))
  );
  expect(response.status).toBe(200);
  return stored_metrics(service_name);
}

describe('otlp metric ingest', () => {
  test('stores a gauge and a cumulative sum as long-form rows', async () => {
    const response = await post_otlp(
      '/v1/metrics',
      encode_metrics_export(
        metrics_export(SHAPE_SERVICE, SCOPE, [
          {
            name: 'agent.queue.depth',
            unit: '{item}',
            gauge: {
              dataPoints: [
                {
                  timeUnixNano: TIME_TEXT,
                  asDouble: 12.5,
                  attributes: [attribute('queue', 'default'), attribute('shard', 3)],
                },
              ],
            },
          },
          {
            name: 'agent.requests.total',
            unit: '{request}',
            sum: {
              aggregationTemporality: CUMULATIVE,
              isMonotonic: true,
              dataPoints: [{ timeUnixNano: TIME_TEXT, asInt: '42' }],
            },
          },
        ])
      )
    );

    expect(response.status).toBe(200);

    const rows = await stored_metrics(SHAPE_SERVICE);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      service_name: SHAPE_SERVICE,
      scope_name: SCOPE,
      metric_name: 'agent.queue.depth',
      metric_unit: '{item}',
      metric_type: 'gauge',
      value: 12.5,
      resource_attributes: { 'service.name': SHAPE_SERVICE },
      data_point_attributes: { queue: 'default', shard: 3 },
    });
    expect(rows[0]?.time_unix_nano).toBe(TIME_UNIX_NANO);

    expect(rows[1]).toMatchObject({
      metric_name: 'agent.requests.total',
      metric_unit: '{request}',
      metric_type: 'sum_cumulative',
      value: 42,
      data_point_attributes: {},
    });
  });

  test('a delta sum is stored apart from a cumulative one', async () => {
    const response = await post_otlp(
      '/v1/metrics',
      encode_metrics_export(
        metrics_export(DELTA_SERVICE, SCOPE, [
          {
            name: 'agent.errors',
            sum: {
              aggregationTemporality: DELTA,
              dataPoints: [{ timeUnixNano: TIME_TEXT, asInt: '7' }],
            },
          },
        ])
      )
    );

    expect(response.status).toBe(200);
    expect(await stored_metrics(DELTA_SERVICE)).toMatchObject([
      { metric_name: 'agent.errors', metric_type: 'sum_delta', value: 7 },
    ]);
  });

  test('a histogram carries no scalar point and is skipped', async () => {
    const rows = await ingest_beside_kept_gauge(HISTOGRAM_SERVICE, {
      name: 'agent.latency',
      histogram: {
        aggregationTemporality: CUMULATIVE,
        dataPoints: [{ timeUnixNano: TIME_TEXT, count: '3', sum: 1.5 }],
      },
    });

    expect(rows.map((row) => row.metric_name)).toEqual(['agent.kept']);
  });

  test('a metric with no name is skipped', async () => {
    const rows = await ingest_beside_kept_gauge(NAMELESS_SERVICE, {
      gauge: { dataPoints: [{ timeUnixNano: TIME_TEXT, asDouble: 9 }] },
    });

    expect(rows.map((row) => row.metric_name)).toEqual(['agent.kept']);
  });

  test('a data point with no timestamp is skipped', async () => {
    const rows = await ingest_beside_kept_gauge(TIMELESS_SERVICE, {
      name: 'agent.timeless',
      gauge: { dataPoints: [{ asDouble: 9 }] },
    });

    expect(rows.map((row) => row.metric_name)).toEqual(['agent.kept']);
  });

  test('a data point with no numeric value is skipped', async () => {
    const rows = await ingest_beside_kept_gauge(VALUELESS_SERVICE, {
      name: 'agent.valueless',
      gauge: { dataPoints: [{ timeUnixNano: TIME_TEXT, attributes: [attribute('queue', 'a')] }] },
    });

    expect(rows.map((row) => row.metric_name)).toEqual(['agent.kept']);
  });

  test('a sum with an unspecified temporality is skipped', async () => {
    const rows = await ingest_beside_kept_gauge(UNTYPED_SUM_SERVICE, {
      name: 'agent.untyped.sum',
      sum: { dataPoints: [{ timeUnixNano: TIME_TEXT, asInt: '5' }] },
    });

    expect(rows.map((row) => row.metric_name)).toEqual(['agent.kept']);
  });

  test('an empty export is accepted with a zero-length protobuf body', async () => {
    const response = await post_otlp('/v1/metrics', encode_metrics_export({}));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(OTLP_CONTENT_TYPE);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('a payload that is not protobuf is rejected', async () => {
    const response = await post_otlp(
      '/v1/metrics',
      new TextEncoder().encode('not a protobuf export')
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'telemetry.invalid_payload' });
  });
});

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400n * NANOS_PER_SECOND;

const gauge_at = (
  points: readonly [time_unix_nano: bigint, value: number][]
): OtlpExportFixture => ({
  name: 'agent.cpu',
  gauge: {
    dataPoints: points.map(([time, value]) => ({ timeUnixNano: String(time), asDouble: value })),
  },
});

async function ingest_cpu(
  service_name: string,
  points: readonly [bigint, number][],
  resource_attributes: Record<string, string> = {}
): Promise<void> {
  const response = await post_otlp(
    '/v1/metrics',
    encode_metrics_export(
      metrics_export(service_name, SCOPE, [gauge_at(points)], resource_attributes)
    )
  );
  expect(response.status).toBe(200);
}

const stored_rollups = (service_names: readonly string[]) =>
  db
    .select()
    .from(otelMetricRollups)
    .where(inArray(otelMetricRollups.service_name, [...service_names]))
    .orderBy(asc(otelMetricRollups.service_name), asc(otelMetricRollups.bucket_start_unix_nano));

const seconds = (n: number): bigint => BigInt(n) * NANOS_PER_SECOND;

describe('otlp metric rollups', () => {
  test('one export writes a rollup row per metric, series and five-minute bucket', async () => {
    const T = TIME_UNIX_NANO;
    const bucket = T - (T % ROLLUP_NANOS);
    await ingest_cpu(
      ROLLUP_A_SERVICE,
      [
        [T, 10],
        [T + seconds(60), 30],
        [T + seconds(400), 50],
      ],
      { 'host.name': 'box-1' }
    );
    await ingest_cpu(ROLLUP_B_SERVICE, [[T, 7]], { 'host.name': 'box-2' });

    const rows = await stored_rollups([ROLLUP_A_SERVICE, ROLLUP_B_SERVICE]);

    expect(rows).toMatchObject([
      {
        service_name: ROLLUP_A_SERVICE,
        metric_name: 'agent.cpu',
        metric_type: 'gauge',
        resource_attributes: { 'service.name': ROLLUP_A_SERVICE, 'host.name': 'box-1' },
        data_point_attributes: {},
        bucket_start_unix_nano: bucket,
        sum: 40,
        count: 2,
        min: 10,
        max: 30,
        last_value: 30,
        last_time_unix_nano: T + seconds(60),
      },
      {
        service_name: ROLLUP_A_SERVICE,
        bucket_start_unix_nano: bucket + ROLLUP_NANOS,
        sum: 50,
        count: 1,
        min: 50,
        max: 50,
        last_value: 50,
        last_time_unix_nano: T + seconds(400),
      },
      {
        service_name: ROLLUP_B_SERVICE,
        resource_attributes: { 'service.name': ROLLUP_B_SERVICE, 'host.name': 'box-2' },
        bucket_start_unix_nano: bucket,
        sum: 7,
        count: 1,
        min: 7,
        max: 7,
        last_value: 7,
        last_time_unix_nano: T,
      },
    ]);
    expect(rows).toHaveLength(3);
  });

  test('a second export into the same bucket adds to it and keeps the newest value last', async () => {
    const T = TIME_UNIX_NANO;
    await ingest_cpu(ROLLUP_MERGE_SERVICE, [[T + seconds(60), 30]]);
    await ingest_cpu(ROLLUP_MERGE_SERVICE, [
      [T + seconds(120), 5],
      [T + seconds(30), 9],
    ]);

    expect(await stored_rollups([ROLLUP_MERGE_SERVICE])).toMatchObject([
      { sum: 44, count: 3, min: 5, max: 30, last_value: 5, last_time_unix_nano: T + seconds(120) },
    ]);

    // An export that arrives late, with only points older than the bucket's newest, must not move
    // `last_value` back in time.
    await ingest_cpu(ROLLUP_MERGE_SERVICE, [[T + seconds(90), 20]]);

    expect(await stored_rollups([ROLLUP_MERGE_SERVICE])).toMatchObject([
      { sum: 64, count: 4, min: 5, max: 30, last_value: 5, last_time_unix_nano: T + seconds(120) },
    ]);
  });

  test('a retried export doubles the rollup the way it doubles the raw rows', async () => {
    const points: [bigint, number][] = [[TIME_UNIX_NANO, 4]];
    await ingest_cpu(ROLLUP_RETRY_SERVICE, points);
    await ingest_cpu(ROLLUP_RETRY_SERVICE, points);

    expect(await stored_metrics(ROLLUP_RETRY_SERVICE)).toHaveLength(2);
    expect(await stored_rollups([ROLLUP_RETRY_SERVICE])).toMatchObject([{ sum: 8, count: 2 }]);
  });
});

const raw_times = async (service_name: string): Promise<bigint[]> =>
  (await stored_metrics(service_name))
    .map((row) => row.time_unix_nano)
    .sort((a, b) => (a < b ? -1 : 1));

const rollup_buckets = async (service_name: string): Promise<bigint[]> =>
  (await stored_rollups([service_name])).map((row) => row.bucket_start_unix_nano);

const bucket_of = (time_unix_nano: bigint): bigint =>
  time_unix_nano - (time_unix_nano % ROLLUP_NANOS);

describe('metric retention', () => {
  // Offsets track the configured retention so the test keeps meaning the same after a default
  // changes.
  const now = new Date();
  const now_nano = BigInt(now.getTime()) * 1_000_000n;
  const recent = now_nano - seconds(3600);
  const past_raw = now_nano - BigInt(config.metrics.rawRetentionDays + 1) * NANOS_PER_DAY;
  const past_rollup = now_nano - BigInt(config.metrics.rollupRetentionDays + 1) * NANOS_PER_DAY;

  test('prune_expired_metrics drops raw past the raw cutoff and rollups past the rollup cutoff', async () => {
    await ingest_cpu(RETENTION_SERVICE, [
      [recent, 1],
      [past_raw, 2],
      [past_rollup, 3],
    ]);

    const result = await prune_expired_metrics(now);

    expect(await raw_times(RETENTION_SERVICE)).toEqual([recent]);
    expect(await rollup_buckets(RETENTION_SERVICE)).toEqual([
      bucket_of(past_raw),
      bucket_of(recent),
    ]);
    expect(result.raw_deleted).toBeGreaterThanOrEqual(2);
    expect(result.rollups_deleted).toBeGreaterThanOrEqual(1);
  });

  test('a second run deletes nothing', async () => {
    await ingest_cpu(RETENTION_REPEAT_SERVICE, [
      [recent, 1],
      [past_raw, 2],
      [past_rollup, 3],
    ]);
    await prune_expired_metrics(now);
    const raw_after_first = await raw_times(RETENTION_REPEAT_SERVICE);
    const rollups_after_first = await rollup_buckets(RETENTION_REPEAT_SERVICE);

    expect(await prune_expired_metrics(now)).toEqual({ raw_deleted: 0, rollups_deleted: 0 });
    expect(await raw_times(RETENTION_REPEAT_SERVICE)).toEqual(raw_after_first);
    expect(await rollup_buckets(RETENTION_REPEAT_SERVICE)).toEqual(rollups_after_first);
    expect(raw_after_first).toEqual([recent]);
  });
});
