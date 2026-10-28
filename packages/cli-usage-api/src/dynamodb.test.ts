// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { loadConfig } from './config';
import { createDynamoClient } from './dynamodb';

describe('createDynamoClient', () => {
  test('a local client uses the loopback endpoint and dummy credentials, not an AWS profile', async () => {
    const client = createDynamoClient(
      loadConfig({ APP_ENV: 'test', CLI_USAGE_DYNAMODB_ENDPOINT: 'http://127.0.0.1:8011' })
    );

    const endpoint = await client.config.endpoint?.();
    const credentials = await client.config.credentials();

    expect(endpoint?.hostname).toBe('127.0.0.1');
    expect(endpoint?.port).toBe(8011);
    expect(endpoint?.protocol).toBe('http:');
    expect(credentials).toMatchObject({ accessKeyId: 'local', secretAccessKey: 'local' });
    client.destroy();
  });

  test('a production client keeps the regional endpoint and requires TLS', () => {
    const client = createDynamoClient(
      loadConfig({
        APP_ENV: 'production',
        AWS_REGION: 'eu-west-1',
        CLI_USAGE_TABLE_NAME: 'canyonos-cli-usage-events',
        CLI_FEEDBACK_TABLE_NAME: 'canyonos-cli-feedback',
      })
    );

    expect(client.config.endpoint).toBeUndefined();
    expect(client.config.tls).toBe(true);
    client.destroy();
  });
});
