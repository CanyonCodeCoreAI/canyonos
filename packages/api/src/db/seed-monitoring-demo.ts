import { sql } from 'drizzle-orm';

import { PROJECT_ID_ATTRIBUTE, STATUS_CODE } from '../modules/metrics/metrics.contract';
import { RESOURCE_PROJECT_ATTRIBUTE } from '../modules/monitoring/monitoring.signals';
import { closeDb, db } from './client';
import { otelLogs, otelMetrics, otelSpans, projects } from './schema';

const HOURS = 24;
const SECOND_NANOS = 1_000_000_000n;
const HOUR_NANOS = 3_600n * SECOND_NANOS;

const AGENTS = [
  { name: 'intake', replicas: ['intake-0', 'intake-1'] },
  { name: 'retrieval', replicas: ['retrieval-0', 'retrieval-1'] },
  { name: 'report-writer', replicas: ['report-writer-0'] },
];

const STEPS = ['Intake', 'Retrieval', 'Report Writer'];

const AGENT_CPU_BASE = [22, 11, 58];

const STEP_MODELS = ['claude-haiku-4-5', null, 'claude-opus-5'];

const PROMPTS = [
  'Classify this request and name the tools it needs.',
  'Summarise the retrieved documents for the report writer.',
  'Draft the final report from the supplied findings.',
];

const COMPLETIONS = [
  'Intent: research. Tools: vector_search, report_writer.',
  'Three of the twelve documents are relevant; the rest repeat the same filing.',
  'Report drafted in four sections with citations to the retrieved filings.',
];

const MACHINE_GAUGES = [
  { resource: 'cpu', base: 18, swing: 45, noise: 18 },
  { resource: 'memory', base: 41, swing: 22, noise: 9 },
  { resource: 'disk', base: 63, swing: 4, noise: 3 },
  { resource: 'gpu', base: 12, swing: 55, noise: 14 },
] as const;

const GPU_HOSTS = new Set(['report-writer-0']);

const FAILURES = [
  { type: 'UpstreamError', body: 'upstream model call failed after 3 retries' },
  { type: 'TimeoutError', body: 'tool call exceeded its 30s budget' },
  { type: 'ConnectionResetError', body: 'connection reset while reading from the vector index' },
  { type: 'ValidationError', body: 'tool call returned a malformed payload' },
  { type: null, body: 'could not reach the index, giving up on this request' },
  { type: null, body: 'retry budget exhausted for this step' },
];

const INFO_BODIES = [
  'received request, queued for planning',
  'retrieved 12 documents from the index',
  'model call completed in 1.2s',
  'wrote 2 artifacts to storage',
  'request completed',
];

const FATAL_BODY = 'worker exited: unrecoverable error in the request loop';

function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

async function resolveProjectId(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .orderBy(projects.created_at)
    .limit(1);
  const project = rows[0];
  if (!project) throw new Error('No project exists yet — start the API with SEED_DEV_DATA=true.');
  console.log(`Seeding into project "${project.name}" (${project.id})`);
  return project.id;
}

export async function seedMonitoringDemo(project_id: string): Promise<void> {
  const random = makeRandom(20_260_923);
  const now = BigInt(Date.now()) * 1_000_000n;

  const span_rows: (typeof otelSpans.$inferInsert)[] = [];
  const log_rows: (typeof otelLogs.$inferInsert)[] = [];
  const metric_rows: (typeof otelMetrics.$inferInsert)[] = [];

  for (let hour = 0; hour < HOURS; hour += 1) {
    const hour_start = now - BigInt(HOURS - hour) * HOUR_NANOS;

    const busy = 1 - Math.abs(hour - 15) / 15;
    const trace_count = 2 + Math.round(busy * 10 + random() * 3);

    for (let index = 0; index < trace_count; index += 1) {
      const trace_id = `mondemo-${project_id}-${hour}-${index}`;
      const offset = BigInt(Math.floor(random() * 3_500)) * SECOND_NANOS;
      const trace_start = hour_start + offset;
      const failed = random() < 0.15;
      const failing_step = Math.floor(random() * STEPS.length);
      const step_seconds = failed ? 4 + random() * 9 : 0.6 + random() * 3;

      let cursor = trace_start;
      STEPS.forEach((step, step_index) => {
        const duration = BigInt(Math.round(step_seconds * 1000)) * 1_000_000n;
        const agent = AGENTS[step_index]!;
        const replica = agent.replicas[index % agent.replicas.length]!;
        const span_failed = failed && step_index === failing_step;
        const model = STEP_MODELS[step_index];
        const input_tokens = 800 + Math.round(random() * 5_200);
        const output_tokens = 120 + Math.round(random() * 900);
        const cached_tokens = Math.round(input_tokens * random() * 0.6);
        const cost = (input_tokens * 3 + output_tokens * 15) / 1_000_000;

        span_rows.push({
          span_id: `${trace_id}-${step_index}`,
          trace_id,
          parent_span_id: step_index === 0 ? null : `${trace_id}-0`,
          name: step,
          status_code: span_failed ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
          start_time_unix_nano: cursor,
          end_time_unix_nano: cursor + duration,
          input: model ? PROMPTS[step_index]! : null,
          output: model && !span_failed ? COMPLETIONS[step_index]! : null,
          attributes: {
            [PROJECT_ID_ATTRIBUTE]: project_id,
            'gen_ai.agent.id': replica,
            cpu: Math.min(99, AGENT_CPU_BASE[step_index]! + random() * 20),
            ...(model
              ? {
                  'gen_ai.request.model': model,
                  'gen_ai.response.model': `${model}-20260101`,
                  'gen_ai.usage.input_tokens': input_tokens,
                  'gen_ai.usage.output_tokens': output_tokens,
                  'gen_ai.usage.cache_read.input_tokens': cached_tokens,
                  'gen_ai.usage.cost': cost,
                  token_cost: cost,
                }
              : {}),
          },
        });

        const log_at = cursor + duration / 2n;
        const failure = FAILURES[Math.floor(random() * FAILURES.length)]!;
        const body = span_failed
          ? failure.body
          : INFO_BODIES[Math.floor(random() * INFO_BODIES.length)]!;

        log_rows.push({
          service_name: replica,
          resource_attributes: { [RESOURCE_PROJECT_ATTRIBUTE]: project_id },
          time_unix_nano: log_at,
          observed_time_unix_nano: log_at,
          severity_number: span_failed ? 17 : 9,
          severity_text: span_failed ? 'ERROR' : 'INFO',
          body: `[${step}] ${body}`,
          trace_id,
          span_id: `${trace_id}-${step_index}`,
          attributes: {
            'canyonos.agent.name': agent.name,
            'canyonos.agent.id': replica,
            'logger.name': `canyonos.${agent.name}`,
            ...(span_failed && failure.type !== null
              ? {
                  'exception.type': failure.type,
                  'exception.message': failure.body,
                  'exception.stacktrace': `Traceback (most recent call last):\n  File "agent.py", line 214, in run\n    result = await self.call_model(prompt)\n${failure.type}: ${failure.body}`,
                }
              : {}),
          },
        });

        cursor += duration;
      });
    }

    for (const agent of AGENTS) {
      for (const replica of agent.replicas) {
        for (let quarter = 0; quarter < 4; quarter += 1) {
          const at = hour_start + BigInt(quarter * 900) * SECOND_NANOS;
          for (const gauge of MACHINE_GAUGES) {
            if (gauge.resource === 'gpu' && !GPU_HOSTS.has(replica)) continue;
            metric_rows.push({
              metric_name: `canyonos.machine.${gauge.resource}.utilization`,
              metric_type: 'gauge',
              metric_unit: '%',
              service_name: replica,
              resource_attributes: {
                [RESOURCE_PROJECT_ATTRIBUTE]: project_id,
                'host.name': replica,
              },
              time_unix_nano: at,
              value: Math.min(97, gauge.base + busy * gauge.swing + random() * gauge.noise),
              data_point_attributes: {},
            });
          }
        }
      }
    }
  }

  const crash_at = now - 2n * HOUR_NANOS;
  log_rows.push({
    service_name: 'report-writer-0',
    resource_attributes: { [RESOURCE_PROJECT_ATTRIBUTE]: project_id },
    time_unix_nano: crash_at,
    observed_time_unix_nano: crash_at,
    severity_number: 21,
    severity_text: 'FATAL',
    body: FATAL_BODY,
    trace_id: null,
    span_id: null,
    attributes: {
      'canyonos.agent.name': 'report-writer',
      'canyonos.agent.id': 'report-writer-0',
      'exception.type': 'SystemExit',
      'exception.message': FATAL_BODY,
    },
  });

  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from otel_spans where trace_id like ${`mondemo-${project_id}-%`}`);
    await tx.execute(
      sql`delete from otel_logs where resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`
    );
    await tx.execute(
      sql`delete from otel_metrics where resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`
    );
    await tx.insert(otelSpans).values(span_rows);
    await tx.insert(otelLogs).values(log_rows);
    await tx.insert(otelMetrics).values(metric_rows);
  });

  console.log(
    `Seeded ${span_rows.length} spans, ${log_rows.length} logs, ${metric_rows.length} CPU samples.`
  );
}

if (import.meta.main) {
  const project_id = await resolveProjectId(process.argv[2]);
  await seedMonitoringDemo(project_id);
  await closeDb();
}
