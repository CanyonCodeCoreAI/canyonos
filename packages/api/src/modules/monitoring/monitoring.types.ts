import { z } from 'zod';

import { MetricsWindowSchema } from '../metrics/metrics.types';

export const MonitoringSignalSchema = z.enum(['traffic', 'errors', 'latency', 'saturation']);

export const MonitoringUnitSchema = z.enum(['requests', 'ms', 'percent']);

export const MonitoringKindSchema = z.enum(['flow', 'stock']);

export const MonitoringResourceSchema = z.enum(['cpu', 'memory', 'disk', 'gpu']);

export const MonitoringScopeSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
});

export const MonitoringQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('1d'),
});

export const MonitoringListQuerySchema = MonitoringQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const MonitoringLogsQuerySchema = MonitoringListQuerySchema.extend({
  errors_only: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((flag) => flag === 'true')])
    .default(false),
  agent: z.string().min(1).optional(),
  replica: z.string().min(1).optional(),
});

// Every bucket of the window, oldest first; each series' `values` is index-aligned with it.
export const MonitoringGridSchema = z.object({
  bucket_seconds: z.number().positive(),
  bucket_start_ats: z.array(z.string()),
});

// A null value is a bucket nothing was measured in. The stats cover measured readings only, so
// they are null when `samples` is 0.
export const MonitoringValueSeriesSchema = z.object({
  values: z.array(z.number().nullable()),
  average: z.number().nullable(),
  peak: z.number().nullable(),
  latest: z.number().nullable(),
  samples: z.number().int().nonnegative(),
});

export const MonitoringSeriesSchema = MonitoringValueSeriesSchema.extend({
  signal: MonitoringSignalSchema,
  unit: MonitoringUnitSchema,
  kind: MonitoringKindSchema,
});

export const MonitoringSeriesResponseSchema = MonitoringScopeSchema.extend({
  ...MonitoringGridSchema.shape,
  series: z.array(MonitoringSeriesSchema),
});

// A resource is listed only once it has a reading, so its stats are never null.
export const MonitoringResourceSeriesSchema = MonitoringValueSeriesSchema.extend({
  resource: MonitoringResourceSchema,
  average: z.number(),
  peak: z.number(),
  latest: z.number(),
});

export const MonitoringResourceEntrySchema = z.object({
  key: z.string(),
  series: z.array(MonitoringResourceSeriesSchema),
});

export const MonitoringResourceUtilizationResponseSchema = MonitoringScopeSchema.extend({
  ...MonitoringGridSchema.shape,
  machines: z.array(MonitoringResourceEntrySchema),
  agents: z.array(MonitoringResourceEntrySchema),
});

export const MonitoringLogSourceSchema = z.object({
  agent: z.string(),
  replicas: z.array(z.string()),
});

export const MonitoringLogSourcesResponseSchema = MonitoringScopeSchema.extend({
  sources: z.array(MonitoringLogSourceSchema),
});

// `attributes` leaves out the keys already promoted to `agent` and `replica`.
export const MonitoringLogSchema = z.object({
  at: z.string(),
  severity: z.string().nullable(),
  severity_number: z.number().nullable(),
  agent: z.string().nullable(),
  replica: z.string().nullable(),
  body: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});

export const MonitoringLogsResponseSchema = MonitoringScopeSchema.extend({
  logs: z.array(MonitoringLogSchema),
});

export const MonitoringLlmDetailsSchema = z.object({
  model: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost: z.number().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
});

export const MonitoringTraceSpanSchema = z.object({
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  agent: z.string().nullable(),
  offset_ms: z.number(),
  duration_ms: z.number(),
  failed: z.boolean(),
  status_message: z.string().nullable(),
  llm: MonitoringLlmDetailsSchema.nullable(),
});

export const MonitoringLlmCallSchema = MonitoringTraceSpanSchema.pick({
  span_id: true,
  name: true,
  agent: true,
  failed: true,
  status_message: true,
}).extend({
  ...MonitoringLlmDetailsSchema.shape,
  at: z.string(),
  trace_id: z.string(),
  duration_ms: z.number().nullable(),
  cache_hit_ratio: z.number().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});

export const MonitoringLlmCallsResponseSchema = MonitoringScopeSchema.extend({
  calls: z.array(MonitoringLlmCallSchema),
});

export const MonitoringTraceSchema = MonitoringTraceSpanSchema.pick({
  name: true,
  duration_ms: true,
  failed: true,
}).extend({
  at: z.string(),
  trace_id: z.string(),
  agents: z.array(z.string()),
  span_count: z.number().int(),
  spans: z.array(MonitoringTraceSpanSchema),
});

export const MonitoringTracesResponseSchema = MonitoringScopeSchema.extend({
  traces: z.array(MonitoringTraceSchema),
});

// Only replicas that report a `service.instance.id`: without one, samples from different
// containers cannot be told apart, so they would collapse into one row and miscount the replicas up.
export const MonitoringReplicaSchema = z.object({
  agent: z.string(),
  replica: z.string(),
  queue_length: z.number().int().nullable(),
  active_requests: z.number().int().nullable(),
});

export const MonitoringReplicasResponseSchema = MonitoringScopeSchema.pick({
  project_id: true,
}).extend({
  replicas: z.array(MonitoringReplicaSchema),
});

export const MonitoringEndpointSchema = z.object({
  name: z.string(),
  url: z.string(),
});

export const MonitoringEndpointsResponseSchema = MonitoringScopeSchema.pick({
  project_id: true,
}).extend({
  endpoints: z.array(MonitoringEndpointSchema),
});

export const MonitoringErrorGroupSchema = z.object({
  key: z.string(),
  count: z.number().int(),
});

export const MonitoringErrorSummaryResponseSchema = MonitoringScopeSchema.extend({
  total: z.number().int(),
  by_type: z.array(MonitoringErrorGroupSchema),
  by_agent: z.array(MonitoringErrorGroupSchema),
});

export type MonitoringSignal = z.infer<typeof MonitoringSignalSchema>;
export type MonitoringUnit = z.infer<typeof MonitoringUnitSchema>;
export type MonitoringKind = z.infer<typeof MonitoringKindSchema>;
export type MonitoringResource = z.infer<typeof MonitoringResourceSchema>;
export type MonitoringScope = z.infer<typeof MonitoringScopeSchema>;
export type MonitoringQuery = z.infer<typeof MonitoringQuerySchema>;
export type MonitoringListQuery = z.infer<typeof MonitoringListQuerySchema>;
export type MonitoringLogsQuery = z.infer<typeof MonitoringLogsQuerySchema>;
export type MonitoringGrid = z.infer<typeof MonitoringGridSchema>;
export type MonitoringValueSeries = z.infer<typeof MonitoringValueSeriesSchema>;
export type MonitoringSeries = z.infer<typeof MonitoringSeriesSchema>;
export type MonitoringSeriesResponse = z.infer<typeof MonitoringSeriesResponseSchema>;
export type MonitoringResourceSeries = z.infer<typeof MonitoringResourceSeriesSchema>;
export type MonitoringResourceEntry = z.infer<typeof MonitoringResourceEntrySchema>;
export type MonitoringResourceUtilizationResponse = z.infer<
  typeof MonitoringResourceUtilizationResponseSchema
>;
export type MonitoringLogSource = z.infer<typeof MonitoringLogSourceSchema>;
export type MonitoringLogSourcesResponse = z.infer<typeof MonitoringLogSourcesResponseSchema>;
export type MonitoringLog = z.infer<typeof MonitoringLogSchema>;
export type MonitoringLogsResponse = z.infer<typeof MonitoringLogsResponseSchema>;
export type MonitoringLlmCall = z.infer<typeof MonitoringLlmCallSchema>;
export type MonitoringLlmCallsResponse = z.infer<typeof MonitoringLlmCallsResponseSchema>;
export type MonitoringLlmDetails = z.infer<typeof MonitoringLlmDetailsSchema>;
export type MonitoringTraceSpan = z.infer<typeof MonitoringTraceSpanSchema>;
export type MonitoringTrace = z.infer<typeof MonitoringTraceSchema>;
export type MonitoringTracesResponse = z.infer<typeof MonitoringTracesResponseSchema>;
export type MonitoringReplica = z.infer<typeof MonitoringReplicaSchema>;
export type MonitoringReplicasResponse = z.infer<typeof MonitoringReplicasResponseSchema>;
export type MonitoringEndpoint = z.infer<typeof MonitoringEndpointSchema>;
export type MonitoringEndpointsResponse = z.infer<typeof MonitoringEndpointsResponseSchema>;
export type MonitoringErrorGroup = z.infer<typeof MonitoringErrorGroupSchema>;
export type MonitoringErrorSummaryResponse = z.infer<typeof MonitoringErrorSummaryResponseSchema>;
