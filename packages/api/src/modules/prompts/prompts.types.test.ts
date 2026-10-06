import { describe, expect, test } from 'bun:test';

import { next_revision, prompt_name_parts, version_parts } from './prompts.types';

describe('prompt name and version formats', () => {
  test('a name splits on its first dot, and one without a dot is all agent', () => {
    expect(prompt_name_parts('IntentAgent.parse')).toEqual({
      agent: 'IntentAgent',
      function: 'parse',
    });
    expect(prompt_name_parts('summarize')).toEqual({ agent: 'summarize', function: null });
  });

  test('a saved version yields its revision, hash and label', () => {
    expect(version_parts('IntentAgent-parse-0a1b2c3d-v3')).toEqual({
      revision: 3,
      hash: '0a1b2c3d',
      label: 'v3',
    });
  });

  test('a version with a revision but no hash keeps its string as the label', () => {
    expect(version_parts('first-v2')).toEqual({ revision: 2, hash: null, label: 'first-v2' });
  });

  test('a hash-like trailing segment is not a revision', () => {
    expect(version_parts('intent-parse-9abc0000')).toEqual({
      revision: 0,
      hash: null,
      label: 'intent-parse-9abc0000',
    });
  });

  test('the next revision is one past the newest version', () => {
    expect(
      next_revision({ versions: [{ version: 'a-b-00000000-v4', content: '', updated_at: null }] })
    ).toBe(5);
    expect(next_revision({ versions: [] })).toBe(1);
  });
});
