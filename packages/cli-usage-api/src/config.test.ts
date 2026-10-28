// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { loadConfig, LOCAL_DEFAULTS } from './config';

const PRODUCTION = {
  APP_ENV: 'production',
  AWS_REGION: 'us-east-1',
  CLI_USAGE_TABLE_NAME: 'canyonos-cli-usage-events',
  CLI_FEEDBACK_TABLE_NAME: 'canyonos-cli-feedback',
};

describe('loadConfig', () => {
  test('defaults to development against the local DynamoDB', () => {
    expect(loadConfig({})).toEqual({
      environment: 'development',
      tableName: LOCAL_DEFAULTS.tableName,
      feedbackTableName: LOCAL_DEFAULTS.feedbackTableName,
      region: LOCAL_DEFAULTS.region,
      dynamodb: { kind: 'local', endpoint: LOCAL_DEFAULTS.dynamodbEndpoint },
      port: LOCAL_DEFAULTS.port,
    });
  });

  test('reads the local endpoint, table and port', () => {
    const config = loadConfig({
      APP_ENV: 'test',
      CLI_USAGE_DYNAMODB_ENDPOINT: 'http://localhost:9010',
      CLI_USAGE_TABLE_NAME: 'usage-e2e',
      CLI_USAGE_PORT: '9787',
    });
    expect(config.dynamodb).toEqual({ kind: 'local', endpoint: 'http://localhost:9010' });
    expect(config.tableName).toBe('usage-e2e');
    expect(config.port).toBe(9787);
  });

  test.each(['development', 'test'])(
    '%s refuses a DynamoDB outside the loopback interface',
    (env) => {
      for (const endpoint of [
        'https://dynamodb.us-east-1.amazonaws.com',
        'http://10.0.0.5:8000',
        'http://localhost.example.com:8000',
      ]) {
        expect(() => loadConfig({ APP_ENV: env, CLI_USAGE_DYNAMODB_ENDPOINT: endpoint })).toThrow(
          /loopback/
        );
      }
    }
  );

  test('refuses an endpoint that is not http or https', () => {
    expect(() => loadConfig({ CLI_USAGE_DYNAMODB_ENDPOINT: 'ftp://127.0.0.1:8000' })).toThrow(
      /http or https/
    );
  });

  test('refuses an unknown environment', () => {
    expect(() => loadConfig({ APP_ENV: 'prod' })).toThrow(/APP_ENV/);
  });

  test('refuses an invalid port', () => {
    expect(() => loadConfig({ CLI_USAGE_PORT: '70000' })).toThrow(/CLI_USAGE_PORT/);
  });

  test('production uses the regional AWS endpoint', () => {
    expect(loadConfig(PRODUCTION)).toMatchObject({
      environment: 'production',
      tableName: 'canyonos-cli-usage-events',
      region: 'us-east-1',
      dynamodb: { kind: 'aws' },
    });
  });

  test.each([
    ['CLI_USAGE_DYNAMODB_ENDPOINT', 'http://127.0.0.1:8010'],
    ['CLI_USAGE_DYNAMODB_ENDPOINT', 'https://dynamodb.example.com'],
    ['AWS_ENDPOINT_URL', 'http://dynamodb.example.com'],
    ['AWS_ENDPOINT_URL_DYNAMODB', 'http://dynamodb.example.com'],
  ])('production refuses an endpoint override in %s=%s', (name, value) => {
    expect(() => loadConfig({ ...PRODUCTION, [name]: value })).toThrow(/production/);
  });

  test.each(['CLI_USAGE_TABLE_NAME', 'CLI_FEEDBACK_TABLE_NAME', 'AWS_REGION'])(
    'production requires %s',
    (name) => {
      expect(() => loadConfig({ ...PRODUCTION, [name]: '' })).toThrow(name);
    }
  );
});
