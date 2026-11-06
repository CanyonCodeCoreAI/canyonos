// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { gunzipSync } from 'node:zlib';

import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs, otelMetricRollups, otelMetrics, otelSpans } from '@api/db/schema';
import { PROJECT_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';
import { RESOURCE_PROJECT_ATTRIBUTE } from '@api/modules/monitoring/monitoring.signals';
import { append_metrics } from '@api/modules/telemetry/telemetry.repo';
import type { LogRow, MetricRow, SpanRow } from '@api/modules/telemetry/telemetry.repo';

import type { SampleWorkflow } from './projects.types';

// Every row this writes carries it, and only rows carrying it are ever removed, so the sample can
// share a project with telemetry the user's own deploy produced.
export const SAMPLE_ATTRIBUTE = 'canyonos.sample';

// One per bundled workflow, recorded from a real run of it by dashboard-data/capture.py. Times are
// stored as nanoseconds before the newest event, never as dates: a first run is spread across the
// week ending whenever it happens, on whatever machine, however long after the recording.
const FIXTURES: Record<SampleWorkflow, URL> = {
  helloworld: new URL('../../db/helloworld.fixture.json.gz', import.meta.url),
  portfolio: new URL('../../db/portfolio.fixture.json.gz', import.meta.url),
};

interface Fixture {
  readonly spans: readonly FixtureSpan[];
  readonly logs: readonly FixtureLog[];
  readonly metrics: readonly FixtureMetric[];
}

interface FixtureSpan {
  readonly span_id: string;
  readonly trace_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly kind: string;
  readonly status_code: string;
  readonly status_message: string | null;
  readonly start_nanos_ago: string;
  readonly end_nanos_ago: string;
  readonly attributes: Record<string, unknown>;
  readonly events: unknown;
  readonly input: string | null;
  readonly output: string | null;
}

interface FixtureLog {
  readonly service_name: string | null;
  readonly resource_attributes: Record<string, unknown>;
  readonly scope_name: string | null;
  readonly nanos_ago: string;
  readonly observed_nanos_ago: string;
  readonly severity_number: number | null;
  readonly severity_text: string | null;
  readonly body: string | null;
  readonly trace_id: string | null;
  readonly span_id: string | null;
  readonly attributes: Record<string, unknown>;
}

interface FixtureMetric {
  readonly service_name: string | null;
  readonly resource_attributes: Record<string, unknown>;
  readonly scope_name: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly metric_type: MetricRow['metric_type'];
  readonly nanos_ago: string;
  readonly value: number;
  readonly data_point_attributes: Record<string, unknown>;
}

export interface SampleDataResult {
  readonly spans: number;
  readonly logs: number;
  readonly metrics: number;
}

/**
 * Add the recorded run of `workflow` to a project the user already has.
 *
 * Their own request sits among a week of earlier ones rather than alone on an empty dashboard.
 * Repeatable: only rows this wrote are replaced, so a second call never touches, duplicates or
 * removes anything the user's deploy produced.
 */
export async function add_sample_data(
  project_id: string,
  workflow: SampleWorkflow
): Promise<SampleDataResult> {
  const recorded = await load_fixture(workflow);
  const now = BigInt(Date.now()) * 1_000_000n;
  const at = (nanos_ago: string): bigint => now - BigInt(nanos_ago);
  // Namespaced, so a replay only ever addresses rows it wrote itself.
  const owned = (suffix: string): string => `sample-${project_id}-${suffix}`;

  const spans: SpanRow[] = recorded.spans.map((span) => ({
    span_id: owned(span.span_id),
    trace_id: owned(span.trace_id),
    parent_span_id: span.parent_span_id === null ? null : owned(span.parent_span_id),
    name: span.name,
    kind: span.kind,
    status_code: span.status_code,
    status_message: span.status_message,
    start_time_unix_nano: at(span.start_nanos_ago),
    end_time_unix_nano: at(span.end_nanos_ago),
    attributes: {
      ...span.attributes,
      [PROJECT_ID_ATTRIBUTE]: project_id,
      // The producer's own key; it still names the project the run was recorded in.
      project_id,
      [SAMPLE_ATTRIBUTE]: true,
    },
    events: (span.events ?? []) as SpanRow['events'],
    input: span.input,
    output: span.output,
  }));

  const resource = (attributes: Record<string, unknown>): Record<string, unknown> => ({
    ...attributes,
    [RESOURCE_PROJECT_ATTRIBUTE]: project_id,
    [SAMPLE_ATTRIBUTE]: true,
  });

  const logs: LogRow[] = recorded.logs.map((log) => ({
    service_name: log.service_name,
    resource_attributes: resource(log.resource_attributes),
    scope_name: log.scope_name,
    time_unix_nano: at(log.nanos_ago),
    observed_time_unix_nano: at(log.observed_nanos_ago),
    severity_number: log.severity_number,
    severity_text: log.severity_text,
    body: log.body,
    trace_id: log.trace_id === null ? null : owned(log.trace_id),
    span_id: log.span_id === null ? null : owned(log.span_id),
    attributes: log.attributes,
  }));

  const metrics: MetricRow[] = recorded.metrics.map((metric) => ({
    service_name: metric.service_name,
    resource_attributes: resource(metric.resource_attributes),
    scope_name: metric.scope_name,
    metric_name: metric.metric_name,
    metric_unit: metric.metric_unit,
    metric_type: metric.metric_type,
    time_unix_nano: at(metric.nanos_ago),
    value: metric.value,
    data_point_attributes: metric.data_point_attributes,
  }));

  await db.transaction(async (tx) => {
    await tx.delete(otelSpans).where(
      sql`${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} = ${project_id}
            and ${otelSpans.attributes} ->> ${SAMPLE_ATTRIBUTE} = 'true'`
    );
    for (const table of [otelLogs, otelMetrics, otelMetricRollups]) {
      await tx.delete(table).where(
        sql`${table.resource_attributes} ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}
              and ${table.resource_attributes} ->> ${SAMPLE_ATTRIBUTE} = 'true'`
      );
    }

    for (let offset = 0; offset < spans.length; offset += CHUNK) {
      await tx.insert(otelSpans).values(spans.slice(offset, offset + CHUNK));
    }
    for (let offset = 0; offset < logs.length; offset += CHUNK) {
      await tx.insert(otelLogs).values(logs.slice(offset, offset + CHUNK));
    }
    // Writes the raw points and their five-minute rollups together; the charts read the rollups,
    // so a loader that wrote only the points would leave every chart empty.
    await append_metrics(tx, metrics);
  });

  return { spans: spans.length, logs: logs.length, metrics: metrics.length };
}

// Postgres binds at most 65535 parameters per statement; a span row binds 13.
const CHUNK = 500;

// Read fresh each call rather than cached: a project asks once, and the inflated fixtures would
// otherwise hold ~32 MB for the API's lifetime.
async function load_fixture(workflow: SampleWorkflow): Promise<Fixture> {
  const file = Bun.file(FIXTURES[workflow].pathname);
  return JSON.parse(gunzipSync(Buffer.from(await file.arrayBuffer())).toString('utf8')) as Fixture;
}
