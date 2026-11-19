// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const file_component_kind = pgEnum('file_component_kind', [
  'workflow',
  'agent',
  'tool',
  'other',
]);

// Order mirrors the systems worker's own call-site sequence, so a status comparison also orders the
// lifecycle. Never reorder or insert values without a systems-team ack — the worker relies on it.
export const deployment_status = pgEnum('deployment_status', [
  'pending',
  'receiving_files',
  'processing_files',
  'provisioning_resources',
  'launching_resources',
  'success',
  'failed',
  'stopping',
  'stopped',
  'stop_failed',
]);

// snake_case column keys so `$inferSelect` matches the snake_case API payload directly — the repos
// select the exact shape without a rename mapper.
export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Temporary: applied now so multi-workflow dashboards work without blocking the flow; revisit
  // with the workflow-key design in CAN-521 (the api should not hold per-workflow Redis addresses).
  redis_host: text('redis_host'),
  redis_port: integer('redis_port'),
  redis_password: text('redis_password'),
  // The client certificate a Docker workflow group's Redis takes, as sealed JSON.
  redis_tls: text('redis_tls'),
  // The workflow shares this workflow group's machines and Redis.
  workflow_group_id: uuid('workflow_group_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// One row per stored version of an agent function's system prompt. The first versions come from
// the workflow's prompts.yaml; dashboard saves add the rest. `live` marks the version agents are sent.
export const systemPrompts = pgTable(
  'system_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    // `<Agent>.<function>`: the function whose LLM calls get this prompt.
    name: text('name').notNull(),
    // `<Agent>-<function>-<content hash>-v<n>`. Kept as the one string instead of normalized
    // columns because it is the identifier the gateway records on every LLM call's span.
    version: text('version').notNull(),
    content: text('content').notNull(),
    live: boolean('live').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_system_prompts_workflow_name').on(table.workflow_id, table.name),
    uniqueIndex('uq_system_prompts_workflow_name_version').on(
      table.workflow_id,
      table.name,
      table.version
    ),
  ]
);

// Content-addressed blob registry: `content_hash` is the sha256 of the bytes, which live in the
// storage provider, not here. One row per distinct content; files reference it.
export const fileBlobs = pgTable('file_blobs', {
  content_hash: text('content_hash').primaryKey(),
  byte_size: integer('byte_size').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// Generic file store. `workflow_id` is nullable so non-workflow files fit later. Bytes are addressed
// through `content_hash`.
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflow_id: uuid('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    content_hash: text('content_hash')
      .notNull()
      .references(() => fileBlobs.content_hash),
    language: text('language').notNull(),
    byte_size: integer('byte_size').notNull(),
    component_kind: file_component_kind('component_kind').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_files_workflow').on(table.workflow_id),
    index('idx_files_workflow_component_path').on(
      table.workflow_id,
      table.component_kind,
      table.path
    ),
    index('idx_files_content_hash').on(table.content_hash),
    uniqueIndex('uq_files_workflow_path').on(table.workflow_id, table.path),
  ]
);

export const deploySetups = pgTable('deploy_setups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  provider: text('provider').notNull().default('AWS'),
  region: text('region').notNull(),
  ami_id: text('ami_id').notNull(),
  instance_type: text('instance_type').notNull(),
  subnet_id: text('subnet_id').notNull(),
  security_group_ids: text('security_group_ids').notNull(),
  ssh_user: text('ssh_user').notNull(),
  ssh_private_key_path: text('ssh_private_key_path').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// The row IS the deploy job: the API inserts it (status 'pending'); the worker claims it and is the
// only writer of status/address/heartbeat.
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id),
    deploy_setup_id: uuid('deploy_setup_id')
      .notNull()
      .references(() => deploySetups.id),
    status: deployment_status('status').notNull().default('pending'),
    address: text('address'),
    error: text('error'),
    // Teardown targets. Worker-only; absent from the public schemas on purpose.
    controller_instance_id: text('controller_instance_id'),
    controller_ip: text('controller_ip'),
    // Teardown's claim marker — `claimed_at` belongs to the deploy this row succeeded at.
    stop_claimed_at: timestamp('stop_claimed_at', { withTimezone: true, mode: 'string' }),
    // Why the last teardown did not finish. Lives on a `success` or `stopped` row so the warning
    // survives a reload — the instances it names may still be running.
    stop_error: text('stop_error'),
    claimed_at: timestamp('claimed_at', { withTimezone: true, mode: 'string' }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
    attempts: integer('attempts').notNull().default(0),
    worker_version: text('worker_version'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_deployments_workflow').on(table.workflow_id),
    // At most one active deployment per workflow. 'stopping' and 'stopped' stay out so a teardown
    // releases the slot; deploy.repo.ts is what rejects a deploy requested mid-teardown.
    uniqueIndex('uq_deployments_active_per_workflow')
      .on(table.workflow_id)
      .where(
        sql`${table.status} in ('pending', 'receiving_files', 'processing_files', 'provisioning_resources', 'launching_resources')`
      ),
    index('idx_deployments_pending')
      .on(table.created_at)
      .where(sql`${table.status} = 'pending'`),
    index('idx_deployments_status_updated').on(table.status, table.updated_at),
  ]
);

// Append-only transition log. `seq` is per-deployment and monotonic; the UNIQUE(deployment_id, seq)
// is the concurrency guard behind the coalesce(max)+1 next-seq computation and powers Last-Event-ID.
export const deploymentEvents = pgTable(
  'deployment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deployment_id: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    status: deployment_status('status').notNull(),
    detail: text('detail'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('uq_deployment_events_seq').on(table.deployment_id, table.seq)]
);

// The immutable per-deploy file manifest: which `(path -> content_hash)` a deployment shipped, so
// its exact file set stays retrievable after the live workflow files change. `component_kind` is
// snapshotted because the runtime needs it and the source may change after the deploy.
export const deploymentFiles = pgTable(
  'deployment_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deployment_id: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content_hash: text('content_hash')
      .notNull()
      .references(() => fileBlobs.content_hash),
    byte_size: integer('byte_size').notNull(),
    component_kind: file_component_kind('component_kind').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_deployment_files_path').on(table.deployment_id, table.path),
    index('idx_deployment_files_content_hash').on(table.content_hash),
  ]
);

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
      sql`(${table.attributes} ->> 'canyonos.workflow.id')`,
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
      sql`(${table.resource_attributes} ->> 'canyonos.workflow_group.id')`,
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
