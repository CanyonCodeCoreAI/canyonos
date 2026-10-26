// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { TIME_RANGE_FIELDS, timeRangeQuery } from '@core/time-range';

export const DistributionMetricSchema = z.enum([
  'tokens_per_request',
  'cost_per_request',
  'latency',
]);

// `recoverable_cost` is a slice of `total_cost`, never additive to it. `llm_cost`/`harness_cost` are
// the producer's reported components and `total_cost` its reported total, never derived from them.
// A block with no reported cost is not a free block, so every cost average divides by the costed
// count rather than the block count.
export const MetricsKpiSchema = z.object({
  request_count: z.number().int().nonnegative(),
  block_count: z.number().int().nonnegative(),
  failed_block_count: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  per_block_tokens: z.number().nonnegative().nullable(),
  harness_cost: z.string(),
  llm_cost: z.string(),
  total_cost: z.string(),
  recoverable_cost: z.string(),
  per_block_cost: z.string().nullable(),
  per_block_latency_ms: z.number().nonnegative().nullable(),
  costed_block_count: z.number().int().nonnegative(),
  costed_request_count: z.number().int().nonnegative(),
  per_costed_request_cost: z.string().nullable(),
});

export const RunRatePerSchema = z.enum(['hour', 'day']);

// `run_rate` is `total_cost` over the range's own length, per hour for a range of a day or less and
// per day beyond. Null when blocks ran and none reported a cost.
export const MetricsKpisSchema = MetricsKpiSchema.extend({
  project_id: z.string().uuid(),
  run_rate: z.string().nullable(),
  run_rate_per: RunRatePerSchema,
  generated_at: z.string(),
  ...TIME_RANGE_FIELDS,
});

export const DistributionBucketSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  count: z.number().int().nonnegative(),
});

// Aggregation runs exactly in Postgres; only the final statistic casts to float8. `std` is the
// sample standard deviation, null for fewer than two requests.
export const DistributionStatsSchema = z.object({
  request_count: z.number().int().nonnegative(),
  mean: z.number().nullable(),
  std: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  p99: z.number().nullable(),
  buckets: z.array(DistributionBucketSchema),
});

export const MetricsDistributionSchema = DistributionStatsSchema.extend({
  project_id: z.string().uuid(),
  metric: DistributionMetricSchema,
  ...TIME_RANGE_FIELDS,
});

export const DistributionQuerySchema = timeRangeQuery({
  metric: DistributionMetricSchema,
  buckets: z.coerce.number().int().min(1).max(100).default(20),
});

// One time bucket, the first and last possibly partial. Every bucket in the range is emitted, empty
// ones included, so a chart never has to invent the gaps. A request counts whole in the bucket it
// started in.
export const TimeseriesPointSchema = z.object({
  start_at: z.string(),
  llm_cost: z.string(),
  harness_cost: z.string(),
  total_cost: z.string(),
  request_count: z.number().int().nonnegative(),
  block_count: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

export const MetricsTimeseriesSchema = z.object({
  project_id: z.string().uuid(),
  ...TIME_RANGE_FIELDS,
  bucket_seconds: z.number().positive(),
  points: z.array(TimeseriesPointSchema),
});

export const BlockKindSchema = z.enum(['model', 'harness']);

// Rates are 0–1 fractions of the group's blocks. `label` is the display name; `agent_id` addresses
// the group.
export const MetricsBlockSchema = z.object({
  agent_id: z.string(),
  model: z.string().nullable(),
  label: z.string(),
  kind: BlockKindSchema,
  cost: z.string(),
  llm_cost: z.string(),
  harness_cost: z.string(),
  recoverable_cost: z.string(),
  block_count: z.number().int().nonnegative(),
  token_count: z.number().int().nonnegative(),
  retry_rate: z.number().min(0).max(1).nullable(),
  failed_rate: z.number().min(0).max(1).nullable(),
  p95_latency_ms: z.number().nonnegative().nullable(),
  cache_hit_ratio: z.number().min(0).max(1).nullable(),
});

export const MetricsBlocksSchema = z.object({
  project_id: z.string().uuid(),
  ...TIME_RANGE_FIELDS,
  total_cost: z.string(),
  blocks: z.array(MetricsBlockSchema),
});

// Every figure covers the whole agent: all of its models and all replicas sharing its name.
export const MetricsAgentSummarySchema = MetricsBlockSchema.omit({
  agent_id: true,
  model: true,
  label: true,
  kind: true,
}).extend({
  request_count: z.number().int().nonnegative(),
  replica_count: z.number().int().nonnegative(),
});

export const MetricsAgentTimeseriesSchema = z.object({
  bucket_seconds: z.number().positive(),
  points: z.array(TimeseriesPointSchema),
});

export const MetricsAgentDetailsSchema = z.object({
  project_id: z.string().uuid(),
  agent_id: z.string(),
  label: z.string(),
  ...TIME_RANGE_FIELDS,
  project: z.object({
    request_count: z.number().int().nonnegative(),
    total_cost: z.string(),
  }),
  agent: MetricsAgentSummarySchema,
  timeseries: MetricsAgentTimeseriesSchema,
  tokens_per_request: DistributionStatsSchema,
  cost_per_request: DistributionStatsSchema,
  latency: DistributionStatsSchema,
});

export type DistributionMetric = z.infer<typeof DistributionMetricSchema>;
export type MetricsKpi = z.infer<typeof MetricsKpiSchema>;
export type MetricsKpis = z.infer<typeof MetricsKpisSchema>;
export type RunRatePer = z.infer<typeof RunRatePerSchema>;
export type DistributionBucket = z.infer<typeof DistributionBucketSchema>;
export type DistributionStats = z.infer<typeof DistributionStatsSchema>;
export type MetricsDistribution = z.infer<typeof MetricsDistributionSchema>;
export type DistributionQuery = z.infer<typeof DistributionQuerySchema>;
export type TimeseriesPoint = z.infer<typeof TimeseriesPointSchema>;
export type MetricsTimeseries = z.infer<typeof MetricsTimeseriesSchema>;
export type BlockKind = z.infer<typeof BlockKindSchema>;
export type MetricsBlock = z.infer<typeof MetricsBlockSchema>;
export type MetricsBlocks = z.infer<typeof MetricsBlocksSchema>;
export type MetricsAgentSummary = z.infer<typeof MetricsAgentSummarySchema>;
export type MetricsAgentTimeseries = z.infer<typeof MetricsAgentTimeseriesSchema>;
export type MetricsAgentDetails = z.infer<typeof MetricsAgentDetailsSchema>;
