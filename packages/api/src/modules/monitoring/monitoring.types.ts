import { z } from 'zod';

import { MetricsWindowSchema } from '../metrics/metrics.types';

export const MonitoringSignalSchema = z.enum(['traffic', 'errors', 'latency', 'saturation']);

export const MonitoringUnitSchema = z.enum(['requests', 'ms', 'percent']);

export const MonitoringKindSchema = z.enum(['flow', 'stock']);

export const MonitoringQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('1d'),
});

export const MonitoringSeriesSchema = z.object({
  signal: MonitoringSignalSchema,
  unit: MonitoringUnitSchema,
  kind: MonitoringKindSchema,
  values: z.array(z.number().nullable()),
});

export const MonitoringSeriesResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  bucket_seconds: z.number().positive(),
  bucket_start_ats: z.array(z.string()),
  series: z.array(MonitoringSeriesSchema),
});

export const MonitoringLogsQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('1d'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  errors_only: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((flag) => flag === 'true')])
    .default(false),
  agent: z.string().min(1).optional(),
  replica: z.string().min(1).optional(),
});

export const MonitoringLogSourceSchema = z.object({
  agent: z.string(),
  replicas: z.array(z.string()),
});

export const MonitoringLogSourcesResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  sources: z.array(MonitoringLogSourceSchema),
});

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

export const MonitoringLogsResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  logs: z.array(MonitoringLogSchema),
});

export const MonitoringResourceSchema = z.enum(['cpu', 'memory', 'disk', 'gpu']);

export const MonitoringResourceSeriesSchema = z.object({
  resource: MonitoringResourceSchema,
  average: z.number(),
  peak: z.number(),
  latest: z.number(),
  samples: z.number().int(),
  values: z.array(z.number().nullable()),
});

export const MonitoringResourceEntrySchema = z.object({
  key: z.string(),
  series: z.array(MonitoringResourceSeriesSchema),
});

export const MonitoringResourceUtilizationResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  bucket_seconds: z.number().positive(),
  bucket_start_ats: z.array(z.string()),
  machines: z.array(MonitoringResourceEntrySchema),
  agents: z.array(MonitoringResourceEntrySchema),
});

export const MonitoringLlmCallsQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('1d'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const MonitoringLlmCallSchema = z.object({
  at: z.string(),
  name: z.string(),
  model: z.string().nullable(),
  agent: z.string().nullable(),
  duration_ms: z.number().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cache_hit_ratio: z.number().nullable(),
  cost: z.number().nullable(),
  failed: z.boolean(),
  status_message: z.string().nullable(),
  trace_id: z.string(),
  span_id: z.string(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});

export const MonitoringLlmCallsResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  calls: z.array(MonitoringLlmCallSchema),
});

export const MonitoringTracesQuerySchema = z.object({
  time_window: MetricsWindowSchema.default('1d'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
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
});

export const MonitoringTraceSchema = z.object({
  at: z.string(),
  trace_id: z.string(),
  name: z.string(),
  agents: z.array(z.string()),
  span_count: z.number().int(),
  duration_ms: z.number(),
  failed: z.boolean(),
  spans: z.array(MonitoringTraceSpanSchema),
});

export const MonitoringTracesResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  traces: z.array(MonitoringTraceSchema),
});

export const MonitoringErrorGroupSchema = z.object({
  key: z.string(),
  count: z.number().int(),
});

export const MonitoringErrorSummaryResponseSchema = z.object({
  project_id: z.string().uuid(),
  time_window: MetricsWindowSchema,
  total: z.number().int(),
  by_type: z.array(MonitoringErrorGroupSchema),
  by_agent: z.array(MonitoringErrorGroupSchema),
});

export type MonitoringSignal = z.infer<typeof MonitoringSignalSchema>;
export type MonitoringResource = z.infer<typeof MonitoringResourceSchema>;
export type MonitoringResourceSeries = z.infer<typeof MonitoringResourceSeriesSchema>;
export type MonitoringResourceEntry = z.infer<typeof MonitoringResourceEntrySchema>;
export type MonitoringResourceUtilizationResponse = z.infer<
  typeof MonitoringResourceUtilizationResponseSchema
>;
export type MonitoringErrorGroup = z.infer<typeof MonitoringErrorGroupSchema>;
export type MonitoringErrorSummaryResponse = z.infer<typeof MonitoringErrorSummaryResponseSchema>;
export type MonitoringLlmCallsQuery = z.infer<typeof MonitoringLlmCallsQuerySchema>;
export type MonitoringLlmCall = z.infer<typeof MonitoringLlmCallSchema>;
export type MonitoringLlmCallsResponse = z.infer<typeof MonitoringLlmCallsResponseSchema>;
export type MonitoringTracesQuery = z.infer<typeof MonitoringTracesQuerySchema>;
export type MonitoringTraceSpan = z.infer<typeof MonitoringTraceSpanSchema>;
export type MonitoringTrace = z.infer<typeof MonitoringTraceSchema>;
export type MonitoringTracesResponse = z.infer<typeof MonitoringTracesResponseSchema>;
export type MonitoringLogsQuery = z.infer<typeof MonitoringLogsQuerySchema>;
export type MonitoringLogSource = z.infer<typeof MonitoringLogSourceSchema>;
export type MonitoringLogSourcesResponse = z.infer<typeof MonitoringLogSourcesResponseSchema>;
export type MonitoringLog = z.infer<typeof MonitoringLogSchema>;
export type MonitoringLogsResponse = z.infer<typeof MonitoringLogsResponseSchema>;
export type MonitoringUnit = z.infer<typeof MonitoringUnitSchema>;
export type MonitoringKind = z.infer<typeof MonitoringKindSchema>;
export type MonitoringQuery = z.infer<typeof MonitoringQuerySchema>;
export type MonitoringSeries = z.infer<typeof MonitoringSeriesSchema>;
export type MonitoringSeriesResponse = z.infer<typeof MonitoringSeriesResponseSchema>;
