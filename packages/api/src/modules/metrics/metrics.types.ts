import { z } from 'zod';

// `1q` is the trailing quarter (90 days); the other windows are trailing 1/7/30 days. All four
// come back in one response so the UI range selector never refetches.
export const MetricsWindowSchema = z.enum(['1d', '7d', '30d', '1q']);

export const DistributionMetricSchema = z.enum([
  'tokens_per_request',
  'cost_per_request',
  'latency',
]);

// `recoverable_cost` is a slice of `total_cost`, never additive to it. `llm_cost`/`harness_cost` are
// the producer's reported components and `total_cost` its reported total, never derived from them.
// A block with no reported cost is not a free block, so every cost average divides by the costed
// count rather than the block count.
export const KpiWindowSchema = z.object({
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

export const MetricsKpisSchema = z.object({
  project_id: z.string().uuid(),
  generated_at: z.string(),
  windows: z.object({
    '1d': KpiWindowSchema,
    '7d': KpiWindowSchema,
    '30d': KpiWindowSchema,
    '1q': KpiWindowSchema,
  }),
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
  time_window: MetricsWindowSchema,
});

export const DistributionQuerySchema = z.object({
  metric: DistributionMetricSchema,
  time_window: MetricsWindowSchema.default('30d'),
  buckets: z.coerce.number().int().min(1).max(100).default(20),
});

// One equal-width time bucket. Every bucket in the window is emitted, empty ones included, so a
// chart never has to invent the gaps.
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
  time_window: MetricsWindowSchema,
  bucket_seconds: z.number().positive(),
  points: z.array(TimeseriesPointSchema),
});

// `buckets` is optional rather than defaulted because the default depends on the window (a day
// reads as 24 hourly points, the longer windows as 30); the service resolves it.
const TimeZoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (time_zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: time_zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid IANA time zone' }
  );

export const TimeseriesQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('30d'),
  buckets: z.coerce.number().int().min(1).max(120).optional(),
  time_zone: TimeZoneSchema.optional(),
});

// The agent drawer is fixed at 30 days, so it takes no window — only the zone its day boundaries
// are drawn on, exactly as the project timeseries does.
export const AgentDetailsQuerySchema = z.object({
  time_zone: TimeZoneSchema.optional(),
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
  time_window: MetricsWindowSchema,
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

// One point per calendar day of the 30, zero-filled, in the same shape the project timeseries
// serves so one chart draws both.
export const MetricsAgentTimeseriesSchema = z.object({
  bucket_seconds: z.number().positive(),
  points: z.array(TimeseriesPointSchema),
});

export const MetricsAgentDetailsSchema = z.object({
  project_id: z.string().uuid(),
  agent_id: z.string(),
  label: z.string(),
  time_window: z.literal('30d'),
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

// Every surface that reads one trailing window and nothing else takes this query.
export const TimeWindowQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('30d'),
});

export const FlowNodeKindSchema = z.enum(['entry', 'agent']);

// Real nodes group by resolved address, so a node is coarser than a block row. `entry` is
// synthetic: the only node with a null `agent_id` and the only one at depth 0.
export const MetricsFlowNodeSchema = MetricsBlockSchema.omit({
  kind: true,
  model: true,
}).extend({
  id: z.string(),
  kind: FlowNodeKindSchema,
  agent_id: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  replica_count: z.number().int().nonnegative(),
  request_count: z.number().int().nonnegative(),
});

// `cost` is the target side's spend, so an edge is a slice of the node totals rather than a second
// dollar. Transitions inside one agent never ship.
export const MetricsFlowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  call_count: z.number().int().positive(),
  cost: z.string(),
});

// The client derives each node's share from `total_cost`, so no redundant `share` field ships.
export const MetricsFlowSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  total_cost: z.string(),
  nodes: z.array(MetricsFlowNodeSchema),
  edges: z.array(MetricsFlowEdgeSchema),
});

export type MetricsWindow = z.infer<typeof MetricsWindowSchema>;
export type DistributionMetric = z.infer<typeof DistributionMetricSchema>;
export type KpiWindow = z.infer<typeof KpiWindowSchema>;
export type MetricsKpis = z.infer<typeof MetricsKpisSchema>;
export type DistributionBucket = z.infer<typeof DistributionBucketSchema>;
export type DistributionStats = z.infer<typeof DistributionStatsSchema>;
export type MetricsDistribution = z.infer<typeof MetricsDistributionSchema>;
export type DistributionQuery = z.infer<typeof DistributionQuerySchema>;
export type TimeseriesPoint = z.infer<typeof TimeseriesPointSchema>;
export type MetricsTimeseries = z.infer<typeof MetricsTimeseriesSchema>;
export type TimeseriesQuery = z.infer<typeof TimeseriesQuerySchema>;
export type BlockKind = z.infer<typeof BlockKindSchema>;
export type MetricsBlock = z.infer<typeof MetricsBlockSchema>;
export type MetricsBlocks = z.infer<typeof MetricsBlocksSchema>;
export type MetricsAgentSummary = z.infer<typeof MetricsAgentSummarySchema>;
export type MetricsAgentTimeseries = z.infer<typeof MetricsAgentTimeseriesSchema>;
export type MetricsAgentDetails = z.infer<typeof MetricsAgentDetailsSchema>;
export type AgentDetailsQuery = z.infer<typeof AgentDetailsQuerySchema>;
export type TimeWindowQuery = z.infer<typeof TimeWindowQuerySchema>;
export type FlowNodeKind = z.infer<typeof FlowNodeKindSchema>;
export type MetricsFlowNode = z.infer<typeof MetricsFlowNodeSchema>;
export type MetricsFlowEdge = z.infer<typeof MetricsFlowEdgeSchema>;
export type MetricsFlow = z.infer<typeof MetricsFlowSchema>;
