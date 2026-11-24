// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import net from 'node:net';

import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import { set_database_state } from '@api/db/database';
import { config } from '@core/env';

import { TEST_DEPLOY_KEY } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { refused_start, spawn_api } from './process-test.utils';
import { until_answers } from './test.utils';
import { bearer } from './workflow-test.utils';
import type { SpawnedApi } from './process-test.utils';

setupE2ETests();

describe('healthz', () => {
  test('returns ok', async () => {
    const { data, error } = await api.v1.healthz.get();
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
      const { data, error } = await api.v1.healthz.get();
      expect(error).toBeNull();
      expect(data?.version).toBe('legacy-commit');

      delete process.env.GIT_COMMIT_SHA;
      const fallback = await api.v1.healthz.get();
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
    const { data, error } = await api.v1.readyz.get();

    expect(error).toBeNull();
    expect(data).toEqual({ status: 'ready', checks: { database: 'ok', docker: 'ok' } });
  });

  test('is 503 not_ready, and says where the database is, until it is ready', async () => {
    set_database_state('migrating');
    try {
      const response = await fetch(`${config.app.apiUrl}/v1/readyz`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'migrating', docker: 'ok' },
      });
    } finally {
      set_database_state('ready');
    }
    expect((await fetch(`${config.app.apiUrl}/v1/healthz`)).status).toBe(200);
  });
});

const SHUTDOWN_TIMEOUT_MS = 5_000;

describe('DATABASE_URL', () => {
  test('outside development and test, an unset one refuses the start, naming it', async () => {
    const { exit_code, output } = await refused_start({
      APP_ENV: 'production',
      DATABASE_URL: '',
      REDIS_PASSWORD_ENCRYPTION_KEY: 'a production key of at least 32 characters',
    });

    expect(exit_code).not.toBe(0);
    expect(output).toContain('DATABASE_URL must be set explicitly outside development and test');
  }, 15_000);
});

describe('shutdown', () => {
  test('SIGTERM stops the server and exits 0 within five seconds', async () => {
    // Ready: connected to the database, with its loops started.
    const server = await spawn_api();
    const started_at = performance.now();
    const exit = await Promise.race([
      server.stop(),
      Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => 'still running'),
    ]);

    expect(exit).toBe(0);
    expect(performance.now() - started_at).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    expect(await fetch(`${server.url}/v1/healthz`).catch(() => 'refused')).toBe('refused');
  }, 40_000);
});

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
  const group_status = (server: SpawnedApi) =>
    fetch(`${server.url}/v1/workflow-groups/${crypto.randomUUID()}`, {
      headers: bearer(TEST_DEPLOY_KEY),
    });

  test('is 200 when DOCKER_SOCKET names no socket, and says Docker is unreachable', async () => {
    const server = await spawn_api({ DOCKER_SOCKET: '/nonexistent/docker.sock' });
    try {
      const response = await fetch(`${server.url}/v1/readyz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', docker: 'unreachable' },
      });
      // The /v1/workflow-groups routes, which need Docker, say so themselves.
      const groups = await group_status(server);
      expect(groups.status).toBe(503);
      expect(await groups.json()).toMatchObject({ error: 'docker.unavailable' });
    } finally {
      await server.stop();
    }
  }, 40_000);

  test('is 200 when DOCKER_SOCKET is empty, and says Docker is disabled', async () => {
    const server = await spawn_api({ DOCKER_SOCKET: '' });
    try {
      const response = await fetch(`${server.url}/v1/readyz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', docker: 'disabled' },
      });
      const groups = await group_status(server);
      expect(groups.status).toBe(503);
      expect(await groups.json()).toMatchObject({ error: 'docker.disabled' });
    } finally {
      await server.stop();
    }
  }, 40_000);
});

describe('a failed setup', () => {
  test('exits 1 once it is logged, for the restart policy to start the API again', async () => {
    // The baseline migration creates this type: the migration cannot apply.
    const url = await fresh_database('setup_failure', (db) =>
      db.unsafe(`CREATE TYPE "public"."deployment_status" AS ENUM('taken')`)
    );
    try {
      const { exit_code, output } = await refused_start({
        DATABASE_URL: url.toString(),
        LOG_LEVEL: 'error',
      });

      expect(exit_code).toBe(1);
      expect(output).toContain('Database setup failed');
    } finally {
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
    const server = await spawn_api({ DATABASE_URL: proxied.toString() });
    try {
      expect((await fetch(`${server.url}/v1/workflows`)).status).toBe(200);

      await proxy.stop();
      const lost = await fetch(`${server.url}/v1/workflows`);
      expect(lost.status).toBe(503);
      expect(await lost.json()).toMatchObject({ error: 'database.unavailable' });
      const waiting = await fetch(`${server.url}/v1/readyz`);
      expect(waiting.status).toBe(503);
      expect(await waiting.json()).toMatchObject({ checks: { database: 'connecting' } });
      expect((await fetch(`${server.url}/v1/workflows`)).status).toBe(503);

      await proxy.start();
      await until_answers(server.url, '/v1/readyz');
      expect((await fetch(`${server.url}/v1/workflows`)).status).toBe(200);
    } catch (error) {
      throw new Error(`${String(error)}\n${server.output()}`, { cause: error });
    } finally {
      await server.stop();
      await proxy.stop();
      await drop_database(url);
    }
  }, 60_000);
});
