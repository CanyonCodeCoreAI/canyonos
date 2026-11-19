// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { RedisClient } from 'bun';

import { badGateway } from './errors';
import type { AppError } from './errors';

/** Where a Redis is and how to sign in to it: tls is true for TLS alone, or the client
 * certificate a Docker workflow group's Redis takes. */
export interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean | Bun.TLSOptions;
  readonly username?: string;
  readonly password?: string;
}

/** The URL of a Redis, with its credentials (escaped) and TLS. */
export function redis_url({
  host,
  port,
  tls = false,
  username = '',
  password = '',
}: RedisTarget): string {
  const credentials = password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  const authority = host.includes(':') ? `[${host}]` : host;
  return `${tls ? 'rediss' : 'redis'}://${credentials}${authority}:${port}`;
}

/** Bun's RedisClient ignores connectionTimeout while the TCP connect is pending, so a Redis
 * whose address stopped answering would hold the request until the server's idle timeout. Long
 * enough for a TLS handshake on a machine busy starting a workflow group's replicas. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long the sign-in check waits for an answer from a Redis that closed Bun's connection. */
const SIGN_IN_CHECK_TIMEOUT_MS = 1000;
/** The errors Redis answers a refused sign-in with. */
const SIGN_IN_REFUSED = /^-(NOAUTH|WRONGPASS|ERR invalid password)/;
const UPDATE_ATTEMPTS = 5;

class ConnectTimedOut extends Error {}

async function connect_within_timeout(redis: RedisClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed_out = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectTimedOut('Redis connect timed out')),
      CONNECT_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([redis.connect(), timed_out]);
  } finally {
    clearTimeout(timer);
  }
}

function resp_command(args: readonly string[]): string {
  const parts = args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  return `*${args.length}\r\n${parts.join('')}`;
}

/** Redis's first answer to command over a new connection to target, or '' when it does not
 * answer within SIGN_IN_CHECK_TIMEOUT_MS. */
async function first_answer(
  { host, port, tls = false }: RedisTarget,
  command: readonly string[]
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const timer = setTimeout(() => resolve(''), SIGN_IN_CHECK_TIMEOUT_MS);
  const socket = Bun.connect({
    hostname: host,
    port,
    tls,
    socket: {
      open: (opened) => void opened.write(resp_command(command)),
      data: (_, data) => resolve(data.toString()),
      close: () => resolve(''),
      error: () => resolve(''),
    },
  }).catch(() => {
    resolve('');
    return null;
  });
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    void socket.then((opened) => opened?.end());
  }
}

/** Whether target's Redis refuses its credentials. Bun's RedisClient reports a refused sign-in
 * only as the connection closing, as it does a Redis that is down, so this signs in once over a
 * plain connection (or pings, without a password) and reads Redis's answer. */
async function refuses_sign_in(target: RedisTarget): Promise<boolean> {
  const { username = '', password = '' } = target;
  const command = password ? ['AUTH', ...(username ? [username] : []), password] : ['PING'];
  return SIGN_IN_REFUSED.test(await first_answer(target, command));
}

/** The error for a failed connect: the Redis refused its password, or it could not be reached.
 * A connect that timed out is not asked again, since its address does not answer. */
async function connect_failure(error: unknown, target: RedisTarget): Promise<AppError> {
  if (!(error instanceof ConnectTimedOut) && (await refuses_sign_in(target))) {
    return badGateway(
      'registry.redis_auth_failed',
      "This workflow group's Redis refused the password the dashboard holds for it. Deploy it again with `canyonos deploy` from its folder to register its current password.",
      { cause: error }
    );
  }
  return badGateway(
    'registry.controller_unreachable',
    'The running controller could not be reached',
    { cause: error }
  );
}

async function connect(redis: RedisClient, target: RedisTarget): Promise<void> {
  try {
    await connect_within_timeout(redis);
  } catch (error) {
    throw await connect_failure(error, target);
  }
}

/** Runs operation against target's Redis, then closes the connection. */
export async function with_redis_target<T>(
  target: RedisTarget,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  const redis = new RedisClient(redis_url(target), {
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
    connectionTimeout: 5000,
    ...(typeof target.tls === 'object' ? { tls: target.tls } : {}),
  });

  try {
    await connect(redis, target);
    return await operation(redis);
  } finally {
    redis.close();
  }
}

/**
 * Rewrites key with change applied to its stored value, retrying while another writer races us:
 * WATCH makes EXEC a no-op (null) when the key changed after our read. False when it kept
 * changing for every attempt, so nothing was written.
 */
export async function update_json_key(
  redis: RedisClient,
  key: string,
  change: (stored: string | null) => unknown
): Promise<boolean> {
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
    await redis.send('WATCH', [key]);
    const next = change(await redis.get(key));
    await redis.send('MULTI', []);
    await redis.set(key, JSON.stringify(next));
    if ((await redis.send('EXEC', [])) !== null) return true;
  }
  return false;
}
