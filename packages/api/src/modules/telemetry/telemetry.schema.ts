// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { WORKFLOW_GROUP_ID_ATTRIBUTE, WORKFLOW_ID_ATTRIBUTE } from './telemetry.contract';

export const otelSpans = pgTable(
  'otel_spans',
  {
    span_id: text('span_id').primaryKey(),
    trace_id: text('trace_id').notNull(),
    parent_span_id: text('parent_span_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('SPAN_KIND_UNSPECIFIED'),
    start_time_unix_nano: bigint('start_time_unix_nano', { mode: 'bigint' }).notNull(),
    end_time_unix_nano: bigint('end_time_unix_nano', { mode: 'bigint' }).notNull(),
    status_code: text('status_code').notNull().default('STATUS_CODE_UNSET'),
    status_message: text('status_message'),
    attributes: jsonb('attributes').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    input: text('input'),
    output: text('output'),
  },
  (table) => [
    index('idx_otel_spans_start').on(table.start_time_unix_nano),
    index('idx_otel_spans_trace_start').on(table.trace_id, table.start_time_unix_nano),
    index('idx_otel_spans_parent').on(table.parent_span_id),
    index('idx_otel_spans_name_start').on(table.name, table.start_time_unix_nano),
    index('idx_otel_spans_attributes').using('gin', table.attributes),
    index('idx_otel_spans_workflow_start').on(
      sql`(${table.attributes} ->> '${sql.raw(WORKFLOW_ID_ATTRIBUTE)}')`,
      table.start_time_unix_nano
    ),
  ]
);

// A sum's temporality decides how a reader may combine points: `sum_delta` points add up over a
// window, `sum_cumulative` points must be differenced first. Mixing the two silently multiplies
// totals, so the kind is stored per row rather than inferred at query time.
export type MetricType = 'gauge' | 'sum_delta' | 'sum_cumulative';

// Long/tall metric store: one row per OTLP numeric data point, with `metric_type` one of `gauge`,
// `sum_delta` or `sum_cumulative`. A wide snapshot is a query concern -- pivot with
// `max(value) FILTER (WHERE metric_name = ...)` grouped by `time_unix_nano` (machine) or
// `service_name` (agent).
export const otelMetrics = pgTable(
  'otel_metrics',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    service_name: text('service_name'),
    resource_attributes: jsonb('resource_attributes').notNull().default({}),
    scope_name: text('scope_name'),
    metric_name: text('metric_name').notNull(),
    metric_unit: text('metric_unit'),
    metric_type: text('metric_type').$type<MetricType>().notNull(),
    time_unix_nano: bigint('time_unix_nano', { mode: 'bigint' }).notNull(),
    value: doublePrecision('value').notNull(),
    data_point_attributes: jsonb('data_point_attributes').notNull().default({}),
  },
  (table) => [
    index('idx_otel_metrics_name_time').on(table.metric_name, table.time_unix_nano),
    index('idx_otel_metrics_time').on(table.time_unix_nano),
  ]
);

// One row per metric, series and five-minute UTC bucket, upserted on ingest in the same transaction
// as the raw rows, so the bucket open right now is always complete and the two never diverge. A
// series is its service and both attribute maps; `series_key` hashes them because a large attribute
// map would overflow a btree entry, and jsonb text is key-sorted so the hash is stable.
export const otelMetricRollups = pgTable(
  'otel_metric_rollups',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    metric_name: text('metric_name').notNull(),
    metric_type: text('metric_type').$type<MetricType>().notNull(),
    metric_unit: text('metric_unit'),
    service_name: text('service_name'),
    resource_attributes: jsonb('resource_attributes').notNull().default({}),
    data_point_attributes: jsonb('data_point_attributes').notNull().default({}),
    series_key: text('series_key').generatedAlwaysAs(
      sql`md5(coalesce(service_name, '') || resource_attributes::text || data_point_attributes::text)`
    ),
    bucket_start_unix_nano: bigint('bucket_start_unix_nano', { mode: 'bigint' }).notNull(),
    sum: doublePrecision('sum').notNull(),
    count: integer('count').notNull(),
    min: doublePrecision('min').notNull(),
    max: doublePrecision('max').notNull(),
    last_value: doublePrecision('last_value').notNull(),
    last_time_unix_nano: bigint('last_time_unix_nano', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_otel_metric_rollups_series_bucket').on(
      table.metric_name,
      table.series_key,
      table.bucket_start_unix_nano
    ),
    index('idx_otel_metric_rollups_bucket').on(table.bucket_start_unix_nano),
    index('idx_otel_metric_rollups_workflow_group_name_bucket').on(
      sql`(${table.resource_attributes} ->> '${sql.raw(WORKFLOW_GROUP_ID_ATTRIBUTE)}')`,
      table.metric_name,
      table.bucket_start_unix_nano
    ),
  ]
);

// One row per OTLP log record. `trace_id`/`span_id` are the hex ids the producing future carried,
// so a log joins `otel_spans` on span_id; both are null for an agent-level log outside any future.
export const otelLogs = pgTable(
  'otel_logs',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    service_name: text('service_name'),
    resource_attributes: jsonb('resource_attributes').notNull().default({}),
    scope_name: text('scope_name'),
    time_unix_nano: bigint('time_unix_nano', { mode: 'bigint' }).notNull(),
    observed_time_unix_nano: bigint('observed_time_unix_nano', { mode: 'bigint' }).notNull(),
    severity_number: integer('severity_number'),
    severity_text: text('severity_text'),
    body: text('body'),
    trace_id: text('trace_id'),
    span_id: text('span_id'),
    attributes: jsonb('attributes').notNull().default({}),
  },
  (table) => [index('idx_otel_logs_time').on(table.time_unix_nano)]
);
