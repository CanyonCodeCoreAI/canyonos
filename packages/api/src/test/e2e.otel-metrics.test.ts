import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelMetrics } from '@api/db/schema';

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

const TIME_UNIX_NANO = 1_788_000_000_123_456_789n;
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
