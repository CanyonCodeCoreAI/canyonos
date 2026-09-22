import { describe, expect, test } from 'bun:test';

import {
  assertEmailAuthConfigured,
  resolveAppEnvironment,
  resolveAuthMode,
  resolveConfiguredEnvironment,
  resolveDatabaseUrl,
  resolveDeployLeaseSeconds,
  resolveDeployWorker,
  resolveFileStorage,
} from './env';
import type { EmailAuthRequirements } from './env';

describe('resolveAppEnvironment', () => {
  test('defaults to development when APP_ENV is unset', () => {
    expect(resolveAppEnvironment(undefined)).toBe('development');
    expect(resolveAppEnvironment('')).toBe('development');
  });

  test.each(['development', 'test', 'production', 'demo', 'staging'] as const)(
    'accepts %s',
    (value) => {
      expect(resolveAppEnvironment(value)).toBe(value);
    }
  );

  test('rejects unknown environments', () => {
    expect(() => resolveAppEnvironment('prod')).toThrow(
      'APP_ENV must be one of development, test, production, demo, staging, got prod'
    );
  });
});

describe('resolveConfiguredEnvironment', () => {
  test('falls back to NODE_ENV when APP_ENV is unset', () => {
    expect(resolveConfiguredEnvironment(undefined, 'demo')).toBe('demo');
    expect(resolveConfiguredEnvironment('', 'production')).toBe('production');
  });

  test('uses APP_ENV before NODE_ENV', () => {
    expect(resolveConfiguredEnvironment('demo', 'production')).toBe('demo');
    expect(resolveConfiguredEnvironment('test', 'development')).toBe('test');
  });
});

describe('resolveDeployWorker', () => {
  test.each(['development', 'test', 'demo', 'staging'] as const)(
    '%s defaults to the mock worker',
    (environment) => {
      expect(resolveDeployWorker(environment, undefined)).toBe('mock');
      expect(resolveDeployWorker(environment, 'mock')).toBe('mock');
    }
  );

  test.each(['development', 'test', 'demo', 'staging'] as const)(
    '%s also accepts the external worker and none',
    (environment) => {
      expect(resolveDeployWorker(environment, 'external')).toBe('external');
      expect(resolveDeployWorker(environment, 'none')).toBe('none');
    }
  );

  test('production accepts the external worker and none', () => {
    expect(resolveDeployWorker('production', 'external')).toBe('external');
    expect(resolveDeployWorker('production', 'none')).toBe('none');
  });

  test.each([undefined, 'mock', 'unexpected'])('rejects %p in production', (worker) => {
    expect(() => resolveDeployWorker('production', worker)).toThrow(
      'DEPLOY_WORKER must be set explicitly in production'
    );
  });

  test('requires a known worker outside production', () => {
    expect(() => resolveDeployWorker('development', 'unexpected')).toThrow(
      'Invalid DEPLOY_WORKER: unexpected'
    );
    expect(() => resolveDeployWorker('demo', 'unexpected')).toThrow(
      'Invalid DEPLOY_WORKER: unexpected'
    );
  });
});

describe('resolveFileStorage', () => {
  test('defaults to the mock store', () => {
    expect(resolveFileStorage(undefined)).toBe('mock');
    expect(resolveFileStorage('mock')).toBe('mock');
  });

  test('rejects an unknown store', () => {
    expect(() => resolveFileStorage('unexpected')).toThrow('Invalid FILE_STORAGE: unexpected');
  });
});

describe('resolveAuthMode', () => {
  test.each(['development', 'test'] as const)(
    'defaults to fixed_code when AUTH_MODE is unset in %s',
    (environment) => {
      expect(resolveAuthMode(undefined, environment)).toBe('fixed_code');
      expect(resolveAuthMode('', environment)).toBe('fixed_code');
    }
  );

  test.each(['production', 'demo', 'staging'] as const)(
    'refuses to default in %s — the operator must name the mode',
    (environment) => {
      expect(() => resolveAuthMode(undefined, environment)).toThrow(
        'AUTH_MODE must be set explicitly'
      );
    }
  );

  test.each(['fixed_code', 'email_otp'] as const)('accepts %s in any environment', (value) => {
    expect(resolveAuthMode(value, 'development')).toBe(value);
    expect(resolveAuthMode(value, 'production')).toBe(value);
  });

  test('rejects unknown values instead of silently falling back', () => {
    expect(() => resolveAuthMode('flase', 'development')).toThrow(
      'AUTH_MODE must be one of fixed_code, email_otp, got flase'
    );
  });
});

describe('resolveDatabaseUrl', () => {
  test.each(['development', 'test'] as const)(
    'defaults to the local database when DATABASE_URL is unset in %s',
    (environment) => {
      expect(resolveDatabaseUrl(undefined, environment)).toBe(
        'postgres://canyonos:canyonos@localhost:5432/canyonos'
      );
      expect(resolveDatabaseUrl('', environment)).toBe(
        'postgres://canyonos:canyonos@localhost:5432/canyonos'
      );
    }
  );

  test.each(['production', 'demo', 'staging'] as const)(
    'refuses to default in %s — the operator must name the database',
    (environment) => {
      expect(() => resolveDatabaseUrl(undefined, environment)).toThrow(
        'DATABASE_URL must be set explicitly'
      );
      expect(() => resolveDatabaseUrl('', environment)).toThrow(
        'DATABASE_URL must be set explicitly'
      );
    }
  );

  test('returns the supplied url in any environment', () => {
    const url = 'postgres://someone:secret@db.example:5432/canyonos';
    expect(resolveDatabaseUrl(url, 'development')).toBe(url);
    expect(resolveDatabaseUrl(url, 'production')).toBe(url);
  });
});

describe('assertEmailAuthConfigured', () => {
  const valid: EmailAuthRequirements = {
    authMode: 'email_otp',
    smtpHost: 'localhost',
    smtpPort: '1025',
    authEmailFrom: 'noreply@example.com',
    jwtSecret: 'BSPZ7DiSCd0lyYtFEHYUcVIvV+H3PJz1oiOjSGnU8Bo=',
  };

  test('does nothing under fixed_code, regardless of how incomplete the config is', () => {
    expect(() =>
      assertEmailAuthConfigured({
        authMode: 'fixed_code',
        smtpHost: undefined,
        smtpPort: undefined,
        authEmailFrom: undefined,
        jwtSecret: undefined,
      })
    ).not.toThrow();
  });

  test('passes when every requirement is met', () => {
    expect(() => assertEmailAuthConfigured(valid)).not.toThrow();
  });

  test('requires SMTP_HOST', () => {
    expect(() => assertEmailAuthConfigured({ ...valid, smtpHost: undefined })).toThrow(
      'requires SMTP_HOST'
    );
  });

  test('requires SMTP_PORT', () => {
    expect(() => assertEmailAuthConfigured({ ...valid, smtpPort: undefined })).toThrow(
      'requires SMTP_PORT'
    );
  });

  test('requires AUTH_EMAIL_FROM', () => {
    expect(() => assertEmailAuthConfigured({ ...valid, authEmailFrom: undefined })).toThrow(
      'requires AUTH_EMAIL_FROM'
    );
  });

  test('rejects the self-hosted AUTH_EMAIL_FROM fallback', () => {
    expect(() =>
      assertEmailAuthConfigured({ ...valid, authEmailFrom: 'noreply@canyonos.invalid' })
    ).toThrow('not the self-hosted default');
  });

  test('requires JWT_SECRET', () => {
    expect(() => assertEmailAuthConfigured({ ...valid, jwtSecret: undefined })).toThrow(
      'requires JWT_SECRET'
    );
  });

  test.each(['changeme-generate-with-openssl-rand-base64-32', 'canyonos-smoke-secret'])(
    'rejects the committed example secret %s',
    (secret) => {
      expect(() => assertEmailAuthConfigured({ ...valid, jwtSecret: secret })).toThrow(
        'a committed example secret is set'
      );
    }
  );

  test('rejects an unlisted secret that is too short to resist a guess', () => {
    expect(() => assertEmailAuthConfigured({ ...valid, jwtSecret: 'a-real-secret' })).toThrow(
      'at least 32 characters'
    );
  });
});

describe('resolveDeployLeaseSeconds', () => {
  test('defaults to a lease covering four worker heartbeat intervals', () => {
    expect(resolveDeployLeaseSeconds(undefined)).toBe(60);
  });

  test.each(['45', '60', '120'])('accepts a safe %ss lease', (value) => {
    expect(resolveDeployLeaseSeconds(value)).toBe(Number(value));
  });

  test.each(['0', '44', '45.5', 'invalid'])('rejects unsafe lease %p', (value) => {
    expect(() => resolveDeployLeaseSeconds(value)).toThrow(
      'DEPLOY_LEASE_SECONDS must be an integer >= 45'
    );
  });
});
