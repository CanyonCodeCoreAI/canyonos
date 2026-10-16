// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the CLI usage API: the real server over HTTP against a disposable
 * DynamoDB Local container this file starts, stops, restarts and removes. The table is read back
 * with a test-owned client, which the test configuration keeps on the loopback interface.
 */

import { join } from 'node:path';

import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { $ } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Subprocess } from 'bun';

import { loadConfig } from '../src/config';
import { createDynamoClient } from '../src/dynamodb';
import { usageEvent, usageEvents } from '../src/test.fixtures';
import { MAX_REQUEST_BODY_BYTES } from '../src/usage.contract';
import { ensureUsageTable, waitForDynamo } from '../src/usage.table';
import type { UsageEvent } from '../src/usage.contract';

const PACKAGE_DIR = join(import.meta.dir, '..');
const CONTAINER = `canyonos-cli-usage-e2e-${process.pid}`;
const TABLE = 'canyonos-cli-usage-events-e2e';

const composeImage = async () => {
  const compose = await Bun.file(join(PACKAGE_DIR, 'docker-compose.yml')).text();
  const image = /^\s*image:\s*(\S+)$/m.exec(compose)?.[1];
  if (!image) throw new Error('docker-compose.yml names no DynamoDB Local image');
  return image;
};

const freePort = () => {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};

const dynamoPort = freePort();
const apiPort = freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const testEnv = {
  APP_ENV: 'test',
  CLI_USAGE_DYNAMODB_ENDPOINT: `http://127.0.0.1:${dynamoPort}`,
  CLI_USAGE_TABLE_NAME: TABLE,
  CLI_USAGE_PORT: String(apiPort),
};

let dynamo: DynamoDBClient;
let server: Subprocess | undefined;

const waitForApi = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(apiUrl);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`The CLI usage API did not start on ${apiUrl}`);
};

const postBody = (body: string, contentType = 'application/json') =>
  fetch(`${apiUrl}/usage/events`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

const postEvents = (events: unknown[]) => postBody(JSON.stringify({ events }));

const storedItem = async (eventId: string) => {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { event_id: { S: eventId } },
      ConsistentRead: true,
    })
  );
  return Item;
};

const expectStored = async (events: readonly UsageEvent[]) => {
  for (const event of events) {
    const item = await storedItem(event.event_id);
    expect(item).toMatchObject({
      event_id: { S: event.event_id },
      installation_id: { S: event.installation_id },
      command: { S: event.command },
      succeeded: { BOOL: event.succeeded },
      occurred_at: { S: event.occurred_at },
      cli_version: { S: event.cli_version },
    });
  }
};

beforeAll(async () => {
  const image = await composeImage();
  await $`docker run -d --name ${CONTAINER} -p 127.0.0.1:${dynamoPort}:8000 ${image} -jar DynamoDBLocal.jar -sharedDb -dbPath /home/dynamodblocal`.quiet();

  dynamo = createDynamoClient(loadConfig(testEnv));
  await waitForDynamo(dynamo);
  expect(await ensureUsageTable(dynamo, TABLE)).toBe('created');
  expect(await ensureUsageTable(dynamo, TABLE)).toBe('existing');

  server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...testEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForApi();
});

const removeServerAndContainer = () => {
  server?.kill();
  dynamo?.destroy();
  Bun.spawnSync(['docker', 'rm', '-f', CONTAINER], { stdout: 'ignore', stderr: 'ignore' });
};

process.on('exit', removeServerAndContainer);
afterAll(removeServerAndContainer);

describe('POST /usage/events against DynamoDB Local', () => {
  test('stores a single event with the time the server received it', async () => {
    const event = usageEvent({ command: 'build', succeeded: false });
    const before = Date.now();

    const response = await postEvents([event]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 1, duplicates: 0 });
    const item = await storedItem(event.event_id);
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'cli_version',
      'command',
      'event_id',
      'installation_id',
      'occurred_at',
      'received_at',
      'succeeded',
    ]);
    expect(Date.parse(item?.received_at?.S ?? '')).toBeGreaterThanOrEqual(before - 1000);
    await expectStored([event]);
  });

  test('stores a full batch', async () => {
    const events = usageEvents(25);

    const response = await postEvents(events);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 25, duplicates: 0 });
    await expectStored(events);
  });

  test('stores a resent event once and keeps the first copy', async () => {
    const events = usageEvents(3);
    const first = await postEvents(events);
    expect(await first.json()).toEqual({ stored: 3, duplicates: 0 });
    const firstReceivedAt = (await storedItem(events[0]?.event_id ?? ''))?.received_at;

    const resent = await postEvents([...events, usageEvent()]);

    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({ stored: 1, duplicates: 3 });
    expect((await storedItem(events[0]?.event_id ?? ''))?.received_at).toEqual(firstReceivedAt);
  });

  test('stores an event repeated inside one batch once', async () => {
    const event = usageEvent();

    const response = await postEvents([event, event]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 1, duplicates: 1 });
    await expectStored([event]);
  });

  test('rejects a body that is not JSON', async () => {
    const response = await postBody('{"events": [');
    expect(response.status).toBe(400);
  });

  test('rejects a body over the size limit', async () => {
    const response = await postBody(
      JSON.stringify({ events: usageEvents(1), padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES) })
    );
    expect(response.status).toBe(413);
  });

  test('rejects a batch with an unsupported command and stores none of it', async () => {
    const valid = usageEvent();

    const response = await postEvents([valid, { ...usageEvent(), command: 'status' }]);

    expect(response.status).toBe(422);
    expect(await storedItem(valid.event_id)).toBeUndefined();
  });

  test('rejects fields outside the contract', async () => {
    const response = await postEvents([{ ...usageEvent(), username: 'ana' }]);
    expect(response.status).toBe(422);
  });

  test('serves no endpoint that reads the events back', async () => {
    expect((await fetch(`${apiUrl}/usage/events`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/usage/events/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('when DynamoDB is unavailable', () => {
  const earlier = usageEvent();
  const pending = usageEvents(5);

  test('answers 503 instead of success', async () => {
    expect((await postEvents([earlier])).status).toBe(200);
    await $`docker stop ${CONTAINER}`.quiet();

    const response = await postEvents(pending);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'store_unavailable' });
  });

  test('stores the resent batch once DynamoDB is back, keeping the earlier events', async () => {
    await $`docker start ${CONTAINER}`.quiet();
    await waitForDynamo(dynamo);

    const response = await postEvents(pending);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 5, duplicates: 0 });
    await expectStored([earlier, ...pending]);
  });
});
