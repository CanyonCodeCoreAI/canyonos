import { describe, expect, test } from 'bun:test';

import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';

setupE2ETests();

describe('AUTH_MODE=email_otp surfaces a mail delivery failure', () => {
  test('the suite runs with an unreachable SMTP port', () => {
    expect(config.auth.mode).toBe('email_otp');
    expect(config.email.smtpPort).toBe(1);
  });

  test('POST /auth/challenge returns 502 when the verification email cannot be sent', async () => {
    const challenge = await api.auth.challenge.post({ email: 'mail-failure@canyonos.test' });

    expect(challenge.error?.status as number).toBe(502);
  });
});
