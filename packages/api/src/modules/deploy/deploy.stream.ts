import { sse } from 'elysia';

import { sql } from '@api/db/client';
import { LOG_DOMAINS, logger } from '@core/logger';

import { deployments_repo } from './deploy.repo';
import {
  DeployEventNotificationSchema,
  DeployEventPayloadSchema,
  is_terminal_deployment_status,
  TERMINAL_DEPLOYMENT_STATUSES,
} from './deploy.types';
import type {
  DeployEventNotification,
  DeployEventPayload,
  DeploymentStatus,
  DeploySseFrame,
} from './deploy.types';

const stream_logger = logger.child({ domain: LOG_DOMAINS.DEPLOY });
const TERMINAL_STREAM_EVENTS = new Set<DeploymentStatus>([
  ...TERMINAL_DEPLOYMENT_STATUSES,
  'stop_failed',
]);

// A pull-when-ready mailbox: pushes that arrive before the reader is waiting are buffered, so no live
// event is lost between subscribe and the first `next()`. Persisted sequence numbers and the single
// LISTEN dispatch queue preserve ordering across worker and stale-sweep writes.
class EventMailbox {
  private readonly buffer: DeployEventPayload[] = [];
  private waiting: ((event: DeployEventPayload) => void) | null = null;

  push(event: DeployEventPayload): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(event);
    } else {
      this.buffer.push(event);
    }
  }

  next(): Promise<DeployEventPayload> {
    const queued = this.buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

const subscribers = new Map<string, Set<EventMailbox>>();

function subscribe(deployment_id: string): EventMailbox {
  const mailbox = new EventMailbox();
  const set = subscribers.get(deployment_id) ?? new Set<EventMailbox>();
  set.add(mailbox);
  subscribers.set(deployment_id, set);
  return mailbox;
}

function unsubscribe(deployment_id: string, mailbox: EventMailbox): void {
  const set = subscribers.get(deployment_id);
  if (!set) return;
  set.delete(mailbox);
  if (set.size === 0) subscribers.delete(deployment_id);
}

function parse_json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let dispatch_queue = Promise.resolve();

const wait_for_event_lookup_retry = (attempt: number): Promise<void> =>
  Bun.sleep(Math.min(100 * 2 ** Math.min(attempt, 4), 2_000));

/** @internal Retry a committed event lookup while at least one subscriber still needs it. */
export async function retry_deploy_event_lookup(
  notification: DeployEventNotification,
  load: () => Promise<DeployEventPayload | undefined>,
  is_active: () => boolean,
  wait: (attempt: number) => Promise<void> = wait_for_event_lookup_retry
): Promise<DeployEventPayload | undefined> {
  let attempt = 0;
  while (is_active()) {
    try {
      const event = await load();
      if (event) return event;
      stream_logger.warn('deploy event notification has no persisted event', {
        notification,
        attempt,
      });
    } catch (error) {
      stream_logger.error('deploy event notification lookup failed', {
        error,
        notification,
        attempt,
      });
    }
    attempt += 1;
    await wait(attempt);
  }
  return undefined;
}

function dispatch(payload: string): void {
  const parsed = DeployEventNotificationSchema.safeParse(parse_json(payload));
  if (!parsed.success) {
    stream_logger.warn('dropping malformed deploy_events payload', { payload });
    return;
  }

  const notification = parsed.data;
  if (!subscribers.has(notification.deployment_id)) return;

  // Notifications can arrive faster than their event lookups complete. Serializing the reads keeps
  // fanout in database sequence order while the persisted event remains the only payload source.
  dispatch_queue = dispatch_queue
    .then(async () => {
      const event = await retry_deploy_event_lookup(
        notification,
        async () => {
          const events = await deployments_repo.list_events_after(
            notification.deployment_id,
            notification.seq - 1
          );
          const row = events.find((candidate) => candidate.seq === notification.seq);
          const parsed_event = DeployEventPayloadSchema.safeParse(row);
          return parsed_event.success ? parsed_event.data : undefined;
        },
        () => subscribers.has(notification.deployment_id)
      );
      if (!event) return;

      const set = subscribers.get(notification.deployment_id);
      if (!set) return;
      for (const mailbox of set) mailbox.push(event);
    })
    .catch((error) => {
      stream_logger.error('deploy event notification dispatch failed', { error, notification });
    });
}

export function create_retryable_deploy_listener(
  start: () => Promise<unknown>
): () => Promise<unknown> {
  let listen_promise: Promise<unknown> | null = null;

  return () => {
    if (!listen_promise) {
      listen_promise = Promise.resolve()
        .then(start)
        .catch((error) => {
          listen_promise = null;
          throw error;
        });
    }
    return listen_promise;
  };
}

// One LISTEN connection for the whole process fans NOTIFY payloads out to the in-process subscribers.
const open_deploy_listener = create_retryable_deploy_listener(() =>
  sql.listen('deploy_events', dispatch)
);

/** Idempotently open the deploy_events LISTEN. Called at boot and at every stream subscribe. */
export function ensure_deploy_listener(): Promise<unknown> {
  return open_deploy_listener();
}

function to_frame(event: DeployEventPayload) {
  const id = `${event.deployment_id}:${event.seq}`;
  let frame: DeploySseFrame;
  if (event.status === 'success') {
    frame = { id, event: 'succeeded', data: { type: 'succeeded', address: event.detail } };
  } else if (event.status === 'failed') {
    frame = { id, event: 'failed', data: { type: 'failed', message: event.detail } };
  } else if (event.status === 'stopped') {
    frame = { id, event: 'stopped', data: { type: 'stopped', message: event.detail } };
  } else if (event.status === 'stop_failed') {
    frame = { id, event: 'stop_failed', data: { type: 'stop_failed', message: event.detail } };
  } else {
    frame = { id, event: 'phase', data: { type: 'phase', phase: event.status } };
  }
  return sse(frame);
}

function resume_seq(deployment_id: string, last_event_id?: string): number {
  const prefix = `${deployment_id}:`;
  if (!last_event_id?.startsWith(prefix)) return 0;

  const raw_seq = last_event_id.slice(prefix.length);
  if (!/^\d+$/.test(raw_seq)) return 0;

  const seq = Number(raw_seq);
  return Number.isSafeInteger(seq) ? seq : 0;
}

interface DeploymentEventSource {
  list_events_after(deployment_id: string, after_seq: number): Promise<DeployEventPayload[]>;
  get_status(deployment_id: string): Promise<DeploymentStatus | undefined>;
}

interface DeploymentEventReader {
  next(): Promise<DeployEventPayload>;
}

export async function* stream_deployment_event_payloads(
  deployment_id: string,
  last_event_id: string | undefined,
  mailbox: DeploymentEventReader,
  event_source: DeploymentEventSource
): AsyncGenerator<DeployEventPayload> {
  let last_seq = resume_seq(deployment_id, last_event_id);

  for (const event of await event_source.list_events_after(deployment_id, last_seq)) {
    yield event;
    last_seq = event.seq;
  }

  // The row's current status decides whether the stream is finished — teardown appends events after
  // a terminal 'success', so a replayed terminal event does not imply the end of the log.
  const latest = await event_source.get_status(deployment_id);
  if (!latest) return;
  if (is_terminal_deployment_status(latest)) {
    // The terminal transaction can commit after the replay but before this read. A second replay
    // drains that committed event instead of closing with it buffered live.
    for (const event of await event_source.list_events_after(deployment_id, last_seq)) {
      yield event;
      last_seq = event.seq;
    }
    return;
  }

  while (true) {
    const event = await mailbox.next();
    if (event.seq <= last_seq) continue;
    yield event;
    last_seq = event.seq;
    if (TERMINAL_STREAM_EVENTS.has(event.status)) return;
  }
}

/**
 * Stream one deployment's events as SSE. Order matters: subscribe to the live bus FIRST (so nothing is
 * lost while we read), replay persisted events past `last_event_id`, then drain/serve live events —
 * deduplicating anything the replay already covered — until a terminal event closes the stream.
 */
export async function* stream_deployment_events(
  deployment_id: string,
  last_event_id?: string
): AsyncGenerator<ReturnType<typeof to_frame>> {
  await ensure_deploy_listener();
  const mailbox = subscribe(deployment_id);
  try {
    for await (const event of stream_deployment_event_payloads(
      deployment_id,
      last_event_id,
      mailbox,
      deployments_repo
    )) {
      yield to_frame(event);
    }
  } finally {
    unsubscribe(deployment_id, mailbox);
  }
}
