// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The CLI usage API: one public route, `POST /usage/events`, where the `canyonos` CLI reports a
 * batch of command outcomes. The local server and the Lambda handler both serve this app.
 */

import { Elysia } from 'elysia';

import {
  MAX_REQUEST_BODY_BYTES,
  UsageEventBatchSchema,
  UsageEventsStoredSchema,
} from './usage.contract';
import { UsageStoreUnavailableError } from './usage.repository';
import type { UsageRepository } from './usage.repository';

type RejectionStatus = 400 | 413 | 415;

class RequestRejectedError extends Error {
  constructor(
    readonly status: RejectionStatus,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RequestRejectedError';
  }
}

const bodyTooLarge = () =>
  new RequestRejectedError(
    413,
    'payload_too_large',
    `The request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`
  );

const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

async function readBoundedText(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    throw bodyTooLarge();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw bodyTooLarge();
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new RequestRejectedError(400, 'malformed_body', 'The request body is not UTF-8');
  }
}

async function parseJsonBody({ request }: { request: Request }): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) {
    throw new RequestRejectedError(415, 'unsupported_media_type', 'Send the events as JSON');
  }
  const text = await readBoundedText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestRejectedError(400, 'malformed_body', 'The request body is not valid JSON');
  }
}

const log = (message: string, fields: Record<string, string | number>) =>
  console.info(JSON.stringify({ message, ...fields }));

export interface AppDependencies {
  readonly repository: UsageRepository;
  readonly now?: () => Date;
}

/** Build the API around the repository it stores events with. */
export const createApp = ({ repository, now = () => new Date() }: AppDependencies) =>
  new Elysia({ name: 'cli-usage-api' })
    .onError(({ code, error, status }) => {
      if (code === 'PARSE') {
        const rejection =
          error.cause instanceof RequestRejectedError
            ? error.cause
            : new RequestRejectedError(400, 'malformed_body', 'The request body could not be read');
        return status(rejection.status, { error: rejection.code, message: rejection.message });
      }
      if (code === 'VALIDATION') {
        const details = error.all.map((issue) => ({
          path: 'path' in issue ? String(issue.path) : '',
          message: issue.summary ?? 'Invalid value',
        }));
        return status(422, { error: 'validation_error', message: 'Validation failed', details });
      }
      if (code === 'NOT_FOUND') {
        return status(404, { error: 'not_found', message: 'Not found' });
      }
      if (error instanceof UsageStoreUnavailableError) {
        const cause = error.cause instanceof Error ? error.cause.name : 'unknown';
        log('usage_events_store_failed', { failed: error.failed, cause });
        return status(503, {
          error: 'store_unavailable',
          message: 'The usage events could not be stored; retry the whole batch later',
        });
      }
      log('unhandled_error', { error: error instanceof Error ? error.name : 'unknown' });
      return status(500, { error: 'internal_error', message: 'Internal server error' });
    })
    .post(
      '/usage/events',
      async ({ body }) => {
        const result = await repository.storeEvents(body.events, now().toISOString());
        log('usage_events_stored', { stored: result.stored, duplicates: result.duplicates });
        return result;
      },
      {
        parse: parseJsonBody,
        body: UsageEventBatchSchema,
        response: { 200: UsageEventsStoredSchema },
      }
    );

export type CliUsageApp = ReturnType<typeof createApp>;
