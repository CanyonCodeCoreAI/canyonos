// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { TIME_RANGE_FIELDS, timeRangeQuery } from '@core/time-range';

import { BlockKindSchema, DistributionMetricSchema } from '../metrics/metrics.types';

export const RequestStatusSchema = z.enum(['running', 'completed', 'failed']);

// Money fields are numeric(20, 10) rendered as fixed 10-decimal strings — the API never converts
// costs to floats.
export const RequestListItemSchema = z.object({
  session_id: z.string(),
  status: RequestStatusSchema,
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  block_count: z.number().int().nonnegative(),
  failed_block_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  token_count: z.number().int().nonnegative(),
  llm_cost: z.string(),
  harness_cost: z.string(),
  total_cost: z.string(),
});

export const RequestListSchema = z.object({
  ...TIME_RANGE_FIELDS,
  total: z.number().int().nonnegative(),
  items: z.array(RequestListItemSchema),
});

export const RequestTraceBlockSchema = z.object({
  future_id: z.string(),
  label: z.string(),
  kind: BlockKindSchema,
  model: z.string().nullable(),
  prompt_name: z.string().nullable(),
  prompt_version: z.string().nullable(),
  started_offset_ms: z.number().int().nonnegative(),
  execution_time_ms: z.number().int().nonnegative().nullable(),
  input_token_count: z.number().int().nonnegative(),
  output_token_count: z.number().int().nonnegative(),
  total_cost: z.string(),
  errors: z.number().int().nonnegative(),
  failed: z.boolean(),
});

// The listing's rollup for one trace, plus what only the detail view needs: the project's medians
// over the requests that started in the queried range, and the blocks it ran. The trace itself reads
// whole wherever it started. Every median is null when nothing billed in the range.
export const RequestTraceSchema = RequestListItemSchema.pick({
  session_id: true,
  status: true,
  created_at: true,
  started_at: true,
  finished_at: true,
  duration_ms: true,
  error_count: true,
  token_count: true,
  total_cost: true,
}).extend({
  project_id: z.string().uuid(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  median_cost: z.string().nullable(),
  harness_cost: z.string(),
  median_harness_cost: z.string().nullable(),
  median_token_count: z.number().nullable(),
  // How many times the median each figure is, computed over the exact numerics so the dashboard
  // never divides parsed floats. Null without a median, and also for a zero median: a billed project
  // can spend $0 on harness, which is a real reference that supports no multiple.
  cost_vs_median: z.number().nullable(),
  harness_cost_vs_median: z.number().nullable(),
  token_count_vs_median: z.number().nullable(),
  blocks: z.array(RequestTraceBlockSchema),
});

// What the queries table can order by. `created_at` is the listing's natural order — newest first.
// Every key is a value the per-trace rollup produces, so sorting costs a sort over the whole matched
// set. `status` is deliberately absent: its values have no order a reader would agree on, so a
// filter is the honest control for it.
export const RequestSortSchema = z.enum([
  'created_at',
  'total_cost',
  'token_count',
  'duration_ms',
  'error_count',
]);

export const SortDirectionSchema = z.enum(['asc', 'desc']);

// `metric`/`min`/`max` are the histogram selection and travel together: a half-specified selection
// answered with an unfiltered page would stop the table agreeing with the chart beside it.
export const ListRequestsQuerySchema = timeRangeQuery({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: RequestSortSchema.optional(),
  order: SortDirectionSchema.optional(),
  status: RequestStatusSchema.optional(),
  metric: DistributionMetricSchema.optional(),
  min: z.coerce.number().optional(),
  max: z.coerce.number().optional(),
  // The picked day, half-open: it narrows the listing inside `from`/`to`, never the histogram's set.
  created_from: z.string().datetime({ offset: true }).optional(),
  created_to: z.string().datetime({ offset: true }).optional(),
}).superRefine((query, ctx) => {
  const selection = [query.metric, query.min, query.max].filter((part) => part !== undefined);
  if (selection.length !== 0 && selection.length !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'metric, min and max must be supplied together',
      path: ['metric'],
    });
  }

  if (
    query.created_from !== undefined &&
    query.created_to !== undefined &&
    Date.parse(query.created_from) >= Date.parse(query.created_to)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'created_from must be earlier than created_to',
      path: ['created_from'],
    });
  }
});

export type RequestStatus = z.infer<typeof RequestStatusSchema>;
export type RequestListItem = z.infer<typeof RequestListItemSchema>;
export type RequestList = z.infer<typeof RequestListSchema>;
export type RequestTraceBlock = z.infer<typeof RequestTraceBlockSchema>;
export type RequestTrace = z.infer<typeof RequestTraceSchema>;
export type RequestSort = z.infer<typeof RequestSortSchema>;
export type SortDirection = z.infer<typeof SortDirectionSchema>;
export type ListRequestsQuery = z.infer<typeof ListRequestsQuerySchema>;

/** The complete selection, once the query has been checked for it. */
export type RequestMetricRange = Required<Pick<ListRequestsQuery, 'metric' | 'min' | 'max'>>;
