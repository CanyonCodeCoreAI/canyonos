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

const AUTH_MODES = ['fixed_code', 'email_otp'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function resolveAuthMode(value: string | undefined, environment: AppEnvironment): AuthMode {
  if (value === undefined || value === '') {
    if (environment === 'development' || environment === 'test') return 'fixed_code';
    throw new Error(
      `AUTH_MODE must be set explicitly (${AUTH_MODES.join(' or ')}) outside development and test; refusing to default to a fixed-code sign-in on a ${environment} environment.`
    );
  }
  if ((AUTH_MODES as readonly string[]).includes(value)) return value as AuthMode;
  throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join(', ')}, got ${value}`);
}

const authMode = resolveAuthMode(env.AUTH_MODE, environment);

const DEFAULT_AUTH_EMAIL_FROM = 'noreply@canyonos.invalid';
const KNOWN_EXAMPLE_JWT_SECRETS = new Set([
  'changeme-generate-with-openssl-rand-base64-32', // .env.example
  'canyonos-smoke-secret', // .docker/canyonos-smoke.compose.yml
]);
const MIN_JWT_SECRET_LENGTH = 32;

export interface EmailAuthRequirements {
  readonly authMode: AuthMode;
  readonly smtpHost: string | undefined;
  readonly smtpPort: string | undefined;
  readonly authEmailFrom: string | undefined;
  readonly jwtSecret: string | undefined;
}

export function assertEmailAuthConfigured(requirements: EmailAuthRequirements): void {
  if (requirements.authMode !== 'email_otp') return;

  if (!requirements.smtpHost) {
    throw new Error('AUTH_MODE=email_otp requires SMTP_HOST to be set.');
  }
  if (!requirements.smtpPort) {
    throw new Error('AUTH_MODE=email_otp requires SMTP_PORT to be set.');
  }
  if (!requirements.authEmailFrom) {
    throw new Error('AUTH_MODE=email_otp requires AUTH_EMAIL_FROM to be set.');
  }
  if (requirements.authEmailFrom === DEFAULT_AUTH_EMAIL_FROM) {
    throw new Error(
      `AUTH_MODE=email_otp requires a real AUTH_EMAIL_FROM address, not the self-hosted default (${DEFAULT_AUTH_EMAIL_FROM}).`
    );
  }
  if (!requirements.jwtSecret) {
    throw new Error('AUTH_MODE=email_otp requires JWT_SECRET to be set.');
  }
  if (KNOWN_EXAMPLE_JWT_SECRETS.has(requirements.jwtSecret)) {
    throw new Error(
      'AUTH_MODE=email_otp requires a real JWT_SECRET; a committed example secret is set. Generate one with `openssl rand -base64 32`.'
    );
  }
  if (requirements.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `AUTH_MODE=email_otp requires a JWT_SECRET of at least ${MIN_JWT_SECRET_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`
    );
  }
}

assertEmailAuthConfigured({
  authMode,
  smtpHost: env.SMTP_HOST,
  smtpPort: env.SMTP_PORT,
  authEmailFrom: env.AUTH_EMAIL_FROM,
  jwtSecret: env.JWT_SECRET,
});

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
  email:
    authMode === 'email_otp'
      ? {
          enabled: true as const,
          smtpHost: requireEnv('SMTP_HOST'),
          smtpPort: parseInteger(env.SMTP_PORT, 1025),
          smtpUsername: env.SMTP_USERNAME ?? '',
          smtpPassword: env.SMTP_PASSWORD ?? '',
          secure: parseBoolean(env.SMTP_SECURE, false),
        }
      : { enabled: false as const },
  auth: {
    mode: authMode,
    jwtSecret: requireEnv('JWT_SECRET'),
    jwtIssuer: env.JWT_ISSUER ?? 'canyonos-api',
    jwtAudience: env.JWT_AUDIENCE ?? 'canyonos-clients',
    jwtTtlSeconds: parseDuration(env.JWT_TTL, 60 * 60 * 24),
    challengeTtlSeconds: parseDuration(env.AUTH_CHALLENGE_TTL, 60 * 15),
    lockDurationSeconds: parseDuration(env.AUTH_LOCK_DURATION, 60 * 60),
    codeLength: parseInteger(env.AUTH_CODE_LENGTH, 6),
    emailFrom:
      authMode === 'email_otp'
        ? requireEnv('AUTH_EMAIL_FROM')
        : (env.AUTH_EMAIL_FROM ?? DEFAULT_AUTH_EMAIL_FROM),
  },
};

export type Config = typeof config;
