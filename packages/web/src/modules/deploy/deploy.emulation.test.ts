import { describe, expect, test } from 'bun:test';

import {
  allocationFor,
  createRun,
  DOTS_PER_SECOND_MAX,
  dotWeight,
  fleetFromRun,
  step,
} from './deploy.emulation';
import { PRIORITY_MAX, PRIORITY_MIN } from './deploy.scaling-plan';
import type { EmulationGraph, EmulationPolicy, Lane } from './deploy.emulation';

// A three-agent chain behind an entry, which is the shape most imported projects come in as.
const GRAPH: EmulationGraph = {
  nodes: [
    { id: 'entry', label: 'workflow', kind: 'workflow', x: 0, y: 0 },
    { id: 'a', label: 'intent', kind: 'agent', x: 0.5, y: 0 },
    { id: 'b', label: 'advisor', kind: 'agent', x: 1, y: 0.5 },
  ],
  edges: [
    { source: 'entry', target: 'a' },
    { source: 'a', target: 'b' },
  ],
  llm_nodes: ['a', 'b'],
  entry_id: 'entry',
};

const POLICY: EmulationPolicy = {
  expected_load: 300,
  load_unit: 'minute',
  priority: 50,
  llm_endpoint: 'bedrock',
};

/** Runs a lane for `seconds` at a fixed step and reports the deepest queue it reached. */
function run(lane: Lane, policy: EmulationPolicy, seconds = 120, baseline = POLICY) {
  const state = createRun(GRAPH, lane, baseline);
  let last = step(state, GRAPH, lane, policy, 0);
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 20) {
    last = step(state, GRAPH, lane, policy, 1 / 20);
  }
  return last;
}

/** The most dot objects a lane held at once, which is what a frame has to move, copy and draw. */
function peakDots(lane: Lane, policy: EmulationPolicy, seconds = 120): number {
  const state = createRun(GRAPH, lane, policy);
  let peak = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 20) {
    peak = Math.max(peak, step(state, GRAPH, lane, policy, 1 / 20).dots.length);
  }
  return peak;
}

const latency: EmulationPolicy = { ...POLICY, priority: PRIORITY_MIN };
const cost: EmulationPolicy = { ...POLICY, priority: PRIORITY_MAX };

describe('the emulation, against the policy the config screen set', () => {
  // Where it starts: the policy screen worked out an allocation, and both lanes were handed it. The
  // hardware is identical and one lane's blocks do three times the work.
  test('both lanes start on the allocation the policy asked for', () => {
    expect(run('traditional', POLICY).stats.replicas).toBe(allocationFor(POLICY) * 4);
  });

  test('on the same blocks, the static lane is outrun and CanyonOS is not', () => {
    const traditional = run('traditional', POLICY).stats;
    const canyon = run('canyon', POLICY).stats;

    expect(canyon.replicas).toBe(traditional.replicas);
    expect(canyon.mean_queue).toBeLessThan(5);
    expect(traditional.mean_queue).toBeGreaterThan(50);
    expect(canyon.served).toBeGreaterThan(traditional.served * 1.5);
  });

  test.each([
    ['latency-led', latency],
    ['balanced', POLICY],
    ['cost-led', cost],
  ])('the static lane keeps the same blocks when %s', (_name, policy) => {
    expect(run('traditional', policy).stats.replicas).toBe(
      run('traditional', latency).stats.replicas
    );
  });

  test('CanyonOS answers the slider: more blocks for latency, fewer for cost', () => {
    const at_latency = run('canyon', latency).stats;
    const at_balanced = run('canyon', POLICY).stats;
    const at_cost = run('canyon', cost).stats;

    expect(at_latency.replicas).toBeGreaterThan(at_balanced.replicas);
    expect(at_cost.replicas).toBeLessThan(at_balanced.replicas);
  });

  test('asked for latency, CanyonOS keeps the waiting near nothing', () => {
    expect(run('canyon', latency).stats.mean_queue).toBeLessThan(4);
  });

  test('asked for cost, CanyonOS waits more than it would have, and far less than the static lane', () => {
    const at_cost = run('canyon', cost).stats;
    expect(at_cost.mean_queue).toBeGreaterThan(run('canyon', latency).stats.mean_queue);
    expect(at_cost.mean_queue).toBeLessThan(run('traditional', cost).stats.mean_queue);
  });

  test('the fleet is read off the blocks that were stacked, within the fields the form accepts', () => {
    const fleet = fleetFromRun(run('canyon', latency).replicas, GRAPH);
    expect(fleet.starting_cpu_instances).toBeGreaterThanOrEqual(1);
    expect(fleet.starting_cpu_instances).toBeLessThanOrEqual(10);
    expect(fleet.max_cpu_instances).toBeGreaterThanOrEqual(fleet.starting_cpu_instances);
    expect(fleet.max_gpu_instances).toBeGreaterThanOrEqual(fleet.starting_gpu_instances);
    expect(fleet.max_gpu_instances).toBeLessThanOrEqual(4);
  });
});

// The policy takes any load a reader wants to state. What it does not do is try to draw one dot per
// request: a million a second built fifty thousand objects in a single 50ms step, and the tab
// stopped answering before it drew anything.
describe('a load past what a pane can draw', () => {
  const drawable: EmulationPolicy = {
    ...POLICY,
    expected_load: DOTS_PER_SECOND_MAX,
    load_unit: 'second',
  };
  const flood: EmulationPolicy = { ...POLICY, expected_load: 1_000_000, load_unit: 'second' };
  const heavier: EmulationPolicy = { ...flood, expected_load: 10_000_000 };

  test('is sampled, while a load a pane can draw is not', () => {
    expect(dotWeight(POLICY)).toBe(1);
    expect(dotWeight(drawable)).toBe(1);
    expect(dotWeight(flood)).toBeGreaterThan(1);
  });

  test.each([
    ['the lane that keeps up', 'canyon'],
    ['the lane that backs up', 'traditional'],
  ] as const)('costs %s no more than a drawable load does', (_name, lane) => {
    const drawn = peakDots(lane, drawable);
    expect(peakDots(lane, flood)).toBeLessThan(drawn * 1.1);
    expect(peakDots(lane, heavier)).toBeLessThan(drawn * 1.1);
  });

  test('still counts every request the policy asked for, not every dot it drew', () => {
    const state = run('canyon', flood, 120, flood);
    const asked = flood.expected_load * state.stats.elapsed;

    expect(state.stats.served + state.stats.in_flight).toBeGreaterThan(asked * 0.999);
    expect(state.stats.served + state.stats.in_flight).toBeLessThanOrEqual(asked);
  });

  test('still shows the static lane outrun and CanyonOS keeping up', () => {
    const traditional = run('traditional', flood, 120, flood).stats;
    const canyon = run('canyon', flood, 120, flood).stats;

    expect(canyon.served).toBeGreaterThan(traditional.served * 1.5);
    expect(canyon.mean_queue).toBeLessThan(traditional.mean_queue / 10);
  });

  test('lets CanyonOS reach the blocks the load needs, from any allocation it opened on', () => {
    const from_a_small_baseline = run('canyon', flood, 30, POLICY).stats;
    expect(from_a_small_baseline.replicas).toBe(run('canyon', flood, 30, flood).stats.replicas);
  });
});
