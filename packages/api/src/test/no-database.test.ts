// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// `test:no-database` points DATABASE_URL at a closed port and runs with no API key: the API must
// listen anyway, answer what needs no database, and 503 the rest while it keeps waiting.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const { start_api } = await import('@api/app');
const { config } = await import('@core/env');
const { sweep_answer, sweep_routes } = await import('./route-sweep.utils');
const { until_answers } = await import('./test.utils');

const API_URL = config.app.apiUrl;

let running: ReturnType<typeof start_api>;

beforeAll(async () => {
  running = start_api({ host: config.app.host, port: config.app.port });
  await until_answers(API_URL, '/v1/healthz');
});

afterAll(async () => {
  await running.stop();
});

const error_code = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

describe('the API with its database down', () => {
  test('/v1/healthz answers 200', async () => {
    expect((await fetch(`${API_URL}/v1/healthz`)).status).toBe(200);
  });

  test('/v1/readyz answers 503 while it waits for the database', async () => {
    const response = await fetch(`${API_URL}/v1/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: 'connecting' },
    });
  });

  test('/v1/auth/status answers 200', async () => {
    const response = await fetch(`${API_URL}/v1/auth/status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ api_key_required: false });
  });

  test('GET /v1/workflows answers 503 database.unavailable', async () => {
    const response = await fetch(`${API_URL}/v1/workflows`);

    expect(response.status).toBe(503);
    expect(await error_code(response)).toBe('database.unavailable');
  });

  test('GET /v1/workflow-groups answers 503 database.unavailable', async () => {
    const response = await fetch(`${API_URL}/v1/workflow-groups`);
    expect(response.status).toBe(503);
    expect(await error_code(response)).toBe('database.unavailable');
  });

  // Health, auth and the docs read no database; everything else does, the OTLP receivers too.
  test('every route outside health, auth and docs answers 503 database.unavailable, whatever it sends', async () => {
    const no_database = ['/v1/healthz', '/v1/readyz', '/v1/auth/status', '/v1/auth/check'];
    const routes = sweep_routes().filter(
      ({ method, path }) =>
        method !== 'OPTIONS' && !no_database.includes(path) && !path.startsWith('/docs')
    );
    expect(routes.length).toBeGreaterThan(40);

    for (const swept of routes) {
      // No key to send, so only the database stands in the way: params and query unchecked, and
      // a body that parses, as the guard runs once it is read.
      const { route, status, error } = await sweep_answer(API_URL, swept, {}, '{}');
      expect({ route, status, error }).toEqual({
        route,
        status: 503,
        error: 'database.unavailable',
      });
    }
  });

  test('POST /v1/workflow-groups/:workflow_group_id/metrics answers 503', async () => {
    const response = await fetch(`${API_URL}/v1/workflow-groups/${crypto.randomUUID()}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(0),
    });

    expect(response.status).toBe(503);
  });
});
