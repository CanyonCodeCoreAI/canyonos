// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { helpers } from './env.helpers';

const env = Bun.env;
const { parseInteger, parseBoolean } = helpers;

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

const API_KEY_HASH = /^[0-9a-f]{64}$/;

/** `CANYONOS_API_KEY_HASH`: the sha256 of the API key in lowercase hex, or null to need no key. */
export function resolveApiKeyHash(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (API_KEY_HASH.test(value)) return value;
  throw new Error(
    'CANYONOS_API_KEY_HASH must be the sha256 of the API key as 64 lowercase hex characters, ' +
      'or empty for no key'
  );
}

const DEVELOPMENT_REDIS_PASSWORD_KEY = 'canyonos-local-development-only-redis-password-key';
const MIN_REDIS_PASSWORD_KEY_LENGTH = 32;

/** The key the API encrypts each project's Redis password with before storing it. Development
 * and test fall back to a fixed key; anywhere else a missing, committed, or short key refuses
 * the start. */
export function resolveRedisPasswordKey(
  key: string | undefined,
  environment: AppEnvironment
): string {
  if (environment === 'development' || environment === 'test') {
    return key || DEVELOPMENT_REDIS_PASSWORD_KEY;
  }
  if (!key || key === DEVELOPMENT_REDIS_PASSWORD_KEY) {
    throw new Error(
      'REDIS_PASSWORD_ENCRYPTION_KEY must be set outside development and test. Generate one with `openssl rand -base64 32`.'
    );
  }
  if (key.length < MIN_REDIS_PASSWORD_KEY_LENGTH) {
    throw new Error(
      `REDIS_PASSWORD_ENCRYPTION_KEY must be at least ${MIN_REDIS_PASSWORD_KEY_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`
    );
  }
  return key;
}

const canyonos = {
  redisHost: env.CANYONOS_REDIS_HOST ?? 'host.docker.internal',
  redisPort: parseInteger(env.CANYONOS_REDIS_PORT, 6379),
  redisPasswordKey: resolveRedisPasswordKey(env.REDIS_PASSWORD_ENCRYPTION_KEY, environment),
  // Kubernetes: the projects (and their Redis) the operator lists for this dashboard.
  projectsFile: env.CANYONOS_PROJECTS_FILE ?? null,
};

const governance = {
  publishIntervalMs: parseInteger(env.GOVERNANCE_PUBLISH_INTERVAL_MS, 60_000),
};

/** A retention period in whole days; zero or less would delete every metric as it arrives. */
function resolveRetentionDays(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a whole number of days, at least 1, got ${value}`);
  }
  return Number(value);
}

const metrics = {
  rawRetentionDays: resolveRetentionDays(
    'METRICS_RAW_RETENTION_DAYS',
    env.METRICS_RAW_RETENTION_DAYS,
    3
  ),
  rollupRetentionDays: resolveRetentionDays(
    'METRICS_ROLLUP_RETENTION_DAYS',
    env.METRICS_ROLLUP_RETENTION_DAYS,
    120
  ),
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
  governance,
  metrics,
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
    apiKeyHash: resolveApiKeyHash(env.CANYONOS_API_KEY_HASH),
  },
};

export type Config = typeof config;
