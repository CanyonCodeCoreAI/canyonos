import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs } from '@api/db/schema';

import { setupE2ETests } from './e2e.setup';
import {
  attribute,
  encode_logs_export,
  logs_export,
  OTLP_CONTENT_TYPE,
  post_otlp,
} from './telemetry-test.utils';

setupE2ETests();

const SCOPE = 'canyonos.test.logs';

// `otel_logs` is an append-only log with no natural key, so each test reads back only its own rows
// through a service name no other test sends.
const CORRELATED_SERVICE = 'otlp-logs-correlated';
const STRUCTURED_SERVICE = 'otlp-logs-structured';
const OBSERVED_ONLY_SERVICE = 'otlp-logs-observed-only';
const UNCORRELATED_SERVICE = 'otlp-logs-uncorrelated';

const TIME_UNIX_NANO = 1_788_000_000_123_456_789n;
const TIME_TEXT = String(TIME_UNIX_NANO);
const OBSERVED_UNIX_NANO = 1_788_000_000_987_654_321n;

const random_id = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const stored_logs = (service_name: string) =>
  db.select().from(otelLogs).where(eq(otelLogs.service_name, service_name));

describe('otlp log ingest', () => {
  test('stores a record with its severity, trace context and attributes', async () => {
    const trace_id = random_id(16);
    const span_id = random_id(8);

    const response = await post_otlp(
      '/v1/logs',
      encode_logs_export(
        logs_export(CORRELATED_SERVICE, SCOPE, [
          {
            timeUnixNano: TIME_TEXT,
            observedTimeUnixNano: String(OBSERVED_UNIX_NANO),
            severityNumber: 17,
            severityText: 'ERROR',
            body: { stringValue: 'the agent step failed' },
            traceId: trace_id,
            spanId: span_id,
            attributes: [attribute('step', 'plan'), attribute('attempt', 2)],
          },
        ])
      )
    );

    expect(response.status).toBe(200);

    const rows = await stored_logs(CORRELATED_SERVICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service_name: CORRELATED_SERVICE,
      scope_name: SCOPE,
      severity_number: 17,
      severity_text: 'ERROR',
      body: 'the agent step failed',
      trace_id: hex(trace_id),
      span_id: hex(span_id),
      resource_attributes: { 'service.name': CORRELATED_SERVICE },
      attributes: { step: 'plan', attempt: 2 },
    });
    expect(rows[0]?.time_unix_nano).toBe(TIME_UNIX_NANO);
    expect(rows[0]?.observed_time_unix_nano).toBe(OBSERVED_UNIX_NANO);
  });

  test('a structured body is stored as its JSON encoding', async () => {
    const response = await post_otlp(
      '/v1/logs',
      encode_logs_export(
        logs_export(STRUCTURED_SERVICE, SCOPE, [
          {
            timeUnixNano: TIME_TEXT,
            body: {
              kvlistValue: { values: [attribute('code', 500), attribute('why', 'timeout')] },
            },
          },
        ])
      )
    );

    expect(response.status).toBe(200);

    const rows = await stored_logs(STRUCTURED_SERVICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(JSON.stringify({ code: 500, why: 'timeout' }));
  });

  test('a record with only an observed time is stamped with it', async () => {
    const response = await post_otlp(
      '/v1/logs',
      encode_logs_export(
        logs_export(OBSERVED_ONLY_SERVICE, SCOPE, [
          {
            observedTimeUnixNano: String(OBSERVED_UNIX_NANO),
            body: { stringValue: 'collected late' },
          },
        ])
      )
    );

    expect(response.status).toBe(200);

    const rows = await stored_logs(OBSERVED_ONLY_SERVICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.time_unix_nano).toBe(OBSERVED_UNIX_NANO);
    expect(rows[0]?.observed_time_unix_nano).toBe(OBSERVED_UNIX_NANO);
  });

  test('a record outside any span keeps null trace and span ids', async () => {
    const response = await post_otlp(
      '/v1/logs',
      encode_logs_export(
        logs_export(UNCORRELATED_SERVICE, SCOPE, [
          { timeUnixNano: TIME_TEXT, body: { stringValue: 'agent level' } },
        ])
      )
    );

    expect(response.status).toBe(200);

    const rows = await stored_logs(UNCORRELATED_SERVICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trace_id: null,
      span_id: null,
      severity_number: null,
      severity_text: null,
      attributes: {},
    });
  });

  test('an empty export is accepted with a zero-length protobuf body', async () => {
    const response = await post_otlp('/v1/logs', encode_logs_export({}));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(OTLP_CONTENT_TYPE);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('a payload that is not protobuf is rejected', async () => {
    const response = await post_otlp('/v1/logs', new TextEncoder().encode('not a protobuf export'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'telemetry.invalid_payload' });
  });
});
