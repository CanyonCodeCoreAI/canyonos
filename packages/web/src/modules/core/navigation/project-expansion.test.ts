import { describe, expect, test } from 'bun:test';

import { createProjectExpansionState, reduceProjectExpansion } from './project-expansion';

describe('project expansion', () => {
  test('starts open only when the project is initially active', () => {
    expect(createProjectExpansionState(true).is_open).toBe(true);
    expect(createProjectExpansionState(false).is_open).toBe(false);
  });

  test.each(['mouse', 'keyboard'])('honors a %s-triggered semantic close while active', () => {
    const closed = reduceProjectExpansion(createProjectExpansionState(true), {
      type: 'open_changed',
      is_open: false,
    });
    expect(closed).toEqual({ is_open: false, is_active: true });
    expect(reduceProjectExpansion(closed, { type: 'activation_changed', is_active: true })).toEqual(
      closed
    );
  });

  test('auto-opens when navigation activates the project again', () => {
    const inactive = reduceProjectExpansion(
      { is_open: false, is_active: true },
      { type: 'activation_changed', is_active: false }
    );
    expect(inactive).toEqual({ is_open: false, is_active: false });
    expect(
      reduceProjectExpansion(inactive, { type: 'activation_changed', is_active: true })
    ).toEqual({ is_open: true, is_active: true });
  });
});
