// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bucket and Firehose stream as `cli:usage:dev` and the end-to-end tests create them in a
 * moto server. The deployed ones are provisioned by infrastructure with the same layout.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { CreateDeliveryStreamCommand, ResourceInUseException } from '@aws-sdk/client-firehose';
import { CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

import type { AwsClients } from './aws';
import type { CliUsageConfig } from './config';

export const USAGE_EVENTS_PREFIX = 'usage-events/';

/** Poll the moto server until it answers, or throw once `timeoutMs` has passed. */
export async function waitForMoto(clients: AwsClients, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await clients.s3.send(new ListBucketsCommand({}));
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`The moto server did not answer within ${timeoutMs} ms`, { cause: error });
      }
      await sleep(250);
    }
  }
}

/** Create the bucket and the usage events stream that writes to it, unless they exist. */
export async function createBucketAndStream(
  clients: AwsClients,
  config: CliUsageConfig
): Promise<void> {
  await clients.s3.send(new CreateBucketCommand({ Bucket: config.feedbackBucketName }));
  try {
    await clients.firehose.send(
      new CreateDeliveryStreamCommand({
        DeliveryStreamName: config.streamName,
        ExtendedS3DestinationConfiguration: {
          RoleARN: 'arn:aws:iam::123456789012:role/canyonos-cli-usage-firehose',
          BucketARN: `arn:aws:s3:::${config.feedbackBucketName}`,
          Prefix: `${USAGE_EVENTS_PREFIX}dt=!{timestamp:yyyy-MM-dd}/`,
          ErrorOutputPrefix:
            'usage-events-errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/',
        },
      })
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
}
