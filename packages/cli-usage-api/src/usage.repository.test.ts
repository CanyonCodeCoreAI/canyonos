// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import type { PutRecordCommand, PutRecordCommandOutput } from '@aws-sdk/client-firehose';

import { usageEvent, usageEvents } from './test.fixtures';
import { createUsageRepository, UsageStoreUnavailableError } from './usage.repository';
import type { PutRecordSender } from './usage.repository';

const STREAM = 'usage-events-test';
const RECEIVED_AT = '2026-10-08T12:00:05.000Z';

/** A stand-in for Firehose that records each command, or fails every one. */
const fakeStream = (fail = false) => {
  const commands: PutRecordCommand[] = [];
  const client: PutRecordSender = {
    async send(command): Promise<PutRecordCommandOutput> {
      commands.push(command);
      if (fail) throw new Error('ServiceUnavailableException');
      return { RecordId: 'record-1', $metadata: {} };
    },
  };
  return { client, commands };
};

describe('createUsageRepository', () => {
  test('sends the batch as one record of JSON lines stamped with the time received', async () => {
    const { client, commands } = fakeStream();
    const events = [usageEvent({ succeeded: false }), usageEvent()];

    const result = await createUsageRepository(client, STREAM).storeEvents(events, RECEIVED_AT);

    expect(result).toEqual({ stored: 2 });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.DeliveryStreamName).toBe(STREAM);
    const data = new TextDecoder().decode(commands[0]?.input.Record?.Data);
    expect(data.endsWith('\n')).toBe(true);
    expect(
      data
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual(events.map((event) => ({ ...event, received_at: RECEIVED_AT })));
  });

  test('fails the whole batch when Firehose does not accept it', async () => {
    const { client } = fakeStream(true);

    const failure = await createUsageRepository(client, STREAM)
      .storeEvents(usageEvents(4), RECEIVED_AT)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageStoreUnavailableError);
    expect(failure).toMatchObject({ failed: 4 });
  });
});
