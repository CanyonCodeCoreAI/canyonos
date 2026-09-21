import { fileURLToPath } from 'node:url';

import { Root } from 'protobufjs';
import type { Type } from 'protobufjs';

// `@opentelemetry/otlp-transformer` only serializes requests and deserializes responses — it is a
// client library and exposes no request decoder. The OTLP protos are vendored here instead, and
// every `import` inside them resolves against this one root directory.
const PROTO_ROOT = fileURLToPath(new URL('./proto/', import.meta.url));
const TRACE_SERVICE_PROTO = 'opentelemetry/proto/collector/trace/v1/trace_service.proto';
const COLLECTOR_PACKAGE = 'opentelemetry.proto.collector.trace.v1';

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

let otlpTypes: { request: Type; response: Type } | null = null;

const resolve_types = () => {
  if (otlpTypes) return otlpTypes;
  const root = new Root();
  root.resolvePath = (_origin, target) => PROTO_ROOT + target;
  root.loadSync(TRACE_SERVICE_PROTO);
  otlpTypes = {
    request: root.lookupType(`${COLLECTOR_PACKAGE}.ExportTraceServiceRequest`),
    response: root.lookupType(`${COLLECTOR_PACKAGE}.ExportTraceServiceResponse`),
  };
  return otlpTypes;
};

/**
 * Decode an `ExportTraceServiceRequest`. Throws when the payload is not valid protobuf.
 *
 * `defaults: false` with `oneofs: false` leaves exactly the fields the producer set, so an
 * `AnyValue` carries a single key and its type is readable from that key alone.
 */
export const decode_export_request = (payload: Uint8Array): OtlpExportTraceServiceRequest => {
  const { request } = resolve_types();
  return request.toObject(request.decode(payload), {
    longs: String,
    enums: Number,
    defaults: false,
    arrays: false,
    objects: false,
    oneofs: false,
  }) as OtlpExportTraceServiceRequest;
};

/**
 * Encode the OTLP response. Full success is a zero-byte body; dropped spans are reported as a
 * partial success, which the spec tells clients not to retry.
 */
export const encode_export_response = (
  rejected_spans: number,
  error_message: string
): Uint8Array => {
  const { response } = resolve_types();
  const payload =
    rejected_spans > 0
      ? { partialSuccess: { rejectedSpans: rejected_spans, errorMessage: error_message } }
      : {};
  return response.encode(response.create(payload)).finish();
};
