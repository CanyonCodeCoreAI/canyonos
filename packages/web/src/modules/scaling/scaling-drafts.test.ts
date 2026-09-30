import { describe, expect, test } from 'bun:test';

import type { ScalingResponse } from '@canyonos/api/scaling';

import { freeAgents, reduceScalingDrafts, scalingScreenState } from './scaling-drafts';
import type { ScalingDraft } from './scaling-drafts';

const RESPONSE: ScalingResponse = {
  agents: ['classifier', 'enricher', 'router', 'summarizer'],
  policies: {
    summarizer: {
      min_replicas: 1,
      max_replicas: 4,
      metric: 'queue_length_total',
      scale_up_above: 3,
      scale_down_below: 1,
    },
  },
  invalid: ['enricher'],
};

const draft = (id: string, agent_name: string | null = null): ScalingDraft => ({
  id,
  kind: 'throughput',
  agent_name,
});

describe('scaling drafts reducer', () => {
  test('add appends an unpicked draft of the given kind', () => {
    const drafts = reduceScalingDrafts([draft('a')], {
      type: 'add',
      id: 'b',
      kind: 'queue_length',
    });
    expect(drafts).toEqual([draft('a'), { id: 'b', kind: 'queue_length', agent_name: null }]);
  });

  test('pick_agent sets the agent of that draft only', () => {
    const drafts = reduceScalingDrafts([draft('a'), draft('b')], {
      type: 'pick_agent',
      id: 'b',
      agent_name: 'router',
    });
    expect(drafts).toEqual([draft('a'), draft('b', 'router')]);
  });

  test('pick_agent can change the draft own pick', () => {
    const drafts = reduceScalingDrafts([draft('a', 'router')], {
      type: 'pick_agent',
      id: 'a',
      agent_name: 'classifier',
    });
    expect(drafts).toEqual([draft('a', 'classifier')]);
  });

  test('pick_agent refuses an agent another draft claimed', () => {
    const before = [draft('a', 'router'), draft('b')];
    expect(reduceScalingDrafts(before, { type: 'pick_agent', id: 'b', agent_name: 'router' })).toBe(
      before
    );
  });

  test.each(['discard', 'saved'] as const)('%s removes only that draft', (type) => {
    const drafts = reduceScalingDrafts([draft('a', 'router'), draft('b')], { type, id: 'a' });
    expect(drafts).toEqual([draft('b')]);
  });
});

describe('free agents', () => {
  test('excludes saved, invalid, and draft-claimed agents, keeping response order', () => {
    expect(freeAgents(RESPONSE, [])).toEqual(['classifier', 'router']);
    expect(freeAgents(RESPONSE, [draft('a', 'router'), draft('b')])).toEqual(['classifier']);
  });

  test('a draft options include its own pick but not other drafts picks', () => {
    const drafts = [draft('a', 'router'), draft('b', 'classifier')];
    expect(freeAgents(RESPONSE, drafts)).toEqual([]);
    expect(freeAgents(RESPONSE, drafts, 'a')).toEqual(['router']);
    expect(freeAgents(RESPONSE, drafts, 'b')).toEqual(['classifier']);
  });

  test('a draft keeps its own pick once that agent has a saved policy', () => {
    const saved = {
      ...RESPONSE,
      policies: { ...RESPONSE.policies, router: RESPONSE.policies.summarizer! },
    };
    const drafts = [draft('a', 'router')];
    expect(freeAgents(saved, drafts, 'a')).toEqual(['classifier', 'router']);
    expect(freeAgents(saved, [])).toEqual(['classifier']);
  });

  test('a draft whose picked agent stopped running is offered only the free agents', () => {
    expect(freeAgents(RESPONSE, [draft('a', 'gone')], 'a')).toEqual(['classifier', 'router']);
  });
});

describe('scaling screen state', () => {
  const EMPTY: ScalingResponse = { agents: ['router'], policies: {}, invalid: [] };

  test('loading while the first read is pending', () => {
    expect(scalingScreenState({ data: undefined, error: null, is_fetching: true }, [])).toEqual({
      status: 'loading',
    });
  });

  test('error once a read failed, loading again while it is retried', () => {
    const error = new Error('The running controller could not be reached');
    expect(scalingScreenState({ data: undefined, error, is_fetching: false }, [])).toEqual({
      status: 'error',
      message: error.message,
    });
    expect(scalingScreenState({ data: undefined, error, is_fetching: true }, [])).toEqual({
      status: 'loading',
    });
  });

  test('empty only with no saved, invalid, or draft policies', () => {
    const query = { data: EMPTY, error: null, is_fetching: false };
    expect(scalingScreenState(query, [])).toEqual({ status: 'empty', response: EMPTY });
    expect(scalingScreenState(query, [draft('a')]).status).toBe('list');
    expect(
      scalingScreenState({ ...query, data: { ...EMPTY, invalid: ['router'] } }, []).status
    ).toBe('list');
    expect(scalingScreenState({ ...query, data: RESPONSE }, []).status).toBe('list');
  });
});
