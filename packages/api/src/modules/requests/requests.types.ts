import { z } from 'zod';

import {
  BlockKindSchema,
  DistributionMetricSchema,
  MetricsWindowSchema,
} from '../metrics/metrics.types';

export const RequestStatusSchema = z.enum(['running', 'completed', 'failed']);

// Money fields are numeric(14,6) rendered as fixed 6-decimal strings — the API never converts
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
  total: z.number().int().nonnegative(),
  items: z.array(RequestListItemSchema),
});

export const RequestTraceBlockSchema = z.object({
  future_id: z.string(),
  label: z.string(),
  kind: BlockKindSchema,
  model: z.string().nullable(),
  started_offset_ms: z.number().int().nonnegative(),
  execution_time_ms: z.number().int().nonnegative().nullable(),
  input_token_count: z.number().int().nonnegative(),
  output_token_count: z.number().int().nonnegative(),
  total_cost: z.string(),
  errors: z.number().int().nonnegative(),
  failed: z.boolean(),
});

// The listing's rollup for one trace, plus what only the detail view needs: the project medians it
// is compared against and the blocks it ran. Every median is null when nothing billed in the window.
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
  // The harness side of this query's spend, and the same three trailing-30-day medians the drawer
  // compares against. Every median is null when the project billed nothing in the window.
  harness_cost: z.string(),
  median_harness_cost: z.string().nullable(),
  median_token_count: z.number().nullable(),
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

// `metric`/`min`/`max` are the histogram selection the distribution card drives the table with.
// They travel together — a half-specified selection is a client bug, and answering it with a silently
// unfiltered page is how a table stops agreeing with the chart beside it. `time_window` scopes both
// the listing and any selected histogram bucket, so every per-query read describes one range.
//
// `sort`/`order` are optional for the same reason: omitting both has to keep meaning exactly what it
// meant before they existed (newest first), and defaulting them here would force every caller to
// name an order it does not care about.
export const ListRequestsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    sort: RequestSortSchema.optional(),
    order: SortDirectionSchema.optional(),
    // Status has no useful order, so it is exposed as a filter instead of a sortable column.
    status: RequestStatusSchema.optional(),
    metric: DistributionMetricSchema.optional(),
    min: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
    time_window: MetricsWindowSchema.optional(),
    // The day picker's window over `created_at`, half-open: inclusive `created_from`, exclusive
    // `created_to`. A day is a timezone-local idea, so the client turns the day it selected into the
    // pair of instants that bound it — and the midnight between two days then belongs to exactly one
    // of them, whichever timezone the reader is in. Either bound may stand alone ("since", "until").
    // Both require an offset: a bare local time is not an instant, and guessing UTC for it would
    // silently shift the window by the reader's offset.
    created_from: z.string().datetime({ offset: true }).optional(),
    created_to: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((query, ctx) => {
    const selection = [query.metric, query.min, query.max].filter((part) => part !== undefined);
    if (selection.length !== 0 && selection.length !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metric, min and max must be supplied together',
        path: ['metric'],
      });
    }

    // Compared as instants, not as text: the same moment has many spellings ('...Z' vs '+00:00',
    // with or without milliseconds), and only one of them sorts correctly as a string.
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
export type RequestMetricRange = Required<
  Pick<ListRequestsQuery, 'metric' | 'min' | 'max' | 'time_window'>
>;
