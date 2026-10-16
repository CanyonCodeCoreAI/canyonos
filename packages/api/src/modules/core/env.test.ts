// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { resolveAppEnvironment, resolveConfiguredEnvironment, resolveDatabaseUrl } from './env';

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
