// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { describe, expect, test } from 'bun:test';
import type { PutItemCommand, PutItemCommandOutput } from '@aws-sdk/client-dynamodb';

import { usageEvent, usageEvents } from './test.fixtures';
import { createUsageRepository, UsageStoreUnavailableError } from './usage.repository';
import type { PutItemSender } from './usage.repository';

const TABLE = 'usage-events-test';
const RECEIVED_AT = '2026-10-08T12:00:05.000Z';

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

/** A stand-in for DynamoDB that keeps items by `event_id` and honours the put condition. */
const fakeTable = (failFor: ReadonlySet<string> = new Set()) => {
  const items = new Map<string, PutItemCommand['input']['Item']>();
  const commands: PutItemCommand[] = [];
  const client: PutItemSender = {
    async send(command): Promise<PutItemCommandOutput> {
      commands.push(command);
      const eventId = command.input.Item?.event_id?.S ?? '';
      if (failFor.has(eventId)) throw new Error('ProvisionedThroughputExceeded');
      if (items.has(eventId)) throw conditionFailed();
      items.set(eventId, command.input.Item);
      return { $metadata: {} };
    },
  };
  return { client, items, commands };
};

describe('createUsageRepository', () => {
  test('writes each event as a conditional put keyed on event_id', async () => {
    const { client, commands } = fakeTable();
    const event = usageEvent({ succeeded: false });

    await createUsageRepository(client, TABLE).storeEvents([event], RECEIVED_AT);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toEqual({
      TableName: TABLE,
      Item: {
        event_id: { S: event.event_id },
        installation_id: { S: event.installation_id },
        command: { S: event.command },
        succeeded: { BOOL: false },
        occurred_at: { S: event.occurred_at },
        cli_version: { S: event.cli_version },
        received_at: { S: RECEIVED_AT },
      },
      ConditionExpression: 'attribute_not_exists(#event_id)',
      ExpressionAttributeNames: { '#event_id': 'event_id' },
    });
  });

  test('counts an event that is already stored as a duplicate and keeps the first copy', async () => {
    const { client, items } = fakeTable();
    const repository = createUsageRepository(client, TABLE);
    const events = usageEvents(3);

    expect(await repository.storeEvents(events.slice(0, 1), RECEIVED_AT)).toEqual({
      stored: 1,
      duplicates: 0,
    });
    expect(await repository.storeEvents(events, '2026-10-09T00:00:00.000Z')).toEqual({
      stored: 2,
      duplicates: 1,
    });
    expect(items.size).toBe(3);
    expect(items.get(events[0]?.event_id ?? '')?.received_at).toEqual({ S: RECEIVED_AT });
  });

  test('fails the whole batch when any event cannot be stored, after trying every event', async () => {
    const events = usageEvents(4);
    const { client, items } = fakeTable(new Set([events[2]?.event_id ?? '']));

    const failure = await createUsageRepository(client, TABLE)
      .storeEvents(events, RECEIVED_AT)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageStoreUnavailableError);
    expect(failure).toMatchObject({ failed: 1 });
    expect(items.size).toBe(3);
  });

  test('a resend after a partial failure stores only what was missing', async () => {
    const events = usageEvents(3);
    const failing = new Set([events[1]?.event_id ?? '']);
    const { client, items } = fakeTable(failing);
    const repository = createUsageRepository(client, TABLE);

    await repository.storeEvents(events, RECEIVED_AT).catch(() => undefined);
    failing.clear();

    expect(await repository.storeEvents(events, RECEIVED_AT)).toEqual({
      stored: 1,
      duplicates: 2,
    });
    expect(items.size).toBe(3);
  });
});
