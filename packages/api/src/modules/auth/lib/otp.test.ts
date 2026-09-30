import { describe, expect, test } from 'bun:test';

import { FIXED_LOGIN_CODE, isFixedCodeSignIn } from './otp';

describe('isFixedCodeSignIn', () => {
  test('the fixed code passes under fixed_code, whatever address was typed', () => {
    expect(isFixedCodeSignIn('fixed_code', FIXED_LOGIN_CODE)).toBe(true);
  });

  test('a wrong code fails under fixed_code', () => {
    expect(isFixedCodeSignIn('fixed_code', '222222')).toBe(false);
    expect(isFixedCodeSignIn('fixed_code', '')).toBe(false);
  });

  test('the fixed code never passes under email_otp — no bypass of any kind', () => {
    expect(isFixedCodeSignIn('email_otp', FIXED_LOGIN_CODE)).toBe(false);
  });
});
