// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// `test:no-database` points DATABASE_URL at a closed port and runs with no API key: the API must
// listen anyway, answer what needs no database, and 503 the rest while it keeps waiting.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { hashApiKey, TEST_CONTROL_KEY } from './api-key-test.utils';

// Before env.ts reads it: /v1 takes no request without a control key hash.
process.env.CANYONOS_CONTROL_KEY_HASH ??= hashApiKey(TEST_CONTROL_KEY);

const { start_api } = await import('@api/app');
const { config } = await import('@core/env');
const { sweep_answer, sweep_routes } = await import('./route-sweep.utils');
const { until_answers } = await import('./test.utils');

const API_URL = config.app.apiUrl;

let running: ReturnType<typeof start_api>;

beforeAll(async () => {
  running = start_api({ host: config.app.host, port: config.app.port });
  await until_answers(API_URL, '/healthz');
});

afterAll(async () => {
  await running.stop();
});

const error_code = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

describe('the API with its database down', () => {
  test('/healthz answers 200', async () => {
    expect((await fetch(`${API_URL}/healthz`)).status).toBe(200);
  });

  test('/readyz answers 503 while it waits for the database', async () => {
    const response = await fetch(`${API_URL}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: 'connecting' },
    });
  });

  test('/auth/status answers 200', async () => {
    const response = await fetch(`${API_URL}/auth/status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ api_key_required: false });
  });

  test('GET /workflows answers 503 database.unavailable', async () => {
    const response = await fetch(`${API_URL}/workflows`);

    expect(response.status).toBe(503);
    expect(await error_code(response)).toBe('database.unavailable');
  });

  test('GET /v1/workflow-groups answers 401 without the control key, 503 with it', async () => {
    const refused = await fetch(`${API_URL}/v1/workflow-groups`);
    expect(refused.status).toBe(401);
    expect(await error_code(refused)).toBe('auth.missing_key');

    const response = await fetch(`${API_URL}/v1/workflow-groups`, {
      headers: { authorization: `Bearer ${TEST_CONTROL_KEY}` },
    });
    expect(response.status).toBe(503);
    expect(await error_code(response)).toBe('database.unavailable');
  });

  // Health, auth and the docs read no database; everything else does, the OTLP receivers too.
  test('every route outside health, auth and docs answers 503 database.unavailable, whatever it sends', async () => {
    const no_database = ['/healthz', '/readyz', '/auth/status', '/auth/check'];
    const routes = sweep_routes().filter(
      ({ method, path }) =>
        method !== 'OPTIONS' && !no_database.includes(path) && !path.startsWith('/docs')
    );
    expect(routes.length).toBeGreaterThan(40);

    for (const swept of routes) {
      // The right key, so only the database stands in the way: params and query unchecked, and a
      // body that parses, as the guard runs once it is read.
      const headers: Record<string, string> =
        swept.kind === 'control_key' ? { authorization: `Bearer ${TEST_CONTROL_KEY}` } : {};
      const { route, status, error } = await sweep_answer(API_URL, swept, headers, '{}');
      expect({ route, status, error }).toEqual({
        route,
        status: 503,
        error: 'database.unavailable',
      });
    }
  });

  test('POST /v1/metrics answers 503', async () => {
    const response = await fetch(`${API_URL}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(0),
    });

    expect(response.status).toBe(503);
  });
});
