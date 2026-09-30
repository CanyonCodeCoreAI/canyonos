import { fileURLToPath } from 'node:url';

import { Root } from 'protobufjs';
import type { Type } from 'protobufjs';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import {
  GEN_AI,
  PROJECT_ID_ATTRIBUTE,
  RUNTIME_ATTRIBUTES,
  STATUS_CODE,
} from '@api/modules/metrics/metrics.contract';
import { config } from '@core/env';

type AttributeValue = number | string | boolean | Record<string, unknown>;

export interface SpanFixture {
  readonly span_id: string;
  readonly trace_id?: string;
  readonly name?: string;
  readonly start_time_unix_nano?: bigint;
  readonly end_time_unix_nano?: bigint;
  readonly failed?: boolean;
  readonly model?: string;
  readonly input_tokens?: AttributeValue;
  readonly output_tokens?: AttributeValue;
  readonly cost?: AttributeValue;
  readonly token_cost?: AttributeValue;
  readonly server_cost?: AttributeValue;
  readonly error_count?: AttributeValue;
  readonly input?: string;
  readonly output?: string;
}

const DEFAULT_START_UNIX_NANO = 1_788_000_000_000_000_000n;

const attribute_entries = (span: SpanFixture): [string, unknown][] => {
  const optional: [string, AttributeValue | undefined][] = [
    [GEN_AI.REQUEST_MODEL, span.model],
    [GEN_AI.INPUT_TOKENS, span.input_tokens],
    [GEN_AI.OUTPUT_TOKENS, span.output_tokens],
    [GEN_AI.USAGE_COST, span.cost],
    [RUNTIME_ATTRIBUTES.TOKEN_COST, span.token_cost],
    [RUNTIME_ATTRIBUTES.SERVER_COST, span.server_cost],
    [RUNTIME_ATTRIBUTES.ERROR_COUNT, span.error_count],
  ];
  return optional.filter(([, value]) => value !== undefined) as [string, unknown][];
};

async function insert_span(span: SpanFixture, attributes: Record<string, unknown>): Promise<void> {
  const start = span.start_time_unix_nano ?? DEFAULT_START_UNIX_NANO;
  await db.insert(otelSpans).values({
    span_id: span.span_id,
    trace_id: span.trace_id ?? `trace-${span.span_id}`,
    name: span.name ?? span.span_id,
    status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
    start_time_unix_nano: start,
    end_time_unix_nano: span.end_time_unix_nano ?? start + 1_000_000n,
    attributes: { ...attributes, ...Object.fromEntries(attribute_entries(span)) },
    input: span.input ?? null,
    output: span.output ?? null,
  });
}

export async function write_project_span(project_id: string, span: SpanFixture): Promise<void> {
  await insert_span(span, { [PROJECT_ID_ATTRIBUTE]: project_id });
}

export async function write_unattributed_span(span: SpanFixture): Promise<void> {
  await insert_span(span, {});
}

// Wire fixtures are deliberately untyped: a test must be able to send what a producer should not,
// such as a metric with no name or a data point with no timestamp.
export type OtlpExportFixture = Record<string, unknown>;

// The metric and log tests drive the real OTLP boundary, so they build wire bytes from the same
// vendored protos the receiver decodes. The decoder's loader is private, so this is its own `Root`.
const PROTO_ROOT = fileURLToPath(new URL('../modules/telemetry/proto/', import.meta.url));

type OtlpSignal = 'metrics' | 'logs';

const REQUEST_NAMES = { metrics: 'Metrics', logs: 'Logs' } as const;

const request_types: Partial<Record<OtlpSignal, Type>> = {};

const request_type = (signal: OtlpSignal): Type => {
  const cached = request_types[signal];
  if (cached) return cached;

  const root = new Root();
  root.resolvePath = (_origin, target) => PROTO_ROOT + target;
  root.loadSync(`opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`);
  const type = root.lookupType(
    `opentelemetry.proto.collector.${signal}.v1.Export${REQUEST_NAMES[signal]}ServiceRequest`
  );
  request_types[signal] = type;
  return type;
};

/**
 * Encode an export request. `fromObject` ignores keys the proto does not define, so a misspelled
 * fixture field vanishes instead of failing. Every "this is not stored" test therefore also asserts
 * that a valid sibling in the same export was stored, which proves the export really arrived.
 */
const encode_export = (signal: OtlpSignal, request: OtlpExportFixture): Uint8Array => {
  const type = request_type(signal);
  return type.encode(type.fromObject(request)).finish();
};

const SERVICE_NAME_ATTRIBUTE = 'service.name';

/** One `KeyValue` entry. The `AnyValue` key picks the type the receiver flattens to. */
export const attribute = (key: string, value: string | number | boolean): OtlpExportFixture => {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
};

/** Wrap metrics in the resource/scope envelope an exporter sends. */
export const metrics_export = (
  service_name: string,
  scope_name: string,
  metrics: readonly OtlpExportFixture[]
): OtlpExportFixture => ({
  resourceMetrics: [
    {
      resource: { attributes: [attribute(SERVICE_NAME_ATTRIBUTE, service_name)] },
      scopeMetrics: [{ scope: { name: scope_name }, metrics }],
    },
  ],
});

/** Wrap log records in the resource/scope envelope an exporter sends. */
export const logs_export = (
  service_name: string,
  scope_name: string,
  logRecords: readonly OtlpExportFixture[]
): OtlpExportFixture => ({
  resourceLogs: [
    {
      resource: { attributes: [attribute(SERVICE_NAME_ATTRIBUTE, service_name)] },
      scopeLogs: [{ scope: { name: scope_name }, logRecords }],
    },
  ],
});

export const encode_metrics_export = (request: OtlpExportFixture): Uint8Array =>
  encode_export('metrics', request);

export const encode_logs_export = (request: OtlpExportFixture): Uint8Array =>
  encode_export('logs', request);

export const OTLP_CONTENT_TYPE = 'application/x-protobuf';

/** POST raw OTLP bytes the way an exporter does: `application/x-protobuf`, no JSON envelope. */
export const post_otlp = (path: string, payload: Uint8Array): Promise<Response> =>
  fetch(`${config.app.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': OTLP_CONTENT_TYPE },
    // `fetch` takes a view over a plain `ArrayBuffer`; protobufjs writes into a pooled one.
    body: new Uint8Array(payload),
  });
