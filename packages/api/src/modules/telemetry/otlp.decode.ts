import { fileURLToPath } from 'node:url';

import { Root } from 'protobufjs';
import type { Type } from 'protobufjs';

// `@opentelemetry/otlp-transformer` only serializes requests and deserializes responses — it is a
// client library and exposes no request decoder. The OTLP protos are vendored here instead, and
// every `import` inside them resolves against this one root directory.
const PROTO_ROOT = fileURLToPath(new URL('./proto/', import.meta.url));

/**
 * A protobuf int64 rendered as a decimal string. Nanosecond timestamps exceed the range a JS
 * number holds exactly, so they stay textual until the caller turns them into a bigint.
 */
export type Int64String = string;

export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: Int64String;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values?: readonly OtlpAnyValue[] };
  readonly kvlistValue?: { readonly values?: readonly OtlpKeyValue[] };
  readonly bytesValue?: Uint8Array;
}

export interface OtlpKeyValue {
  readonly key?: string;
  readonly value?: OtlpAnyValue;
}

export interface OtlpEvent {
  readonly timeUnixNano?: Int64String;
  readonly name?: string;
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpSpan {
  readonly traceId?: Uint8Array;
  readonly spanId?: Uint8Array;
  readonly parentSpanId?: Uint8Array;
  readonly name?: string;
  readonly kind?: number;
  readonly startTimeUnixNano?: Int64String;
  readonly endTimeUnixNano?: Int64String;
  readonly attributes?: readonly OtlpKeyValue[];
  readonly events?: readonly OtlpEvent[];
  readonly status?: { readonly code?: number; readonly message?: string };
}

export interface OtlpExportTraceServiceRequest {
  readonly resourceSpans?: readonly {
    readonly scopeSpans?: readonly { readonly spans?: readonly OtlpSpan[] }[];
  }[];
}

// A gauge/sum data point. `oneofs: false` leaves exactly one of `asDouble`/`asInt` set, mirroring
// how an `AnyValue` carries a single typed key.
export interface OtlpNumberDataPoint {
  readonly attributes?: readonly OtlpKeyValue[];
  readonly timeUnixNano?: Int64String;
  readonly asDouble?: number;
  readonly asInt?: Int64String;
}

export interface OtlpMetric {
  readonly name?: string;
  readonly unit?: string;
  // Only gauge and sum carry the scalar `NumberDataPoint`s this table stores; histogram, summary
  // and exponential histogram points are decoded but ignored by the ingest.
  readonly gauge?: { readonly dataPoints?: readonly OtlpNumberDataPoint[] };
  readonly sum?: {
    readonly dataPoints?: readonly OtlpNumberDataPoint[];
    // `AggregationTemporality`: 1 is delta, 2 is cumulative. A producer that leaves it unspecified
    // (0, absent under `defaults: false`) has not said how its points combine.
    readonly aggregationTemporality?: number;
  };
}

export interface OtlpResourceMetrics {
  readonly resource?: { readonly attributes?: readonly OtlpKeyValue[] };
  readonly scopeMetrics?: readonly {
    readonly scope?: { readonly name?: string };
    readonly metrics?: readonly OtlpMetric[];
  }[];
}

export interface OtlpExportMetricsServiceRequest {
  readonly resourceMetrics?: readonly OtlpResourceMetrics[];
}

export interface OtlpLogRecord {
  readonly timeUnixNano?: Int64String;
  readonly observedTimeUnixNano?: Int64String;
  readonly severityNumber?: number;
  readonly severityText?: string;
  readonly body?: OtlpAnyValue;
  readonly attributes?: readonly OtlpKeyValue[];
  readonly traceId?: Uint8Array;
  readonly spanId?: Uint8Array;
}

export interface OtlpResourceLogs {
  readonly resource?: { readonly attributes?: readonly OtlpKeyValue[] };
  readonly scopeLogs?: readonly {
    readonly scope?: { readonly name?: string };
    readonly logRecords?: readonly OtlpLogRecord[];
  }[];
}

export interface OtlpExportLogsServiceRequest {
  readonly resourceLogs?: readonly OtlpResourceLogs[];
}

// Every OTLP collector service is named the same way, so one loader serves all three signals.
const OTLP_SIGNALS = { trace: 'Trace', metrics: 'Metrics', logs: 'Logs' } as const;

type OtlpSignal = keyof typeof OTLP_SIGNALS;

const loaded_types: Partial<Record<OtlpSignal, { request: Type; response: Type }>> = {};

const service_types = (signal: OtlpSignal) => {
  const cached = loaded_types[signal];
  if (cached) return cached;

  const root = new Root();
  root.resolvePath = (_origin, target) => PROTO_ROOT + target;
  root.loadSync(`opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`);

  const service = `opentelemetry.proto.collector.${signal}.v1.Export${OTLP_SIGNALS[signal]}Service`;
  const types = {
    request: root.lookupType(`${service}Request`),
    response: root.lookupType(`${service}Response`),
  };
  loaded_types[signal] = types;
  return types;
};

/**
 * `defaults: false` with `oneofs: false` leaves exactly the fields the producer set, so an
 * `AnyValue` carries a single key and its type is readable from that key alone.
 */
const DECODE_OPTIONS = {
  longs: String,
  enums: Number,
  defaults: false,
  arrays: false,
  objects: false,
  oneofs: false,
};

const decode_request = <T>(signal: OtlpSignal, payload: Uint8Array): T => {
  const { request } = service_types(signal);
  return request.toObject(request.decode(payload), DECODE_OPTIONS) as T;
};

/** Decode an `ExportTraceServiceRequest`. Throws when the payload is not valid protobuf. */
export const decode_export_request = (payload: Uint8Array): OtlpExportTraceServiceRequest =>
  decode_request('trace', payload);

/** Decode an `ExportMetricsServiceRequest`. Throws when the payload is not valid protobuf. */
export const decode_metrics_export_request = (
  payload: Uint8Array
): OtlpExportMetricsServiceRequest => decode_request('metrics', payload);

/** Decode an `ExportLogsServiceRequest`. Throws when the payload is not valid protobuf. */
export const decode_logs_export_request = (payload: Uint8Array): OtlpExportLogsServiceRequest =>
  decode_request('logs', payload);

/**
 * Encode the OTLP trace response. Full success is a zero-byte body; dropped spans are reported as a
 * partial success, which the spec tells clients not to retry.
 */
export const encode_export_response = (
  rejected_spans: number,
  error_message: string
): Uint8Array => {
  const { response } = service_types('trace');
  const payload =
    rejected_spans > 0
      ? { partialSuccess: { rejectedSpans: rejected_spans, errorMessage: error_message } }
      : {};
  return response.encode(response.create(payload)).finish();
};
