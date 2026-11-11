// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { RedisClient } from 'bun';

import { config } from '@core/env';
import { badGateway, notFound } from '@core/errors';
import type { AppError } from '@core/errors';

import { registered_projects } from './canyonos.registry';
import { canyonos_repo } from './canyonos.repo';

export const CONTROLLER_IDENTITY_KEY = 'controller:identity';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The host the api reaches a project's Redis on. An api running on the host itself (its
 * configured Redis on loopback, as with `bun run dashboard:dev`) cannot resolve the container
 * name a project stored, so it reaches the project's published port on loopback instead. */
export function reachable_redis_host(stored_host: string | null): string {
  const configured = config.canyonos.redisHost;
  return stored_host === null || LOOPBACK_HOSTS.has(configured) ? configured : stored_host;
}

/** Where a project's Redis is and how to sign in to it. */
export interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
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
 * whose address stopped answering would hold the request until the server's idle timeout. */
const CONNECT_TIMEOUT_MS = 3000;
/** How long the sign-in check waits for an answer from a Redis that closed Bun's connection. */
const SIGN_IN_CHECK_TIMEOUT_MS = 1000;
/** The errors Redis answers a refused sign-in with. */
const SIGN_IN_REFUSED = /^-(NOAUTH|WRONGPASS|ERR invalid password)/;

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

/** The error for a failed connect: the project's Redis refused its password, or it could not be
 * reached. A connect that timed out is not asked again, since its address does not answer. */
async function connect_failure(error: unknown, target: RedisTarget): Promise<AppError> {
  if (!(error instanceof ConnectTimedOut) && (await refuses_sign_in(target))) {
    return badGateway(
      'canyonos.redis_auth_failed',
      "This project's Redis refused the password the dashboard holds for it. Deploy the project again with `canyonos deploy` from its folder to register its current password.",
      { cause: error }
    );
  }
  return badGateway(
    'canyonos.controller_unreachable',
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

/** Runs operation against the Redis on redis_host:redis_port, signing in with redis_password
 * when there is one, then closes the connection. */
export async function with_redis_at<T>(
  redis_host: string,
  redis_port: number,
  redis_password: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  return with_redis_target(
    { host: redis_host, port: redis_port, password: redis_password },
    operation
  );
}

/** Runs operation against target's Redis, then closes the connection. */
async function with_redis_target<T>(
  target: RedisTarget,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  const redis = new RedisClient(redis_url(target), {
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
    connectionTimeout: 5000,
  });

  try {
    await connect(redis, target);
    return await operation(redis);
  } finally {
    redis.close();
  }
}

// Temporary: applied now so multi-project dashboards work without blocking the flow; revisit
// with the project-key design in CAN-521 (the api should not hold per-project Redis addresses).
/** Runs operation against the Redis project_id registered, or the configured one if it never did.
 * On Kubernetes a project is reached at its own Redis, signed in, while the operator lists it. */
export async function with_redis<T>(
  project_id: string,
  operation: (redis: RedisClient) => Promise<T>
): Promise<T> {
  const listed = registered_projects().get(project_id);
  if (listed) return with_redis_target(listed.redis, operation);
  if (config.canyonos.projectsFile) {
    // Deleted from the cluster, or not ready: there is no Redis of it to fall back to.
    throw notFound(
      'canyonos.project_not_running',
      "This project isn't running in the cluster. Deploy it again with `canyonos deploy --target kubernetes`."
    );
  }
  const project = await canyonos_repo.find_redis(project_id);
  return with_redis_at(
    reachable_redis_host(project?.redis_host ?? null),
    project?.redis_port ?? config.canyonos.redisPort,
    project?.redis_password ?? '',
    operation
  );
}

export async function project_running(redis: RedisClient, project_id: string): Promise<boolean> {
  return (await redis.hget(CONTROLLER_IDENTITY_KEY, 'project_id')) === project_id;
}

/** Throws not found unless the running controller belongs to project_id. */
export async function assert_project_running(
  redis: RedisClient,
  project_id: string
): Promise<void> {
  if (!(await project_running(redis, project_id))) {
    throw notFound(
      'canyonos.project_not_running',
      "This project isn't running. Deploy it again with `canyonos deploy` from its folder."
    );
  }
}
