import { describe, expect, test } from 'bun:test';

import { ScalingPolicySchema } from './scaling.types';

const valid_policy = {
  min_replicas: 1,
  max_replicas: 5,
  metric: 'queue_length_total' as const,
  scale_up_above: 3,
  scale_down_below: 1,
};

describe('ScalingPolicySchema', () => {
  test('accepts a valid policy', () => {
    expect(ScalingPolicySchema.safeParse(valid_policy).success).toBe(true);
  });

  test('requires at least one replica, since nothing scales an agent back up from zero', () => {
    expect(ScalingPolicySchema.safeParse({ ...valid_policy, min_replicas: 0 }).success).toBe(false);
  });

  test('requires min replicas not to exceed max replicas', () => {
    expect(ScalingPolicySchema.safeParse({ ...valid_policy, min_replicas: 6 }).success).toBe(false);
  });

  test('requires the scale-down threshold to be below scale-up', () => {
    expect(ScalingPolicySchema.safeParse({ ...valid_policy, scale_down_below: 3 }).success).toBe(
      false
    );
  });
});
