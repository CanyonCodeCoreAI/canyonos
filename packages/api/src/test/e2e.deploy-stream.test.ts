import { describe, expect, test } from 'bun:test';

import {
  create_retryable_deploy_listener,
  retry_deploy_event_lookup,
  stream_deployment_event_payloads,
} from '../modules/deploy/deploy.stream';
import type { DeployEventPayload } from '../modules/deploy/deploy.types';

describe('deploy event stream ordering', () => {
  test('retries LISTEN setup after the initial attempt rejects', async () => {
    let attempts = 0;
    const ensure_listener = create_retryable_deploy_listener(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('listener unavailable');
      return 'connected';
    });

    let first_error: unknown;
    try {
      await ensure_listener();
    } catch (error) {
      first_error = error;
    }

    expect(first_error).toBeInstanceOf(Error);
    expect((first_error as Error).message).toBe('listener unavailable');
    expect(await ensure_listener()).toBe('connected');
    expect(attempts).toBe(2);
  });

  test('retries a persisted event lookup after a transient database failure', async () => {
    const event: DeployEventPayload = {
      deployment_id: '00000000-0000-4000-8000-000000000001',
      seq: 2,
      status: 'failed',
      detail: 'worker lost',
    };
    let attempts = 0;
    let waits = 0;

    const recovered = await retry_deploy_event_lookup(
      { deployment_id: event.deployment_id, seq: event.seq },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database unavailable');
        return event;
      },
      () => true,
      async () => {
        waits += 1;
      }
    );

    expect(recovered).toEqual(event);
    expect(attempts).toBe(2);
    expect(waits).toBe(1);
  });

  test('replays a terminal event committed between the first replay and status lookup', async () => {
    const deployment_id = '00000000-0000-4000-8000-000000000001';
    const terminal_event: DeployEventPayload = {
      deployment_id,
      seq: 2,
      status: 'success',
      detail: '203.0.113.42',
    };
    let replay_count = 0;
    let mailbox_read = false;

    const events = stream_deployment_event_payloads(
      deployment_id,
      `${deployment_id}:1`,
      {
        async next() {
          mailbox_read = true;
          throw new Error('terminal replay should close before reading live events');
        },
      },
      {
        async list_events_after() {
          replay_count += 1;
          return replay_count === 1 ? [] : [terminal_event];
        },
        async get_status() {
          return 'success';
        },
      }
    );

    const received: DeployEventPayload[] = [];
    for await (const event of events) received.push(event);

    expect(received).toEqual([terminal_event]);
    expect(replay_count).toBe(2);
    expect(mailbox_read).toBe(false);
  });

  test('closes after a live stop_failed event', async () => {
    const deployment_id = '00000000-0000-4000-8000-000000000001';
    const stop_failed: DeployEventPayload = {
      deployment_id,
      seq: 4,
      status: 'stop_failed',
      detail: 'worker lost while stopping; retry the stop',
    };

    const events = stream_deployment_event_payloads(
      deployment_id,
      undefined,
      {
        async next() {
          return stop_failed;
        },
      },
      {
        async list_events_after() {
          return [];
        },
        async get_status() {
          return 'stopping';
        },
      }
    );

    const received: DeployEventPayload[] = [];
    for await (const event of events) received.push(event);

    expect(received).toEqual([stop_failed]);
  });
});
