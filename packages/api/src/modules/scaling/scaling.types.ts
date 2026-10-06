import { z } from 'zod';

export const ScalingMetricSchema = z.enum([
  'queue_length_total',
  'requests_per_minute_per_replica',
]);

// Nothing is measured at zero replicas, so an agent scaled to zero could never scale back up.
export const MIN_REPLICAS_FLOOR = 1;

export const ScalingPolicySchema = z
  .object({
    min_replicas: z.number().int().min(MIN_REPLICAS_FLOOR),
    max_replicas: z.number().int().min(MIN_REPLICAS_FLOOR),
    metric: ScalingMetricSchema,
    scale_up_above: z.number().nonnegative(),
    scale_down_below: z.number().nonnegative(),
  })
  .superRefine((policy, context) => {
    if (policy.min_replicas > policy.max_replicas) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_replicas'],
        message: 'max_replicas must be greater than or equal to min_replicas',
      });
    }
    if (policy.scale_down_below >= policy.scale_up_above) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale_down_below'],
        message: 'scale_down_below must be less than scale_up_above',
      });
    }
  });

/**
 * The workflow's one policy as the controller sees it. `applied` is what the controller enforces
 * on every agent; `invalid` is a stored policy it skips, with the first rule it breaks.
 */
export const ScalingStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('applied'), policy: ScalingPolicySchema }),
  z.object({ status: z.literal('invalid'), reason: z.string() }),
]);

export const ScalingDeleteResponseSchema = z.object({ status: z.literal('none') });

/** One agent's newest load sample, the figures the policy's metrics are read from. */
export const ScalingAgentLoadSchema = z.object({
  queue_length_total: z.number().nonnegative(),
  requests_per_minute_per_replica: z.number().nonnegative(),
  observed_at: z.string().datetime(),
});

export const ScalingAgentSchema = z.object({
  name: z.string(),
  /** The count the controller is converging to: the configured one until a policy moves it. */
  replicas_expected: z.number().int().nonnegative(),
  replicas_running: z.number().int().nonnegative(),
  /** Null until the controller has polled the agent once. */
  load: ScalingAgentLoadSchema.nullable(),
});

export const ScalingAgentsResponseSchema = z.object({ agents: z.array(ScalingAgentSchema) });

export type ScalingMetric = z.infer<typeof ScalingMetricSchema>;
export type ScalingPolicy = z.infer<typeof ScalingPolicySchema>;
export type ScalingStatus = z.infer<typeof ScalingStatusSchema>;
export type ScalingDeleteResponse = z.infer<typeof ScalingDeleteResponseSchema>;
export type ScalingAgentLoad = z.infer<typeof ScalingAgentLoadSchema>;
export type ScalingAgent = z.infer<typeof ScalingAgentSchema>;
export type ScalingAgentsResponse = z.infer<typeof ScalingAgentsResponseSchema>;
