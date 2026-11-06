// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configuration of the CLI usage API. Every environment variable the service reads is read here.
 * Production talks to AWS Firehose and S3 over HTTPS with the Lambda's role; every other
 * environment talks to a moto server on the loopback interface with dummy credentials, so neither
 * a developer's AWS profile nor a test can ever reach a real stream or bucket.
 */

const APP_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SDK_ENDPOINT_OVERRIDES = [
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_FIREHOSE',
  'AWS_ENDPOINT_URL_S3',
] as const;

export const LOCAL_DEFAULTS = {
  streamName: 'canyonos-cli-usage-events',
  feedbackBucketName: 'canyonos-cli-usage',
  region: 'us-east-1',
  awsEndpoint: 'http://127.0.0.1:8010',
  port: 8787,
} as const;

export type AwsTarget = { kind: 'aws' } | { kind: 'local'; endpoint: string };

export interface CliUsageConfig {
  readonly environment: AppEnvironment;
  readonly streamName: string;
  readonly feedbackBucketName: string;
  readonly region: string;
  readonly aws: AwsTarget;
  readonly port: number;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

function resolveEnvironment(value: string | undefined): AppEnvironment {
  if (value === undefined) return 'development';
  if ((APP_ENVIRONMENTS as readonly string[]).includes(value)) return value as AppEnvironment;
  throw new Error(`APP_ENV must be one of ${APP_ENVIRONMENTS.join(', ')}, got ${value}`);
}

function resolvePort(value: string | undefined): number {
  if (value === undefined) return LOCAL_DEFAULTS.port;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CLI_USAGE_PORT must be a TCP port number, got ${value}`);
  }
  return port;
}

function requireLoopbackEndpoint(value: string, environment: AppEnvironment): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CLI_USAGE_AWS_ENDPOINT is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`CLI_USAGE_AWS_ENDPOINT must use http or https, got ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `APP_ENV=${environment} only talks to a moto server on the loopback interface; ` +
        `CLI_USAGE_AWS_ENDPOINT points at ${url.hostname}.`
    );
  }
  return url.origin;
}

function loadProductionConfig(env: EnvSource): CliUsageConfig {
  if (present(env.CLI_USAGE_AWS_ENDPOINT)) {
    throw new Error(
      'APP_ENV=production uses the regional AWS endpoints over HTTPS; ' +
        'unset CLI_USAGE_AWS_ENDPOINT.'
    );
  }
  const sdkOverride = SDK_ENDPOINT_OVERRIDES.find((name) => present(env[name]));
  if (sdkOverride) {
    throw new Error(`APP_ENV=production refuses an endpoint override; unset ${sdkOverride}.`);
  }
  const streamName = present(env.CLI_USAGE_STREAM_NAME);
  if (!streamName) throw new Error('APP_ENV=production requires CLI_USAGE_STREAM_NAME.');
  const feedbackBucketName = present(env.CLI_FEEDBACK_BUCKET_NAME);
  if (!feedbackBucketName) throw new Error('APP_ENV=production requires CLI_FEEDBACK_BUCKET_NAME.');
  const region = present(env.AWS_REGION);
  if (!region) throw new Error('APP_ENV=production requires AWS_REGION.');
  return {
    environment: 'production',
    streamName,
    feedbackBucketName,
    region,
    aws: { kind: 'aws' },
    port: resolvePort(present(env.CLI_USAGE_PORT)),
  };
}

/**
 * Read the service configuration from the environment (the process environment by default) and
 * throw when it is unsafe or incomplete, so a misconfigured server or Lambda fails at startup.
 */
export function loadConfig(env: EnvSource = process.env): CliUsageConfig {
  const environment = resolveEnvironment(present(env.APP_ENV));
  if (environment === 'production') return loadProductionConfig(env);
  return {
    environment,
    streamName: present(env.CLI_USAGE_STREAM_NAME) ?? LOCAL_DEFAULTS.streamName,
    feedbackBucketName: present(env.CLI_FEEDBACK_BUCKET_NAME) ?? LOCAL_DEFAULTS.feedbackBucketName,
    region: LOCAL_DEFAULTS.region,
    aws: {
      kind: 'local',
      endpoint: requireLoopbackEndpoint(
        present(env.CLI_USAGE_AWS_ENDPOINT) ?? LOCAL_DEFAULTS.awsEndpoint,
        environment
      ),
    },
    port: resolvePort(present(env.CLI_USAGE_PORT)),
  };
}
