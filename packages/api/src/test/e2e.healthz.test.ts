// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import net from 'node:net';

import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import { app } from '@api/app';
import { set_database_state } from '@api/db/database';
import { CONTROL_PATH_PREFIX } from '@api/modules/auth/control-key';
import { config } from '@core/env';

import { TEST_CONTROL_KEY } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { until_answers } from './test.utils';
import { bearer, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

describe('healthz', () => {
  test('returns ok', async () => {
    const { data, error } = await api.healthz.get();
    expect(error).toBeNull();
    expect(data?.status).toBe('ok');
    expect(typeof data?.timestamp).toBe('string');
  });

  test('reports the explicit commit before the Railway commit value', async () => {
    const previousRailwayCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
    const previousLegacyCommit = process.env.GIT_COMMIT_SHA;
    process.env.RAILWAY_GIT_COMMIT_SHA = 'railway-commit';
    process.env.GIT_COMMIT_SHA = 'legacy-commit';

    try {
      const { data, error } = await api.healthz.get();
      expect(error).toBeNull();
      expect(data?.version).toBe('legacy-commit');

      delete process.env.GIT_COMMIT_SHA;
      const fallback = await api.healthz.get();
      expect(fallback.error).toBeNull();
      expect(fallback.data?.version).toBe('railway-commit');
    } finally {
      if (previousRailwayCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = previousRailwayCommit;
      if (previousLegacyCommit === undefined) delete process.env.GIT_COMMIT_SHA;
      else process.env.GIT_COMMIT_SHA = previousLegacyCommit;
    }
  });
});

describe('readyz', () => {
  test('is ready once the database answers, and says that Docker does', async () => {
    const { data, error } = await api.readyz.get();

    expect(error).toBeNull();
    expect(data).toEqual({ status: 'ready', checks: { database: 'ok', docker: 'ok' } });
  });

  test('is 503 not_ready, and says where the database is, until it is ready', async () => {
    set_database_state('migrating');
    try {
      const response = await fetch(`${config.app.apiUrl}/readyz`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'migrating', docker: 'ok' },
      });
    } finally {
      set_database_state('ready');
    }
    expect((await fetch(`${config.app.apiUrl}/healthz`)).status).toBe(200);
  });
});

const NO_DATABASE_PATHS = ['/healthz', '/readyz', '/auth/status', '/auth/check'];
const NO_DATABASE_PREFIXES = ['/docs'];
const SOME_ID = '0190a5e8-0000-7000-8000-000000000000';

const needs_database = ({ method, path }: { method: string; path: string }) =>
  method !== 'OPTIONS' &&
  !NO_DATABASE_PATHS.includes(path) &&
  !NO_DATABASE_PREFIXES.some((prefix) => path.startsWith(prefix));

describe('database guard', () => {
  test('every route outside health, auth and docs answers 503 database.unavailable until the database is ready, whatever it sends', async () => {
    const guarded = app.routes.filter(needs_database);
    expect(guarded.length).toBeGreaterThan(40);

    set_database_state('connecting');
    try {
      for (const { method, path } of guarded) {
        // The right key, so only the database stands in the way; params, query and body unchecked.
        const key = path.startsWith(CONTROL_PATH_PREFIX) ? TEST_CONTROL_KEY : TEST_API_KEY;
        const response = await app.handle(
          new Request(`http://localhost${path.replace(/:[^/]+/g, SOME_ID)}?limit=lots`, {
            method,
            headers: { 'content-type': 'application/json', ...bearer(key) },
            ...(method === 'GET' ? {} : { body: '{}' }),
          })
        );
        const body = (await response.json()) as { error?: string };
        expect({ route: `${method} ${path}`, status: response.status, error: body.error }).toEqual({
          route: `${method} ${path}`,
          status: 503,
          error: 'database.unavailable',
        });
      }
    } finally {
      set_database_state('ready');
    }
  });
});

const SERVER = new URL('../server.ts', import.meta.url).pathname;
const SHUTDOWN_TIMEOUT_MS = 5_000;

describe('DATABASE_URL', () => {
  test('outside development and test, an unset one refuses the start, naming it', async () => {
    const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
      env: {
        ...process.env,
        APP_ENV: 'production',
        DATABASE_URL: '',
        PORT: String(config.app.port + 91),
        REDIS_PASSWORD_ENCRYPTION_KEY: 'a production key of at least 32 characters',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS * 2);
    const code = await child.exited;
    clearTimeout(timeout);

    expect(code).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      'DATABASE_URL must be set explicitly outside development and test'
    );
  }, 15_000);
});

describe('shutdown', () => {
  test('SIGTERM stops the server and exits 0 within five seconds', async () => {
    const port = config.app.port + 90;
    const url = `http://localhost:${port}`;
    const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
      env: { ...process.env, PORT: String(port), API_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      // Ready: connected to the database, with its loops started.
      await until_answers(url, '/readyz');
      const started_at = performance.now();
      child.kill('SIGTERM');
      const exit = await Promise.race([
        child.exited,
        Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => 'still running'),
      ]);

      expect(exit).toBe(0);
      expect(performance.now() - started_at).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
      expect(await fetch(`${url}/healthz`).catch(() => 'refused')).toBe('refused');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  }, 40_000);
});

/** Starts `src/server.ts` on its own port with `env` over this run's environment, its output
 * collected for a failure message. */
function spawn_server(port: number, env: Record<string, string>) {
  const url = `http://localhost:${port}`;
  const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
    env: { ...process.env, PORT: String(port), API_URL: url, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then((parts) => parts.join(''));
  return { child, url, output };
}

async function stop_server({ child }: { child: Bun.Subprocess }) {
  if (child.exitCode === null) child.kill('SIGKILL');
  await child.exited;
}

/** A database of its own on the test server, `DATABASE_URL` but for its name, empty; `prepare`
 * runs in it first. */
async function fresh_database(suffix: string, prepare?: (db: postgres.Sql) => Promise<unknown>) {
  const url = new URL(config.database.url);
  const name = `${decodeURIComponent(url.pathname.slice(1))}_${suffix}`;
  const admin = postgres({ ...admin_options(url), database: 'postgres' });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  url.pathname = `/${name}`;
  if (prepare) {
    const db = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    await prepare(db);
    await db.end();
  }
  return url;
}

async function drop_database(url: URL) {
  const admin = postgres({ ...admin_options(url), database: 'postgres' });
  await admin.unsafe(
    `DROP DATABASE IF EXISTS "${decodeURIComponent(url.pathname.slice(1))}" WITH (FORCE)`
  );
  await admin.end();
}

const admin_options = (url: URL) => ({
  host: url.hostname,
  port: Number(url.port || 5432),
  username: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  max: 1,
  onnotice: () => undefined,
});

describe('readyz without Docker', () => {
  test('is 200 when DOCKER_SOCKET names no socket, and says Docker is unreachable', async () => {
    const server = spawn_server(config.app.port + 93, {
      DOCKER_SOCKET: '/nonexistent/docker.sock',
    });
    try {
      await until_answers(server.url, '/readyz');
      const response = await fetch(`${server.url}/readyz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', docker: 'unreachable' },
      });
      // The /v1 routes, which need Docker, say so themselves.
      const groups = await fetch(`${server.url}/v1/workflow-groups/${crypto.randomUUID()}`, {
        headers: bearer(TEST_CONTROL_KEY),
      });
      expect(groups.status).toBe(503);
      expect(await groups.json()).toMatchObject({ error: 'docker.unavailable' });
    } finally {
      await stop_server(server);
    }
  }, 40_000);
});

describe('a failed setup', () => {
  test('exits 1 once it is logged, for the restart policy to start the API again', async () => {
    // The baseline migration creates this type: the migration cannot apply.
    const url = await fresh_database('setup_failure', (db) =>
      db.unsafe(`CREATE TYPE "public"."deployment_status" AS ENUM('taken')`)
    );
    const server = spawn_server(config.app.port + 94, { DATABASE_URL: url.toString() });
    try {
      const exit = await Promise.race([
        server.child.exited,
        Bun.sleep(30_000).then(() => 'still running'),
      ]);

      expect(exit).toBe(1);
      expect(await server.output).toContain('Database setup failed');
    } finally {
      await stop_server(server);
      await drop_database(url);
    }
  }, 40_000);
});

/** A TCP proxy in front of the test database, which `stop` takes down, its connections too, as a
 * stopped database would be, and `start` brings back on the same port. */
async function database_proxy() {
  const target = new URL(config.database.url);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  const listen = (port: number) =>
    new Promise<number>((resolve) =>
      server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    );
  const port = await listen(0);
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
    start: () => listen(port),
  };
}

describe('a database lost after the API was ready', () => {
  test('is 503 database.unavailable, not 500, until it answers again, and then the API serves', async () => {
    const url = await fresh_database('lost');
    const proxy = await database_proxy();
    const proxied = new URL(url);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(proxy.port);
    const server = spawn_server(config.app.port + 95, {
      DATABASE_URL: proxied.toString(),
      CANYONOS_API_KEY_HASH: '',
    });
    try {
      await until_answers(server.url, '/readyz');
      expect((await fetch(`${server.url}/workflows`)).status).toBe(200);

      await proxy.stop();
      const lost = await fetch(`${server.url}/workflows`);
      expect(lost.status).toBe(503);
      expect(await lost.json()).toMatchObject({ error: 'database.unavailable' });
      const waiting = await fetch(`${server.url}/readyz`);
      expect(waiting.status).toBe(503);
      expect(await waiting.json()).toMatchObject({ checks: { database: 'connecting' } });
      expect((await fetch(`${server.url}/workflows`)).status).toBe(503);

      await proxy.start();
      await until_answers(server.url, '/readyz');
      expect((await fetch(`${server.url}/workflows`)).status).toBe(200);
    } catch (error) {
      await stop_server(server);
      throw new Error(`${String(error)}\n${await server.output}`);
    } finally {
      await stop_server(server);
      await proxy.stop();
      await drop_database(url);
    }
  }, 60_000);
});
