// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';

import { Root } from 'protobufjs';
import type { Type } from 'protobufjs';

import { db } from '@api/db/client';
import { GEN_AI, RUNTIME_ATTRIBUTES } from '@api/modules/metrics/metrics.contract';
import {
  STATUS_CODE,
  WORKFLOW_GROUP_ID_ATTRIBUTE,
  WORKFLOW_ID_ATTRIBUTE,
} from '@api/modules/telemetry/telemetry.contract';
import { otelSpans } from '@api/modules/telemetry/telemetry.schema';
import { config } from '@core/env';

type AttributeValue = number | string | boolean | Record<string, unknown>;

/** An event as `otel_spans.events` stores it: attributes flattened to dotted keys. */
export interface SpanEventFixture {
  readonly time_unix_nano: string;
  readonly name: string;
  readonly attributes: Record<string, AttributeValue>;
}

export interface SpanFixture {
  readonly span_id: string;
  readonly trace_id?: string;
  readonly parent_span_id?: string;
  readonly name?: string;
  readonly start_time_unix_nano?: bigint;
  readonly end_time_unix_nano?: bigint;
  readonly failed?: boolean;
  readonly status_message?: string;
  readonly events?: readonly SpanEventFixture[];
  readonly model?: string;
  readonly prompt_name?: string;
  readonly prompt_version?: string;
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
    [RUNTIME_ATTRIBUTES.PROMPT_NAME, span.prompt_name],
    [RUNTIME_ATTRIBUTES.PROMPT_VERSION, span.prompt_version],
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
    parent_span_id: span.parent_span_id ?? null,
    name: span.name ?? span.span_id,
    status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
    status_message: span.status_message ?? null,
    start_time_unix_nano: start,
    end_time_unix_nano: span.end_time_unix_nano ?? start + 1_000_000n,
    attributes: { ...attributes, ...Object.fromEntries(attribute_entries(span)) },
    events: span.events ?? [],
    input: span.input ?? null,
    output: span.output ?? null,
  });
}

/** Writes a span of the workflow, the one workflow of a workflow group with its id (see
 * create_test_workflow). */
export async function write_workflow_span(workflow_id: string, span: SpanFixture): Promise<void> {
  await insert_span(span, {
    [WORKFLOW_ID_ATTRIBUTE]: workflow_id,
    [WORKFLOW_GROUP_ID_ATTRIBUTE]: workflow_id,
  });
}

export async function write_unattributed_span(span: SpanFixture): Promise<void> {
  await insert_span(span, {});
}

// Wire fixtures are deliberately untyped: a test must be able to send what a producer should not,
// such as a metric with no name or a data point with no timestamp.
export type OtlpExportFixture = Record<string, unknown>;

// The ingest tests drive the real OTLP boundary, so they build wire bytes from the same
// vendored protos the receiver decodes. The decoder's loader is private, so this is its own `Root`.
const PROTO_ROOT = fileURLToPath(new URL('../modules/telemetry/proto/', import.meta.url));

type OtlpSignal = 'trace' | 'metrics' | 'logs';

const SERVICE_NAMES = { trace: 'Trace', metrics: 'Metrics', logs: 'Logs' } as const;

const roots: Partial<Record<OtlpSignal, Root>> = {};

/** The `Export<Signal>Service<message>` type of `signal`. */
const service_type = (signal: OtlpSignal, message: 'Request' | 'Response'): Type => {
  let root = roots[signal];
  if (!root) {
    root = new Root();
    root.resolvePath = (_origin, target) => PROTO_ROOT + target;
    root.loadSync(`opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`);
    roots[signal] = root;
  }
  return root.lookupType(
    `opentelemetry.proto.collector.${signal}.v1.Export${SERVICE_NAMES[signal]}Service${message}`
  );
};

/**
 * Encode an export request. `fromObject` ignores keys the proto does not define, so a misspelled
 * fixture field vanishes instead of failing. Every "this is not stored" test therefore also asserts
 * that a valid sibling in the same export was stored, which proves the export really arrived.
 */
const encode_export = (signal: OtlpSignal, request: OtlpExportFixture): Uint8Array => {
  const type = service_type(signal, 'Request');
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

/** Wrap metrics in the resource/scope envelope an exporter sends, its resource carrying
 * workflow group `workflow_group_id`. */
export const metrics_export = (
  workflow_group_id: string,
  service_name: string,
  scope_name: string,
  metrics: readonly OtlpExportFixture[],
  resource_attributes: Record<string, string | number | boolean> = {}
): OtlpExportFixture => ({
  resourceMetrics: [
    {
      resource: {
        attributes: [
          attribute(SERVICE_NAME_ATTRIBUTE, service_name),
          attribute(WORKFLOW_GROUP_ID_ATTRIBUTE, workflow_group_id),
          ...Object.entries(resource_attributes).map(([key, value]) => attribute(key, value)),
        ],
      },
      scopeMetrics: [{ scope: { name: scope_name }, metrics }],
    },
  ],
});

/** Wrap log records in the resource/scope envelope an exporter sends, its resource carrying
 * workflow group `workflow_group_id`. */
export const logs_export = (
  workflow_group_id: string,
  service_name: string,
  scope_name: string,
  logRecords: readonly OtlpExportFixture[]
): OtlpExportFixture => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          attribute(SERVICE_NAME_ATTRIBUTE, service_name),
          attribute(WORKFLOW_GROUP_ID_ATTRIBUTE, workflow_group_id),
        ],
      },
      scopeLogs: [{ scope: { name: scope_name }, logRecords }],
    },
  ],
});

export const encode_trace_export = (request: OtlpExportFixture): Uint8Array =>
  encode_export('trace', request);

export const encode_metrics_export = (request: OtlpExportFixture): Uint8Array =>
  encode_export('metrics', request);

export const encode_logs_export = (request: OtlpExportFixture): Uint8Array =>
  encode_export('logs', request);

/** Decode the `ExportTraceServiceResponse` a trace export is answered with; counts as numbers. */
export const decode_trace_response = (body: ArrayBuffer): Record<string, unknown> => {
  const type = service_type('trace', 'Response');
  return type.toObject(type.decode(new Uint8Array(body)), { longs: Number });
};

export const OTLP_CONTENT_TYPE = 'application/x-protobuf';

/** POST raw OTLP bytes to workflow group `workflow_group_id`'s `signal` route the way an exporter
 * does: `application/x-protobuf`, no JSON envelope, no key. */
export const post_otlp = (
  workflow_group_id: string,
  signal: 'traces' | 'metrics' | 'logs',
  payload: Uint8Array
): Promise<Response> =>
  fetch(`${config.app.apiUrl}/v1/workflow-groups/${workflow_group_id}/${signal}`, {
    method: 'POST',
    headers: { 'content-type': OTLP_CONTENT_TYPE },
    // `fetch` takes a view over a plain `ArrayBuffer`; protobufjs writes into a pooled one.
    body: new Uint8Array(payload),
  });
