import { PROJECT_ID_ATTRIBUTE, STATUS_CODE } from '@api/modules/metrics/metrics.contract';
import { badRequest } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import {
  decode_export_request,
  decode_logs_export_request,
  decode_metrics_export_request,
} from './otlp.decode';
import { insert_logs, insert_metrics, insert_spans } from './telemetry.repo';
import type {
  OtlpAnyValue,
  OtlpEvent,
  OtlpKeyValue,
  OtlpLogRecord,
  OtlpMetric,
  OtlpNumberDataPoint,
  OtlpSpan,
} from './otlp.decode';
import type { LogRow, MetricRow, SpanRow } from './telemetry.repo';

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

const SERVICE_NAME_ATTRIBUTE = 'service.name';

interface ResourceContext {
  readonly service_name: string | null;
  readonly resource_attributes: Record<string, unknown>;
}

// Resource attributes are shared by every scope under a resource, so a scope only adds its name.
interface ScopeContext extends ResourceContext {
  readonly scope_name: string | null;
}

const resource_context = (entries: readonly OtlpKeyValue[] | undefined): ResourceContext => {
  const resource_attributes = flatten_attributes(entries);
  const service_name = resource_attributes[SERVICE_NAME_ATTRIBUTE];
  return {
    service_name: typeof service_name === 'string' ? service_name : null,
    resource_attributes,
  };
};

const scope_context = (context: ResourceContext, name: string | undefined): ScopeContext => ({
  ...context,
  scope_name: name ?? null,
});

// A data point sets exactly one of `asDouble`/`asInt`; anything else is a point we cannot store.
const number_point_value = (point: OtlpNumberDataPoint): number | null => {
  if (point.asDouble !== undefined) return point.asDouble;
  if (point.asInt !== undefined) return Number(point.asInt);
  return null;
};

type MetricType = MetricRow['metric_type'];

// `AggregationTemporality` wire values; 0 (unspecified) is absent under `defaults: false`.
const SUM_DELTA = 1;
const SUM_CUMULATIVE = 2;

/**
 * The stored type for a metric, or null when it carries nothing this table can hold: a histogram,
 * summary or exponential histogram has no scalar points, and a sum with an unspecified temporality
 * cannot be read back safely -- delta points add up over a window while cumulative points must be
 * differenced first, and guessing wrong multiplies every total built on it.
 */
const metric_type_of = (metric: OtlpMetric): MetricType | null => {
  if (metric.gauge) return 'gauge';
  if (metric.sum?.aggregationTemporality === SUM_DELTA) return 'sum_delta';
  if (metric.sum?.aggregationTemporality === SUM_CUMULATIVE) return 'sum_cumulative';
  return null;
};

/**
 * Decode an OTLP metric export and store every usable gauge/sum data point as one long-form row.
 * Anything this table cannot hold is skipped and counted, not rejected: reporting it back would
 * make every exporter warn on every push about data we chose not to keep.
 */
export async function ingest_metric_export(
  payload: Uint8Array
): Promise<{ accepted: number; skipped: number }> {
  let request;
  try {
    request = decode_metrics_export_request(payload);
  } catch (error) {
    throw badRequest('telemetry.invalid_payload', 'The OTLP metric export could not be decoded.', {
      cause: error,
      retryable: false,
    });
  }

  const rows: MetricRow[] = [];
  let skipped = 0;
  for (const resource of request.resourceMetrics ?? []) {
    const context = resource_context(resource.resource?.attributes);
    for (const scope of resource.scopeMetrics ?? []) {
      const scoped = scope_context(context, scope.scope?.name);
      for (const metric of scope.metrics ?? []) {
        const metric_type = metric_type_of(metric);
        const metric_name = metric.name;
        // A nameless series can never be queried back, so it is dropped rather than stored under
        // an empty name where it would merge with every other nameless series.
        if (!metric_type || !metric_name) {
          skipped += 1;
          continue;
        }
        for (const point of (metric.gauge ?? metric.sum)?.dataPoints ?? []) {
          const value = number_point_value(point);
          const time = point.timeUnixNano;
          // A point with no timestamp would land at the epoch and corrupt every time window it
          // falls into.
          if (value === null || !time || time === '0') {
            skipped += 1;
            continue;
          }
          rows.push({
            service_name: scoped.service_name,
            resource_attributes: scoped.resource_attributes,
            scope_name: scoped.scope_name,
            metric_name,
            metric_unit: metric.unit ?? null,
            metric_type,
            time_unix_nano: BigInt(time),
            value,
            data_point_attributes: flatten_attributes(point.attributes),
          });
        }
      }
    }
  }

  await insert_metrics(rows);
  telemetryLogger.info('OTLP metric export ingested', { accepted: rows.length, skipped });
  return { accepted: rows.length, skipped };
}

/**
 * The body is an `AnyValue`, so a structured body arrives as a map or array rather than a string.
 * It is stored as text either way: a JSON encoding keeps the record readable without a second
 * column, and the original attributes are preserved separately.
 */
const log_body_text = (body: OtlpAnyValue | undefined): string | null => {
  const value = attribute_value(body);
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/**
 * Map one OTLP log record onto its `otel_logs` row. Nothing is rejected on content: a record with
 * no body, no severity or no trace context is still a real observation, and the columns are
 * nullable to match. `observed_time_unix_nano` falls back to the record time, which is what a
 * producer that sets only one of them means.
 */
export const map_log_record = (record: OtlpLogRecord, context: ScopeContext): LogRow => {
  const time = record.timeUnixNano ?? record.observedTimeUnixNano ?? '0';
  const trace_id = hex(record.traceId);
  const span_id = hex(record.spanId);

  return {
    service_name: context.service_name,
    resource_attributes: context.resource_attributes,
    scope_name: context.scope_name,
    time_unix_nano: BigInt(time),
    observed_time_unix_nano: BigInt(record.observedTimeUnixNano ?? time),
    severity_number: record.severityNumber ?? null,
    severity_text: record.severityText ?? null,
    body: log_body_text(record.body),
    trace_id: trace_id || null,
    span_id: span_id || null,
    attributes: flatten_attributes(record.attributes),
  };
};

/** Decode an OTLP logs export and store every record. */
export async function ingest_logs_export(payload: Uint8Array): Promise<{ accepted: number }> {
  let request;
  try {
    request = decode_logs_export_request(payload);
  } catch (error) {
    throw badRequest('telemetry.invalid_payload', 'The OTLP logs export could not be decoded.', {
      cause: error,
      retryable: false,
    });
  }

  const rows: LogRow[] = [];
  for (const resource of request.resourceLogs ?? []) {
    const context = resource_context(resource.resource?.attributes);
    for (const scope of resource.scopeLogs ?? []) {
      const scoped = scope_context(context, scope.scope?.name);
      for (const record of scope.logRecords ?? []) rows.push(map_log_record(record, scoped));
    }
  }

  await insert_logs(rows);
  telemetryLogger.info('OTLP logs export ingested', { accepted: rows.length });
  return { accepted: rows.length };
}
