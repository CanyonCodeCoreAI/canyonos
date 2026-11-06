// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stores reported usage events by sending each batch to Firehose as one record of JSON lines,
 * which Firehose writes to S3. A resent batch is stored again; readers drop repeats by `event_id`.
 */

import { PutRecordCommand } from '@aws-sdk/client-firehose';
import type { PutRecordCommandOutput } from '@aws-sdk/client-firehose';

import type { UsageEvent, UsageEventsStored } from './usage.contract';

export interface PutRecordSender {
  send(command: PutRecordCommand): Promise<PutRecordCommandOutput>;
}

/** Raised when a batch could not be stored; the CLI keeps and resends it. */
export class UsageStoreUnavailableError extends Error {
  constructor(
    readonly failed: number,
    cause: unknown
  ) {
    super(`${failed} usage event(s) could not be stored`, { cause });
    this.name = 'UsageStoreUnavailableError';
  }
}

export interface UsageRepository {
  storeEvents(events: readonly UsageEvent[], receivedAt: string): Promise<UsageEventsStored>;
}

/**
 * Build the repository over `client` and `streamName`. The batch succeeds only when Firehose
 * accepts its record; otherwise it throws `UsageStoreUnavailableError`.
 */
export function createUsageRepository(
  client: PutRecordSender,
  streamName: string
): UsageRepository {
  return {
    async storeEvents(events, receivedAt) {
      const lines = events
        .map((event) => `${JSON.stringify({ ...event, received_at: receivedAt })}\n`)
        .join('');
      try {
        await client.send(
          new PutRecordCommand({
            DeliveryStreamName: streamName,
            Record: { Data: new TextEncoder().encode(lines) },
          })
        );
      } catch (error) {
        throw new UsageStoreUnavailableError(events.length, error);
      }
      return { stored: events.length };
    },
  };
}
