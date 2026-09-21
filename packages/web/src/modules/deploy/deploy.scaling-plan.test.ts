import { describe, expect, test } from 'bun:test';

import {
  planSummary,
  posture,
  PRIORITY_LEVELS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  requestsPerSecond,
  ScalingPlanSchema,
} from './deploy.scaling-plan';
import type { ScalingPlanInput } from './deploy.scaling-plan';

const plan = (overrides: Partial<ScalingPlanInput> = {}): ScalingPlanInput => ({
  expected_load: 120,
  load_unit: 'minute',
  priority: 50,
  llm_endpoint: 'bedrock',
  ...overrides,
});

describe('requestsPerSecond', () => {
  test('normalises every unit onto the same scale', () => {
    expect(requestsPerSecond(30, 'second')).toBe(30);
    expect(requestsPerSecond(120, 'minute')).toBe(2);
    expect(requestsPerSecond(3_600, 'hour')).toBe(1);
    expect(requestsPerSecond(86_400, 'day')).toBe(1);
  });

  test('keeps a rate below one instead of rounding it to nothing', () => {
    // A daily trickle is not zero traffic, so the plan must not read as if it were.
    expect(requestsPerSecond(1, 'day')).toBeGreaterThan(0);
  });
});

describe('posture', () => {
  test('names each end and the middle', () => {
    expect(posture(0)).toContain('best latency');
    expect(posture(50)).toContain('balanced');
    expect(posture(100)).toContain('economical');
  });

  test('leans without committing between the extremes and the middle', () => {
    expect(posture(30)).toContain('leaning towards latency');
    expect(posture(70)).toContain('leaning towards cost');
  });
});

describe('planSummary', () => {
  test('restates the load, the target and the posture', () => {
    const summary = planSummary(plan(), 'AWS');

    expect(summary.throughput).toBe('120 requests per minute');
    expect(summary.detail).toBe(
      '2 req/s sustained on AWS via Bedrock, balanced between latency and cost.'
    );
  });

  test('keeps two decimals for a rate under ten per second', () => {
    expect(planSummary(plan({ expected_load: 30, load_unit: 'hour' }), 'GCP').detail).toContain(
      '0.01 req/s'
    );
  });

  test('rounds a busy rate to whole requests per second', () => {
    expect(
      planSummary(plan({ expected_load: 9_000, load_unit: 'minute' }), 'AWS').detail
    ).toContain('150 req/s');
  });

  test('groups a large stated load for reading', () => {
    expect(
      planSummary(plan({ expected_load: 1_200_000, load_unit: 'day' }), 'AWS').throughput
    ).toBe('1,200,000 requests per day');
  });
});

describe('ScalingPlanSchema', () => {
  test('accepts a whole positive load', () => {
    expect(ScalingPlanSchema.safeParse(plan()).success).toBe(true);
  });

  test('rejects a load that is absent, zero or fractional', () => {
    for (const expected_load of [Number.NaN, 0, -5, 1.5]) {
      expect(ScalingPlanSchema.safeParse(plan({ expected_load })).success).toBe(false);
    }
  });
});

describe('PRIORITY_LEVELS', () => {
  test('spans both extremes in ten even steps', () => {
    expect(PRIORITY_LEVELS).toHaveLength(11);
    expect(PRIORITY_LEVELS.at(0)).toBe(PRIORITY_MIN);
    expect(PRIORITY_LEVELS.at(-1)).toBe(PRIORITY_MAX);
  });

  test('every level is a value the plan accepts', () => {
    // The ticks and the slider read the same source, so a tick can never be unreachable.
    for (const priority of PRIORITY_LEVELS) {
      const parsed = ScalingPlanSchema.safeParse({
        expected_load: 120,
        load_unit: 'minute',
        priority,
        llm_endpoint: 'bedrock',
      });
      expect(parsed.success).toBe(true);
    }
  });
});
