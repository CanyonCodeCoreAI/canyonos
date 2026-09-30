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

export const ScalingResponseSchema = z.object({
  agents: z.array(z.string()),
  policies: z.record(z.string(), ScalingPolicySchema),
  /** Agents whose stored policy is invalid; the controller ignores them until they are replaced. */
  invalid: z.array(z.string()),
});

export const ScalingDeleteResponseSchema = z.object({ agent_name: z.string() });

export type ScalingMetric = z.infer<typeof ScalingMetricSchema>;
export type ScalingPolicy = z.infer<typeof ScalingPolicySchema>;
export type ScalingResponse = z.infer<typeof ScalingResponseSchema>;
export type ScalingDeleteResponse = z.infer<typeof ScalingDeleteResponseSchema>;
