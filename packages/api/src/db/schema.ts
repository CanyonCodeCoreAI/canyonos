import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import type { WorkflowDesignPayload } from '../modules/workflows/workflows.types';

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

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  companyId: uuid('company_id').references(() => companies.id),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'),
  activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'string' }),
  lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
  lockedReason: text('locked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    destination: text('destination').notNull(),
    purpose: varchar('purpose', { length: 64 }).notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_auth_challenges_user').on(table.userId)]
);

// snake_case column keys so `$inferSelect` matches the snake_case API payload directly — the repos
// select the exact shape without a rename mapper. Owned by a company; `created_by` is audit only.
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    company_id: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_projects_company').on(table.company_id)]
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

// Generic file store owned by a company. `project_id` is nullable so non-project files fit later;
// `created_by` is audit only. Bytes are addressed through `content_hash`.
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    company_id: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
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
    index('idx_files_company').on(table.company_id),
    index('idx_files_project').on(table.project_id),
    index('idx_files_project_component_path').on(
      table.project_id,
      table.component_kind,
      table.path
    ),
    index('idx_files_content_hash').on(table.content_hash),
    uniqueIndex('uq_files_project_path').on(table.project_id, table.path),
    // A constraint, not an index: project_workflows' composite foreign key needs this to exist
    // before its own ALTER TABLE runs, and only a table constraint is created that early.
    unique('uq_files_project_id_id').on(table.project_id, table.id),
  ]
);

export const projectWorkflows = pgTable(
  'project_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source_file_id: uuid('source_file_id').notNull(),
    generation_status: varchar('generation_status', { length: 32 }).notNull().default('PENDING'),
    generation_revision: bigint('generation_revision', { mode: 'number' }).notNull().default(0),
    design: jsonb('design').$type<WorkflowDesignPayload>(),
    error_message: text('error_message'),
    model: varchar('model', { length: 64 }),
    stale_at: timestamp('stale_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_workflows_project').on(table.project_id),
    uniqueIndex('uq_project_workflows_source_file').on(table.source_file_id),
    foreignKey({
      columns: [table.project_id, table.source_file_id],
      foreignColumns: [files.project_id, files.id],
      name: 'project_workflows_project_source_files_fk',
    }).onDelete('cascade'),
    check(
      'project_workflows_generation_status_check',
      sql`${table.generation_status} in ('PENDING', 'GENERATING', 'READY', 'FAILED')`
    ),
    check(
      'project_workflows_ready_design_check',
      sql`${table.generation_status} <> 'READY' or ${table.design} is not null`
    ),
  ]
);

export const deploySetups = pgTable('deploy_setups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  provider: text('provider').notNull().default('AWS'),
  company_id: uuid('company_id')
    .notNull()
    .references(() => companies.id),
  created_by: uuid('created_by')
    .notNull()
    .references(() => users.id),
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
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    company_id: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deploy_setup_id: uuid('deploy_setup_id')
      .notNull()
      .references(() => deploySetups.id),
    status: deployment_status('status').notNull().default('pending'),
    address: text('address'),
    error: text('error'),
    // Teardown targets. Not `address` — that is the workflow replica's IP, a different host.
    // Worker-only; absent from the public schemas on purpose.
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
    index('idx_deployments_project').on(table.project_id),
    // At most one active deployment per project. 'stopping' and 'stopped' stay out so a teardown
    // releases the slot; deploy.repo.ts is what rejects a deploy requested mid-teardown.
    uniqueIndex('uq_deployments_active_per_project')
      .on(table.project_id)
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
// its exact file set stays retrievable after the live project files change. `component_kind` is
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
    index('idx_otel_spans_project_start').on(
      sql`(${table.attributes} ->> 'canyon.project.id')`,
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
  (table) => [index('idx_otel_metrics_name_time').on(table.metric_name, table.time_unix_nano)]
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
