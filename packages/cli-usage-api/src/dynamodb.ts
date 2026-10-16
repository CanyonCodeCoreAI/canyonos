// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The DynamoDB client of the CLI usage API, built from the service configuration. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

import type { CliUsageConfig } from './config';

const LOCAL_DUMMY_CREDENTIALS = { accessKeyId: 'local', secretAccessKey: 'local' } as const;
const CONNECTION_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;

/**
 * Build the client the API and its tooling use. Local environments get the loopback endpoint
 * and fixed dummy credentials, so the SDK never resolves the developer's AWS profile; production
 * gets the regional HTTPS endpoint and the Lambda's role.
 */
export function createDynamoClient(config: CliUsageConfig): DynamoDBClient {
  const shared: DynamoDBClientConfig = {
    region: config.region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  };
  if (config.dynamodb.kind === 'aws') return new DynamoDBClient({ ...shared, tls: true });
  return new DynamoDBClient({
    ...shared,
    endpoint: config.dynamodb.endpoint,
    credentials: LOCAL_DUMMY_CREDENTIALS,
  });
}
