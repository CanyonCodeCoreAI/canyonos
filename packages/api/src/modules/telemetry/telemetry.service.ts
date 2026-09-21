import { PROJECT_ID_ATTRIBUTE, STATUS_CODE } from '@api/modules/metrics/metrics.contract';
import { badRequest } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { decode_export_request } from './otlp.decode';
import { insert_spans } from './telemetry.repo';
import type { OtlpAnyValue, OtlpEvent, OtlpKeyValue, OtlpSpan } from './otlp.decode';
import type { SpanRow } from './telemetry.repo';

const telemetryLogger = logger.child({ domain: LOG_DOMAINS.TELEMETRY });

// Proto enum names indexed by their wire value. The dashboard matches these strings exactly.
const SPAN_KIND_NAMES = [
  'SPAN_KIND_UNSPECIFIED',
  'SPAN_KIND_INTERNAL',
  'SPAN_KIND_SERVER',
  'SPAN_KIND_CLIENT',
  'SPAN_KIND_PRODUCER',
  'SPAN_KIND_CONSUMER',
] as const;
const STATUS_CODE_NAMES = [STATUS_CODE.UNSET, STATUS_CODE.OK, STATUS_CODE.ERROR] as const;

// Ventis names the project attribute `project_id`; every dashboard query reads `canyon.project.id`.
const PRODUCER_PROJECT_ID_ATTRIBUTE = 'project_id';
const INPUT_ATTRIBUTE = 'langfuse.observation.input';
const OUTPUT_ATTRIBUTE = 'langfuse.observation.output';

// Some producers send eight zero bytes instead of an empty field for a root span's parent.
const ABSENT_PARENT_SPAN_ID = '0'.repeat(16);

const hex = (bytes: Uint8Array | undefined): string =>
  bytes && bytes.length > 0 ? Buffer.from(bytes).toString('hex') : '';

/**
 * Unwrap an `AnyValue` into the JSON type the dashboard expects. Integers and doubles must land in
 * `jsonb` as JSON numbers: every token, cost and error aggregate guards on
 * `jsonb_typeof(...) = 'number'` and silently reads null for a numeric string.
 */
const attribute_value = (value: OtlpAnyValue | undefined): unknown => {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(attribute_value);
  if (value.kvlistValue) return flatten_attributes(value.kvlistValue.values);
  if (value.bytesValue) return Buffer.from(value.bytesValue).toString('base64');
  return null;
};

function flatten_attributes(entries: readonly OtlpKeyValue[] | undefined): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const entry of entries ?? []) {
    if (entry.key) attributes[entry.key] = attribute_value(entry.value);
  }
  return attributes;
}

/** The payload columns are text; anything the producer did not send as a string is JSON encoded. */
const payload_column = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

// Event times stay decimal strings: a JSON number would round a nanosecond timestamp.
const map_events = (events: readonly OtlpEvent[] | undefined) =>
  (events ?? []).map((event) => ({
    time_unix_nano: event.timeUnixNano ?? '0',
    name: event.name ?? '',
    attributes: flatten_attributes(event.attributes),
  }));

/**
 * Map one OTLP span onto its `otel_spans` row, or return null when the row would be unusable:
 * `end_time_unix_nano` is `NOT NULL`, so an unfinished span has no place in this table, and a span
 * without its own id or a trace id can be neither deduplicated nor grouped into a request.
 */
export const map_span = (span: OtlpSpan): SpanRow | null => {
  const span_id = hex(span.spanId);
  const trace_id = hex(span.traceId);
  const end_time = span.endTimeUnixNano;
  if (!span_id || !trace_id || !end_time || end_time === '0') return null;

  const attributes = flatten_attributes(span.attributes);
  const project_id = attributes[PROJECT_ID_ATTRIBUTE] ?? attributes[PRODUCER_PROJECT_ID_ATTRIBUTE];
  // A span carrying neither key is still stored; it simply belongs to no project.
  if (project_id !== undefined) attributes[PROJECT_ID_ATTRIBUTE] = project_id;

  const parent_span_id = hex(span.parentSpanId);
  const status = span.status ?? {};

  return {
    span_id,
    trace_id,
    parent_span_id:
      parent_span_id && parent_span_id !== ABSENT_PARENT_SPAN_ID ? parent_span_id : null,
    name: span.name ?? '',
    kind: SPAN_KIND_NAMES[span.kind ?? 0] ?? SPAN_KIND_NAMES[0],
    start_time_unix_nano: BigInt(span.startTimeUnixNano ?? '0'),
    end_time_unix_nano: BigInt(end_time),
    status_code: STATUS_CODE_NAMES[status.code ?? 0] ?? STATUS_CODE.UNSET,
    status_message: status.message ?? null,
    attributes,
    events: map_events(span.events),
    input: payload_column(attributes[INPUT_ATTRIBUTE]),
    output: payload_column(attributes[OUTPUT_ATTRIBUTE]),
  };
};

export interface IngestOutcome {
  readonly accepted: number;
  readonly rejected: number;
}

/** Decode an OTLP trace export and store every usable span. */
export async function ingest_trace_export(payload: Uint8Array): Promise<IngestOutcome> {
  let request;
  try {
    request = decode_export_request(payload);
  } catch (error) {
    throw badRequest('telemetry.invalid_payload', 'The OTLP trace export could not be decoded.', {
      cause: error,
      retryable: false,
    });
  }

  const rows: SpanRow[] = [];
  let rejected = 0;
  for (const resource of request.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const row = map_span(span);
        if (row) rows.push(row);
        else rejected += 1;
      }
    }
  }

  await insert_spans(rows);
  telemetryLogger.info('OTLP trace export ingested', { accepted: rows.length, rejected });
  return { accepted: rows.length, rejected };
}
