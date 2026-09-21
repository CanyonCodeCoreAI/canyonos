import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import {
  GEN_AI,
  PROJECT_ID_ATTRIBUTE,
  RUNTIME_ATTRIBUTES,
  STATUS_CODE,
} from '@api/modules/metrics/metrics.contract';

type AttributeValue = number | string | boolean | Record<string, unknown>;

export interface SpanFixture {
  readonly span_id: string;
  readonly trace_id?: string;
  readonly name?: string;
  readonly start_time_unix_nano?: bigint;
  readonly end_time_unix_nano?: bigint;
  readonly failed?: boolean;
  readonly model?: string;
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
    name: span.name ?? span.span_id,
    status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
    start_time_unix_nano: start,
    end_time_unix_nano: span.end_time_unix_nano ?? start + 1_000_000n,
    attributes: { ...attributes, ...Object.fromEntries(attribute_entries(span)) },
    input: span.input ?? null,
    output: span.output ?? null,
  });
}

export async function write_project_span(project_id: string, span: SpanFixture): Promise<void> {
  await insert_span(span, { [PROJECT_ID_ATTRIBUTE]: project_id });
}

export async function write_unattributed_span(span: SpanFixture): Promise<void> {
  await insert_span(span, {});
}
