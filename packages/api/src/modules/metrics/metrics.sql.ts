import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { otelSpans } from '@api/db/schema';

import { GEN_AI, PROJECT_ID_ATTRIBUTE, RUNTIME_ATTRIBUTES, STATUS_CODE } from './metrics.contract';

const attrText = (alias: string, key: string): string => `(${alias}.attributes ->> '${key}')`;

// Only genuine JSON numbers are read; anything else reads as null instead of failing the aggregate.
const attrNumber = (alias: string, key: string): string =>
  `(case when jsonb_typeof(${alias}.attributes -> '${key}') = 'number'
      then (${alias}.attributes ->> '${key}')::numeric end)`;

export const spanFailed = (alias: string): string =>
  `(${alias}.status_code = '${STATUS_CODE.ERROR}')`;

export const spanProjectId = (alias: string): string => attrText(alias, PROJECT_ID_ATTRIBUTE);

export const spanStart = (alias: string): string =>
  `to_timestamp(${alias}.start_time_unix_nano / 1e9)`;

export const spanDurationMs = (alias: string): string =>
  `((${alias}.end_time_unix_nano - ${alias}.start_time_unix_nano) / 1e6)`;

export const isModelSpan = (alias: string): string =>
  `(${alias}.attributes ? '${GEN_AI.REQUEST_MODEL}')`;

// An identifier, never arithmetic, and absent on spans written before the receiver emitted it.
export const spanAgentId = (alias: string): string => attrText(alias, GEN_AI.AGENT_ID);

export const spanModel = (alias: string): string =>
  `coalesce(${attrText(alias, GEN_AI.RESPONSE_MODEL)}, ${attrText(alias, GEN_AI.REQUEST_MODEL)})`;

// A count is a nonnegative whole JSON number. The casts sit inside the type branch so a string or
// object never reaches ::numeric, whatever order the planner picks.
const attrCount = (alias: string, key: string): string => {
  const value = `(${alias}.attributes ->> '${key}')::numeric`;
  return `(case when jsonb_typeof(${alias}.attributes -> '${key}') = 'number'
      then (case when ${value} >= 0 and ${value} = floor(${value}) then ${value} end)
    end)`;
};

export const spanInputTokens = (alias: string): string => attrCount(alias, GEN_AI.INPUT_TOKENS);

export const spanOutputTokens = (alias: string): string => attrCount(alias, GEN_AI.OUTPUT_TOKENS);

// Null when neither side was reported, so a span with no usage data is absent from token sums
// rather than counted as a zero.
export const spanTotalTokens = (alias: string): string =>
  `(case when ${spanInputTokens(alias)} is null and ${spanOutputTokens(alias)} is null then null
      else coalesce(${spanInputTokens(alias)}, 0) + coalesce(${spanOutputTokens(alias)}, 0) end)`;

const spanCacheReadTokens = (alias: string): string =>
  attrCount(alias, GEN_AI.CACHE_READ_INPUT_TOKENS);

// Cache reads sit outside `input_tokens` in the conventions, so the denominator is the whole prompt.
export const spanCacheHitRatio = (alias: string): string => {
  const cached = spanCacheReadTokens(alias);
  const input = spanInputTokens(alias);
  return `(case when ${cached} is null then null
      when coalesce(${cached}, 0) + coalesce(${input}, 0) > 0
      then coalesce(${cached}, 0)::float8 / (coalesce(${cached}, 0) + coalesce(${input}, 0))
    end)`;
};

export const spanCost = (alias: string): string => attrNumber(alias, GEN_AI.USAGE_COST);

export const spanTokenCost = (alias: string): string =>
  attrNumber(alias, RUNTIME_ATTRIBUTES.TOKEN_COST);

export const spanServerCost = (alias: string): string =>
  attrNumber(alias, RUNTIME_ATTRIBUTES.SERVER_COST);

export const spanErrorCount = (alias: string): string =>
  attrCount(alias, RUNTIME_ATTRIBUTES.ERROR_COUNT);

// The receiver does not promise JSON in these columns: an agent's answer is often prose. An empty
// payload reads as absent so a span that recorded nothing is never rendered as an empty envelope.
export const spanInput = (alias: string): string => `nullif(btrim(${alias}.input::text), '')`;

export const spanOutput = (alias: string): string => `nullif(btrim(${alias}.output::text), '')`;

export const projectSpans = (project_id: string, floor_nanos: string): SQL => sql`
  select s.*
  from ${otelSpans} s
  where ${sql.raw(spanProjectId('s'))} = ${project_id}
    and s.start_time_unix_nano >= ${sql.raw(floor_nanos)}`;
