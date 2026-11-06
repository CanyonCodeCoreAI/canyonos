// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the CLI usage API: the real server over HTTP against a disposable moto
 * server container this file starts, stops, restarts and removes. The bucket is read back with
 * test-owned clients, which the test configuration keeps on the loopback interface.
 */

import { join } from 'node:path';

import { GetObjectCommand, NoSuchKey, paginateListObjectsV2 } from '@aws-sdk/client-s3';
import { $ } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';

import { createAwsClients } from '../src/aws';
import { loadConfig } from '../src/config';
import { MAX_FEEDBACK_MESSAGE_LENGTH } from '../src/feedback.contract';
import { feedback, usageEvent, usageEvents } from '../src/test.fixtures';
import { MAX_REQUEST_BODY_BYTES } from '../src/usage.contract';
import { createBucketAndStream, USAGE_EVENTS_PREFIX, waitForMoto } from '../src/usage.store';
import type { AwsClients } from '../src/aws';
import type { UsageEvent } from '../src/usage.contract';

const PACKAGE_DIR = join(import.meta.dir, '..');
const CONTAINER = `canyonos-cli-usage-e2e-${process.pid}`;
const STREAM = 'canyonos-cli-usage-events-e2e';
const BUCKET = 'canyonos-cli-usage-e2e';

const composeImage = async () => {
  const compose = await Bun.file(join(PACKAGE_DIR, 'docker-compose.yml')).text();
  const image = /^\s*image:\s*(\S+)$/m.exec(compose)?.[1];
  if (!image) throw new Error('docker-compose.yml names no moto image');
  return image;
};

const freePort = () => {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};

const motoPort = freePort();
const apiPort = freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const testEnv = {
  APP_ENV: 'test',
  CLI_USAGE_AWS_ENDPOINT: `http://127.0.0.1:${motoPort}`,
  CLI_USAGE_STREAM_NAME: STREAM,
  CLI_FEEDBACK_BUCKET_NAME: BUCKET,
  CLI_USAGE_PORT: String(apiPort),
};
const testConfig = loadConfig(testEnv);

let clients: AwsClients;
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

const postBody = (body: string, contentType = 'application/json', path = '/usage/events') =>
  fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

const postEvents = (events: unknown[]) => postBody(JSON.stringify({ events }));

const postFeedback = (body: unknown) =>
  postBody(JSON.stringify(body), 'application/json', '/feedback');

const readObject = async (key: string) => {
  const object = await clients.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return (await object.Body?.transformToString()) ?? '';
};

/** Every stored copy of the event with this id, in the order it was stored. */
const storedEvent = async (eventId: string) => {
  const copies: Record<string, unknown>[] = [];
  const pages = paginateListObjectsV2(
    { client: clients.s3 },
    { Bucket: BUCKET, Prefix: USAGE_EVENTS_PREFIX }
  );
  for await (const page of pages) {
    for (const { Key } of page.Contents ?? []) {
      for (const line of (await readObject(Key ?? '')).split('\n').filter(Boolean)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event_id === eventId) copies.push(event);
      }
    }
  }
  return copies;
};

const storedFeedback = async (feedbackId: string) => {
  try {
    return JSON.parse(await readObject(`feedback/${feedbackId}.json`)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
};

const expectStored = async (events: readonly UsageEvent[]) => {
  for (const event of events) {
    expect(await storedEvent(event.event_id)).toEqual([
      { ...event, received_at: expect.any(String) },
    ]);
  }
};

beforeAll(async () => {
  const image = await composeImage();
  await $`docker run -d --name ${CONTAINER} -p 127.0.0.1:${motoPort}:5000 ${image}`.quiet();

  clients = createAwsClients(testConfig);
  await waitForMoto(clients);
  await createBucketAndStream(clients, testConfig);
  await createBucketAndStream(clients, testConfig);

  server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...testEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForApi();
});

const removeServerAndContainer = () => {
  server?.kill();
  clients?.firehose.destroy();
  clients?.s3.destroy();
  Bun.spawnSync(['docker', 'rm', '-f', CONTAINER], { stdout: 'ignore', stderr: 'ignore' });
};

process.on('exit', removeServerAndContainer);
afterAll(removeServerAndContainer);

describe('POST /usage/events against moto', () => {
  test('stores a single event with the time the server received it', async () => {
    const event = usageEvent({ command: 'convert', succeeded: false });
    const before = Date.now();

    const response = await postEvents([event]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 1 });
    const [item] = await storedEvent(event.event_id);
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'cli_version',
      'command',
      'event_id',
      'installation_id',
      'occurred_at',
      'received_at',
      'succeeded',
    ]);
    expect(Date.parse(String(item?.received_at))).toBeGreaterThanOrEqual(before - 1000);
    await expectStored([event]);
  });

  test('stores a full batch', async () => {
    const events = usageEvents(25);

    const response = await postEvents(events);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 25 });
    await expectStored(events);
  });

  test('stores a resent event again under the same event id', async () => {
    const events = usageEvents(3);
    expect(await (await postEvents(events)).json()).toEqual({ stored: 3 });

    const resent = await postEvents([...events, usageEvent()]);

    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({ stored: 4 });
    expect(await storedEvent(events[0]?.event_id ?? '')).toHaveLength(2);
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
    expect(await storedEvent(valid.event_id)).toEqual([]);
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

describe('POST /feedback against moto', () => {
  test('stores feedback without an installation id, stamped with the time received', async () => {
    const sent = feedback();
    const before = Date.now();

    const response = await postFeedback(sent);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: true });
    const item = await storedFeedback(sent.feedback_id);
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'arch',
      'cli_version',
      'feedback_id',
      'message',
      'os',
      'received_at',
    ]);
    expect(item).toMatchObject({ message: sent.message, os: 'Darwin' });
    expect(Date.parse(String(item?.received_at))).toBeGreaterThanOrEqual(before - 1000);
  });

  test('stores the installation id when one is sent', async () => {
    const sent = feedback({ installation_id: usageEvent().installation_id });

    expect((await postFeedback(sent)).status).toBe(200);

    expect((await storedFeedback(sent.feedback_id))?.installation_id).toBe(sent.installation_id);
  });

  test('keeps the first copy of a resent feedback', async () => {
    const sent = feedback();
    expect(await (await postFeedback(sent)).json()).toEqual({ stored: true });

    const resent = await postFeedback({ ...sent, message: 'changed' });

    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({ stored: false });
    expect((await storedFeedback(sent.feedback_id))?.message).toBe(sent.message);
  });

  test('rejects an empty or too long message and fields outside the contract', async () => {
    for (const body of [
      feedback({ message: '' }),
      feedback({ message: 'x'.repeat(MAX_FEEDBACK_MESSAGE_LENGTH + 1) }),
      { ...feedback(), email: 'ana@example.com' },
    ]) {
      expect((await postFeedback(body)).status).toBe(422);
    }
  });

  test('serves no endpoint that reads feedback back', async () => {
    expect((await fetch(`${apiUrl}/feedback`)).status).toBe(404);
  });
});

describe('when the store is unavailable', () => {
  const pending = usageEvents(5);

  test('answers 503 instead of success', async () => {
    expect((await postEvents([usageEvent()])).status).toBe(200);
    await $`docker stop ${CONTAINER}`.quiet();

    const response = await postEvents(pending);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'store_unavailable' });
  });

  test('answers feedback with an error', async () => {
    const response = await postFeedback(feedback());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  // moto keeps its data in memory, so the restarted server starts empty.
  test('stores the resent batch once the store is back', async () => {
    await $`docker start ${CONTAINER}`.quiet();
    await waitForMoto(clients);
    await createBucketAndStream(clients, testConfig);

    const response = await postEvents(pending);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 5 });
    await expectStored(pending);
  });
});
