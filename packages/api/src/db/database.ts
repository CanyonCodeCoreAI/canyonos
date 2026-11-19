// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import postgres from 'postgres';

import { serviceUnavailable, translate_errors } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { sql } from './client';

/** Where the API is in readying its database: it listens first, then connects (waiting for as
 * long as the database is down), migrates and starts what reads it; a database lost once ready
 * is `connecting` again until it answers. `failed` is a setup that stopped, as the process
 * exits to be started again. */
export type DatabaseState = 'connecting' | 'migrating' | 'ready' | 'failed';

const RETRY_MS = 2_000;
const LOG_EVERY_MS = 30_000;

const database_logger = logger.child({ domain: LOG_DOMAINS.DB });

let state: DatabaseState = 'connecting';
// The shutdown the API waits for its database with, which ends a reconnect too.
let shutting_down: AbortSignal | undefined;

export function database_state(): DatabaseState {
  return state;
}

export function set_database_state(next: DatabaseState): void {
  state = next;
}

/** Resolves once the database answers `select 1`, asking every RETRY_MS, or when `signal`
 * aborts. The first failure is logged, then one every LOG_EVERY_MS, so a database that stays
 * down does not flood the log. */
export async function wait_for_database(signal?: AbortSignal): Promise<void> {
  shutting_down = signal;
  set_database_state('connecting');
  let last_logged_at: number | null = null;
  while (!signal?.aborted) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      const now = Date.now();
      if (last_logged_at === null || now - last_logged_at >= LOG_EVERY_MS) {
        database_logger.warn('The database is not reachable yet', { error });
        last_logged_at = now;
      }
    }
    await Bun.sleep(RETRY_MS);
  }
}

/** Whether the database answers `select 1` within `timeout_ms`. */
export async function ping_database(timeout_ms: number): Promise<boolean> {
  const query = sql`select 1`;
  const timeout = Bun.sleep(timeout_ms).then(() => {
    query.cancel();
    return false;
  });
  return Promise.race([query.then(() => true), timeout]).catch(() => false);
}

const database_unavailable = (cause?: unknown) =>
  serviceUnavailable(
    'database.unavailable',
    "The dashboard's database is not ready yet; try again shortly.",
    { cause }
  );

/** Refuses the request with 503 `database.unavailable` until the database is ready. */
export function require_database(): void {
  if (state !== 'ready') throw database_unavailable();
}

// What the `postgres` driver rejects a query with when it cannot reach the database: its own
// codes; the socket's, on an error it hands a query; and the server's for a lost connection
// (SQLSTATE class 08) or a server shutting down or starting up.
const DRIVER_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);
const SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const SERVER_STATES = new Set(['57P01', '57P02', '57P03']);
// Drizzle wraps the driver's error in its own, as `cause`.
const MAX_CAUSES = 4;

function is_connection_failure(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  if (error instanceof postgres.PostgresError) {
    return code.startsWith('08') || SERVER_STATES.has(code);
  }
  return DRIVER_CODES.has(code) || (SOCKET_CODES.has(code) && 'query' in error);
}

/** Whether `error`, or what it wraps, is the database driver failing to reach the database. */
export function is_database_connection_error(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; cause instanceof Error && depth < MAX_CAUSES; depth += 1) {
    if (is_connection_failure(cause)) return true;
    cause = cause.cause;
  }
  return false;
}

/** A query found the database gone after it was ready: every route that needs it answers 503
 * from now on, while the API waits for it as at the start, then serves again. */
function database_lost(error: unknown): void {
  if (state !== 'ready' || shutting_down?.aborted) return;
  database_logger.warn('Lost the database; routes that need it answer 503 until it answers', {
    error,
  });
  void wait_for_database(shutting_down).then(() => {
    if (shutting_down?.aborted) return;
    set_database_state('ready');
    database_logger.info('The database answers again');
  });
}

// A route whose query cannot reach the database answers 503 `database.unavailable`, not 500.
translate_errors((error) => {
  if (!is_database_connection_error(error)) return null;
  database_lost(error);
  return database_unavailable(error);
});

/** Every routes module whose handlers reach Postgres, directly or through a service, uses this:
 * until the database is ready its routes answer 503 `database.unavailable`. It runs as the body
 * is handed over, before params, query and body are checked, so a caller learns to retry rather
 * than that its request is wrong; the key guards run before it, as the request arrives. */
export const databasePlugin = new Elysia({ name: 'database.plugin' }).onTransform(
  { as: 'scoped' },
  require_database
);
