// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { createApp } from './app';
import { usageEvent, usageEvents } from './test.fixtures';
import { MAX_EVENTS_PER_BATCH, MAX_REQUEST_BODY_BYTES, REPORTED_COMMANDS } from './usage.contract';
import { UsageStoreUnavailableError } from './usage.repository';
import type { UsageEvent } from './usage.contract';
import type { UsageRepository } from './usage.repository';

const RECEIVED_AT = new Date('2026-10-08T12:00:05.000Z');

const recordingRepository = () => {
  const calls: { events: readonly UsageEvent[]; receivedAt: string }[] = [];
  const repository: UsageRepository = {
    async storeEvents(events, receivedAt) {
      calls.push({ events, receivedAt });
      return { stored: events.length, duplicates: 0 };
    },
  };
  return { calls, repository };
};

const failingRepository: UsageRepository = {
  storeEvents: async () => {
    throw new UsageStoreUnavailableError(1, new Error('connection refused'));
  },
};

const appWith = (repository: UsageRepository) => createApp({ repository, now: () => RECEIVED_AT });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/usage/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const send = async (request: Request, repository = recordingRepository().repository) => {
  const response = await appWith(repository).handle(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('POST /usage/events', () => {
  test('stores a batch and stamps the time the server received it', async () => {
    const { calls, repository } = recordingRepository();
    const events = usageEvents(2);

    const { status, body } = await send(post({ events }), repository);

    expect(status).toBe(200);
    expect(body).toEqual({ stored: 2, duplicates: 0 });
    expect(calls).toEqual([{ events, receivedAt: RECEIVED_AT.toISOString() }]);
  });

  test('accepts every reported command', async () => {
    const events = REPORTED_COMMANDS.map((command) => usageEvent({ command }));
    expect((await send(post({ events }))).status).toBe(200);
  });

  test(`accepts up to ${MAX_EVENTS_PER_BATCH} events and rejects more`, async () => {
    expect((await send(post({ events: usageEvents(MAX_EVENTS_PER_BATCH) }))).status).toBe(200);
    const tooMany = await send(post({ events: usageEvents(MAX_EVENTS_PER_BATCH + 1) }));
    expect(tooMany.status).toBe(422);
  });

  test('rejects an empty batch', async () => {
    expect((await send(post({ events: [] }))).status).toBe(422);
  });

  test.each([
    ['a command that is not reported', { command: 'status' }],
    ['an unknown command', { command: 'rm -rf' }],
    ['a UUID that is not v4', { event_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }],
    ['an uppercase UUID', { installation_id: '5B0C3F1E-8D2A-4C7B-9E1F-2A3B4C5D6E7F' }],
    ['a datetime with an offset', { occurred_at: '2026-10-08T12:00:00+02:00' }],
    ['a date without a time', { occurred_at: '2026-10-08' }],
    ['a version that is not semver', { cli_version: 'development' }],
    ['a version that is too long', { cli_version: `1.2.3-${'a'.repeat(64)}` }],
    ['a succeeded flag that is not a boolean', { succeeded: 'true' }],
  ])('rejects an event with %s', async (_, overrides) => {
    const { calls, repository } = recordingRepository();
    const { status, body } = await send(
      post({ events: [{ ...usageEvent(), ...overrides }] }),
      repository
    );

    expect(status).toBe(422);
    expect(body.error).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });

  test('rejects fields outside the contract', async () => {
    const withHostname = { ...usageEvent(), hostname: 'laptop.local' };
    expect((await send(post({ events: [withHostname] }))).status).toBe(422);
    expect((await send(post({ events: usageEvents(1), user: 'ana' }))).status).toBe(422);
  });

  test('rejects an event missing a field', async () => {
    const { cli_version: _, ...withoutVersion } = usageEvent();
    expect((await send(post({ events: [withoutVersion] }))).status).toBe(422);
  });

  test('rejects a body over the size limit by its declared length', async () => {
    const { status, body } = await send(
      post({ events: usageEvents(1) }, { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) })
    );
    expect(status).toBe(413);
    expect(body.error).toBe('payload_too_large');
  });

  test('rejects a streamed body once it passes the size limit', async () => {
    const chunk = new TextEncoder().encode(' '.repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > MAX_REQUEST_BODY_BYTES * 2) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request('http://localhost/usage/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
    });

    expect((await send(request)).status).toBe(413);
  });

  test('rejects a body that is not JSON', async () => {
    const { status, body } = await send(post('{"events": ['));
    expect(status).toBe(400);
    expect(body.error).toBe('malformed_body');
  });

  test('rejects a content type other than JSON', async () => {
    const { status } = await send(post('events=1', { 'content-type': 'text/plain' }));
    expect(status).toBe(415);
  });

  test('answers 503 and no success when the events cannot be stored', async () => {
    const { status, body } = await send(post({ events: usageEvents(3) }), failingRepository);
    expect(status).toBe(503);
    expect(body.error).toBe('store_unavailable');
  });
});

describe('other routes', () => {
  test.each([
    ['GET', '/usage/events'],
    ['DELETE', '/usage/events'],
    ['GET', '/usage'],
    ['GET', '/'],
  ])('%s %s is not served', async (method, path) => {
    const response = await appWith(recordingRepository().repository).handle(
      new Request(`http://localhost${path}`, { method })
    );
    expect(response.status).toBe(404);
  });
});
