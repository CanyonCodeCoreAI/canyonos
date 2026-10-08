import { z } from 'zod';

export const TRACE_VIEWS = ['traces', 'llm_traces', 'llm_calls'] as const;

export type TraceView = (typeof TRACE_VIEWS)[number];

// `catch` lands a stale or hand-edited link on the default view instead of the route error screen.
export const MonitoringSearchSchema = z.object({
  view: z.enum(TRACE_VIEWS).catch('traces'),
  trace: z.string().min(1).optional().catch(undefined),
});
