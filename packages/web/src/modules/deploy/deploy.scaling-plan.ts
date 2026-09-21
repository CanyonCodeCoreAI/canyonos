// The questions asked before a deploy: how much traffic to plan for, what to optimise for, and where
// to run it. This is the plan the reader states up front, not a policy a running deployment follows.

import { z } from 'zod';

export const LOAD_UNIT_OPTIONS = [
  { value: 'second', label: 'per second' },
  { value: 'minute', label: 'per minute' },
  { value: 'hour', label: 'per hour' },
  { value: 'day', label: 'per day' },
] as const;

// `short` is what fits inside the emulation's model block, which is narrower than a full name.
export const LLM_ENDPOINT_OPTIONS = [
  { value: 'bedrock', label: 'Bedrock', short: 'BEDROCK' },
  { value: 'gemini', label: 'Gemini', short: 'GEMINI' },
  // A model served inside the company's own estate rather than by a provider.
  { value: 'custom_internal', label: 'Custom Internal', short: 'INTERNAL' },
] as const;

export type LoadUnit = (typeof LOAD_UNIT_OPTIONS)[number]['value'];
export type LlmEndpoint = (typeof LLM_ENDPOINT_OPTIONS)[number]['value'];

const SECONDS_PER_UNIT: Record<LoadUnit, number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
};

/**
 * 0 is all latency, 100 is all cost. The midpoint is the default because neither is assumed.
 *
 * The slider locks to ten steps between the extremes rather than sliding freely: a pixel-precise 63
 * says more than the reader means, and ten detents are enough to express a leaning.
 */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;
export const PRIORITY_STEP = 10;
export const PRIORITY_DEFAULT = 50;

/** Every value the slider can stop on, so the ticks under it are drawn from the same source. */
export const PRIORITY_LEVELS: readonly number[] = Array.from(
  { length: (PRIORITY_MAX - PRIORITY_MIN) / PRIORITY_STEP + 1 },
  (_level, index) => PRIORITY_MIN + index * PRIORITY_STEP
);

export const ScalingPlanSchema = z.object({
  expected_load: z
    .number({ invalid_type_error: 'Enter the load you expect.' })
    .int('Enter a whole number of requests.')
    .positive('Enter at least one request.'),
  load_unit: z.enum(['second', 'minute', 'hour', 'day']),
  priority: z.number().min(PRIORITY_MIN).max(PRIORITY_MAX),
  llm_endpoint: z.enum(['bedrock', 'gemini', 'custom_internal']),
});

export type ScalingPlanInput = z.infer<typeof ScalingPlanSchema>;

// Bedrock leads because it is the endpoint the demo estate is wired to.
export const SCALING_PLAN_DEFAULTS = {
  load_unit: 'minute',
  priority: PRIORITY_DEFAULT,
  llm_endpoint: 'bedrock',
} as const satisfies Partial<ScalingPlanInput>;

/**
 * The stated load as requests per second, so a plan given in days and one given in seconds can be
 * compared. Kept exact rather than rounded: 1 request per day is not 0 requests per second.
 */
export function requestsPerSecond(load: number, unit: LoadUnit): number {
  return load / SECONDS_PER_UNIT[unit];
}

/** Where the slider sits, in words, so the summary does not print a bare number. */
export function posture(priority: number): string {
  if (priority <= 20) return 'tuned for the best latency';
  if (priority <= 40) return 'leaning towards latency';
  if (priority < 60) return 'balanced between latency and cost';
  if (priority < 80) return 'leaning towards cost';
  return 'tuned to be the most economical';
}

/**
 * What the analysis reports back. It restates the plan rather than predicting a fleet: no planner
 * exists yet, and an invented instance count would read as a real recommendation.
 */
export function planSummary(
  plan: ScalingPlanInput,
  compute_environment: string
): { readonly throughput: string; readonly detail: string } {
  const unit = LOAD_UNIT_OPTIONS.find((option) => option.value === plan.load_unit);
  const endpoint = LLM_ENDPOINT_OPTIONS.find((option) => option.value === plan.llm_endpoint);
  const per_second = requestsPerSecond(plan.expected_load, plan.load_unit);

  return {
    throughput:
      `${plan.expected_load.toLocaleString('en-US')} requests ${unit?.label ?? ''}`.trim(),
    detail: `${formatPerSecond(per_second)} sustained on ${compute_environment} via ${endpoint?.label ?? ''}, ${posture(plan.priority)}.`,
  };
}

/** Sub-1 rates keep two decimals; anything a reader would call a rate is shown whole. */
function formatPerSecond(per_second: number): string {
  const rounded = per_second >= 10 ? Math.round(per_second) : Number(per_second.toFixed(2));
  return `${rounded.toLocaleString('en-US')} req/s`;
}
