// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stores reported usage events in DynamoDB, one item per `event_id`. A retried batch is safe:
 * an event that is already stored counts as a duplicate, not a failure.
 */

import { ConditionalCheckFailedException, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { PutItemCommandOutput } from '@aws-sdk/client-dynamodb';

import type { UsageEvent, UsageEventsStored } from './usage.contract';

export const USAGE_TABLE_PARTITION_KEY = 'event_id';

export interface PutItemSender {
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

/** Raised when at least one event of a batch could not be stored; the CLI keeps and resends it. */
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

const toItem = (event: UsageEvent, receivedAt: string) => ({
  event_id: { S: event.event_id },
  installation_id: { S: event.installation_id },
  command: { S: event.command },
  succeeded: { BOOL: event.succeeded },
  occurred_at: { S: event.occurred_at },
  cli_version: { S: event.cli_version },
  received_at: { S: receivedAt },
});

/**
 * Build the repository over `client` and `tableName`. Each event is written with its own
 * conditional put, all of a batch at once: BatchWriteItem cannot carry a condition, and a
 * transaction would cancel the whole batch over a single already-stored event. The batch
 * succeeds only when every event is stored or already was; otherwise it throws
 * `UsageStoreUnavailableError`, and the events that did land are skipped on the resend.
 */
export function createUsageRepository(client: PutItemSender, tableName: string): UsageRepository {
  const putIfAbsent = async (event: UsageEvent, receivedAt: string) => {
    try {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: toItem(event, receivedAt),
          ConditionExpression: 'attribute_not_exists(#event_id)',
          ExpressionAttributeNames: { '#event_id': USAGE_TABLE_PARTITION_KEY },
        })
      );
      return 'stored' as const;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return 'duplicate' as const;
      throw error;
    }
  };

  return {
    async storeEvents(events, receivedAt) {
      const outcomes = await Promise.allSettled(
        events.map((event) => putIfAbsent(event, receivedAt))
      );
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (failures.length > 0) {
        throw new UsageStoreUnavailableError(failures.length, failures[0]?.reason);
      }
      const stored = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled' && outcome.value === 'stored'
      ).length;
      return { stored, duplicates: events.length - stored };
    },
  };
}
