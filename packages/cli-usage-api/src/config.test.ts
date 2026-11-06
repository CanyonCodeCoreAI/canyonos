// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { loadConfig, LOCAL_DEFAULTS } from './config';

const PRODUCTION = {
  APP_ENV: 'production',
  AWS_REGION: 'us-east-1',
  CLI_USAGE_STREAM_NAME: 'canyonos-cli-usage-events',
  CLI_FEEDBACK_BUCKET_NAME: 'canyonos-cli-usage',
};

describe('loadConfig', () => {
  test('defaults to development against the local moto server', () => {
    expect(loadConfig({})).toEqual({
      environment: 'development',
      streamName: LOCAL_DEFAULTS.streamName,
      feedbackBucketName: LOCAL_DEFAULTS.feedbackBucketName,
      region: LOCAL_DEFAULTS.region,
      aws: { kind: 'local', endpoint: LOCAL_DEFAULTS.awsEndpoint },
      port: LOCAL_DEFAULTS.port,
    });
  });

  test('reads the local endpoint, stream and port', () => {
    const config = loadConfig({
      APP_ENV: 'test',
      CLI_USAGE_AWS_ENDPOINT: 'http://localhost:9010',
      CLI_USAGE_STREAM_NAME: 'usage-e2e',
      CLI_USAGE_PORT: '9787',
    });
    expect(config.aws).toEqual({ kind: 'local', endpoint: 'http://localhost:9010' });
    expect(config.streamName).toBe('usage-e2e');
    expect(config.port).toBe(9787);
  });

  test.each(['development', 'test'])(
    '%s refuses an AWS endpoint outside the loopback interface',
    (env) => {
      for (const endpoint of [
        'https://s3.us-east-1.amazonaws.com',
        'http://10.0.0.5:8000',
        'http://localhost.example.com:8000',
      ]) {
        expect(() => loadConfig({ APP_ENV: env, CLI_USAGE_AWS_ENDPOINT: endpoint })).toThrow(
          /loopback/
        );
      }
    }
  );

  test('refuses an endpoint that is not http or https', () => {
    expect(() => loadConfig({ CLI_USAGE_AWS_ENDPOINT: 'ftp://127.0.0.1:8000' })).toThrow(
      /http or https/
    );
  });

  test('refuses an unknown environment', () => {
    expect(() => loadConfig({ APP_ENV: 'prod' })).toThrow(/APP_ENV/);
  });

  test('refuses an invalid port', () => {
    expect(() => loadConfig({ CLI_USAGE_PORT: '70000' })).toThrow(/CLI_USAGE_PORT/);
  });

  test('production uses the regional AWS endpoints', () => {
    expect(loadConfig(PRODUCTION)).toMatchObject({
      environment: 'production',
      streamName: 'canyonos-cli-usage-events',
      region: 'us-east-1',
      aws: { kind: 'aws' },
    });
  });

  test.each([
    ['CLI_USAGE_AWS_ENDPOINT', 'http://127.0.0.1:8010'],
    ['CLI_USAGE_AWS_ENDPOINT', 'https://s3.example.com'],
    ['AWS_ENDPOINT_URL', 'http://s3.example.com'],
    ['AWS_ENDPOINT_URL_FIREHOSE', 'http://firehose.example.com'],
    ['AWS_ENDPOINT_URL_S3', 'http://s3.example.com'],
  ])('production refuses an endpoint override in %s=%s', (name, value) => {
    expect(() => loadConfig({ ...PRODUCTION, [name]: value })).toThrow(/production/);
  });

  test.each(['CLI_USAGE_STREAM_NAME', 'CLI_FEEDBACK_BUCKET_NAME', 'AWS_REGION'])(
    'production requires %s',
    (name) => {
      expect(() => loadConfig({ ...PRODUCTION, [name]: '' })).toThrow(name);
    }
  );
});
