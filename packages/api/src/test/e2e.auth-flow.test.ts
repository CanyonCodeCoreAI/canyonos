import { describe, expect, test } from 'bun:test';

import { UserStatusEnum } from '@api/modules/auth/types';

import { api, setupE2ETests } from './e2e.setup';

setupE2ETests();

const EMAIL = 'tester@cc-forge.test';

describe('auth flow', () => {
  test('challenge -> bypass verify -> profile (OTP dev bypass)', async () => {
    const challenge = await api.auth.challenge.post({ email: EMAIL });
    expect(challenge.error).toBeNull();

    const verify = await api.auth.verify.post({ email: EMAIL, code: '111111' });
    expect(verify.error).toBeNull();
    const token = verify.data?.token;
    expect(typeof token).toBe('string');
    expect(verify.data?.user.email).toBe(EMAIL);

    const profile = await api.auth.profile.get({
      $headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.error).toBeNull();
    expect(profile.data?.email).toBe(EMAIL);
    expect(profile.data?.status).toBe(UserStatusEnum.ONBOARDING);
  });

  test('re-verifying an onboarding user keeps the ONBOARDING status', async () => {
    await api.auth.challenge.post({ email: EMAIL });
    const verify = await api.auth.verify.post({ email: EMAIL, code: '111111' });
    expect(verify.error).toBeNull();
    expect(verify.data?.user.status).toBe(UserStatusEnum.ONBOARDING);
  });

  test('profile without token is rejected', async () => {
    const profile = await api.auth.profile.get();
    expect(profile.error).not.toBeNull();
    expect(profile.error?.status as number).toBe(401);
  });
});

describe('AUTH_MODE=fixed_code accepts any email', () => {
  test.each([
    'anyone@example.com',
    'someone@canyon-code.ai',
    'someone@totally-unrelated-domain.io',
  ])('%s signs in with the fixed code', async (email) => {
    const verify = await api.auth.verify.post({ email, code: '111111' });

    expect(verify.error).toBeNull();
    expect(verify.data?.token).toBeString();
    expect(verify.data?.user.email).toBe(email);
  });
});
