// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The Firehose and S3 clients of the CLI usage API, built from the service configuration. */

import { FirehoseClient } from '@aws-sdk/client-firehose';
import { S3Client } from '@aws-sdk/client-s3';

import type { CliUsageConfig } from './config';

const LOCAL_DUMMY_CREDENTIALS = { accessKeyId: 'local', secretAccessKey: 'local' } as const;
const CONNECTION_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;

export interface AwsClients {
  readonly firehose: FirehoseClient;
  readonly s3: S3Client;
}

/**
 * Build the clients the API and its tooling use. Local environments get the loopback endpoint
 * and fixed dummy credentials, so the SDK never resolves the developer's AWS profile; production
 * gets the regional HTTPS endpoints and the Lambda's role.
 */
export function createAwsClients(config: CliUsageConfig): AwsClients {
  const shared = {
    region: config.region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  };
  if (config.aws.kind === 'aws') {
    return {
      firehose: new FirehoseClient({ ...shared, tls: true }),
      s3: new S3Client({ ...shared, tls: true }),
    };
  }
  const local = {
    ...shared,
    endpoint: config.aws.endpoint,
    credentials: LOCAL_DUMMY_CREDENTIALS,
    // moto's server stalls a reused connection after it answers with an error.
    requestHandler: { ...shared.requestHandler, httpAgent: { keepAlive: false } },
  };
  return {
    firehose: new FirehoseClient(local),
    s3: new S3Client({ ...local, forcePathStyle: true }),
  };
}
