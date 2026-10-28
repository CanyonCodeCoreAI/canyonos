// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { AUTH_MODES } from '@api/modules/auth/types';
import type { AuthMode } from '@api/modules/auth/types';

import { helpers } from './env.helpers';

const env = Bun.env;
const { parseInteger, parseBoolean, parseDuration, requireEnv } = helpers;

const APP_ENVIRONMENTS = ['development', 'test', 'production', 'demo', 'staging'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export function resolveAppEnvironment(value: string | undefined): AppEnvironment {
  if (value === undefined || value === '') return 'development';
  if ((APP_ENVIRONMENTS as readonly string[]).includes(value)) return value as AppEnvironment;
  throw new Error(`APP_ENV must be one of ${APP_ENVIRONMENTS.join(', ')}, got ${value}`);
}

export function resolveConfiguredEnvironment(
  appEnv: string | undefined,
  nodeEnv: string | undefined
): AppEnvironment {
  return resolveAppEnvironment(appEnv || nodeEnv);
}

const environment = resolveConfiguredEnvironment(env.APP_ENV, env.NODE_ENV);

export function resolveAuthMode(value: string | undefined): AuthMode {
  if (value === undefined || value === '') return 'none';
  if ((AUTH_MODES as readonly string[]).includes(value)) return value as AuthMode;
  throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join(', ')}, got ${value}`);
}

const authMode = resolveAuthMode(env.AUTH_MODE);

const EXAMPLE_JWT_SECRET = 'changeme-generate-with-openssl-rand-base64-32';
const MIN_JWT_SECRET_LENGTH = 32;

/** Outside development and test, refuses the committed example secret and short secrets. */
export function assertJwtSecret(secret: string | undefined, environment: AppEnvironment): void {
  if (environment === 'development' || environment === 'test' || !secret) return;
  if (secret === EXAMPLE_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is the committed example secret. Generate one with `openssl rand -base64 32`.'
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`
    );
  }
}

if (authMode === 'password') assertJwtSecret(env.JWT_SECRET, environment);

const canyonos = {
  redisHost: env.CANYONOS_REDIS_HOST ?? 'host.docker.internal',
  redisPort: parseInteger(env.CANYONOS_REDIS_PORT, 6379),
};

const LOCAL_DATABASE_URL = 'postgres://canyonos:canyonos@localhost:5432/canyonos';

export function resolveDatabaseUrl(value: string | undefined, environment: AppEnvironment): string {
  if (value === undefined || value === '') {
    if (environment === 'development' || environment === 'test') return LOCAL_DATABASE_URL;
    throw new Error(
      `DATABASE_URL must be set explicitly outside development and test; refusing to default to a local database on a ${environment} environment.`
    );
  }
  return value;
}

export const config = {
  environment,
  canyonos,
  isDevelopment: environment === 'development',
  isProduction: environment === 'production',
  isDemo: environment === 'demo',
  isStaging: environment === 'staging',
  isTest: environment === 'test',
  app: {
    port: parseInteger(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    apiUrl: env.API_URL ?? 'http://localhost:3000',
  },
  web: {
    publicUrl: env.WEB_PUBLIC_URL ?? 'http://localhost:5173',
  },
  database: {
    url: resolveDatabaseUrl(env.DATABASE_URL, environment),
  },
  seed: {
    devData: parseBoolean(env.SEED_DEV_DATA, false),
  },
  auth: {
    mode: authMode,
    jwtSecret: authMode === 'password' ? requireEnv('JWT_SECRET') : (env.JWT_SECRET ?? ''),
    jwtIssuer: env.JWT_ISSUER ?? 'canyonos-api',
    jwtAudience: env.JWT_AUDIENCE ?? 'canyonos-clients',
    jwtTtlSeconds: parseDuration(env.JWT_TTL, 60 * 60 * 24),
  },
};

export type Config = typeof config;
