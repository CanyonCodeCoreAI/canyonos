// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { app } from '@api/app';
import { reconcile_live_prompts } from '@api/modules/prompts/prompts.service';
import { with_redis } from '@api/modules/registry/registry.redis';
import type { ScalingPolicy } from '@api/modules/scaling/scaling.types';
import { config } from '@core/env';

import { hashApiKey, TEST_CONTROL_KEY } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { seed_active_agents, seed_running_workflow, TEST_WORKFLOW } from './redis-test.utils';
import { until_ready } from './test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const RANGE_TO = new Date();
const RANGE = {
  from: new Date(RANGE_TO.getTime() - 365 * 86_400_000).toISOString(),
  to: RANGE_TO.toISOString(),
};

const POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 4,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

const PROMPTS = {
  prompts: {
    'app.greet': [
      { version: 'greet-00000001-v1', content: 'Say hello.', updated_at: null, live: true },
    ],
  },
};

const WRONG_KEY = 'not-the-api-key';

type Res = { error: { status: unknown; value: unknown } | null };

const refusal = (res: Res) => ({
  status: res.error?.status as number | undefined,
  ...(res.error?.value as { error?: string; message?: string } | undefined),
});

async function running_workflow(name: string): Promise<string> {
  const { workflow_id } = await create_test_workflow({ name });
  await seed_running_workflow(workflow_id, PROMPTS);
  await seed_active_agents(JSON.stringify(['app.Greeter']));
  // What the registered-workflows tick does: store prompts.yaml's prompts and publish them.
  await with_redis(workflow_id, (redis) =>
    reconcile_live_prompts(redis, workflow_id, TEST_WORKFLOW)
  );
  return workflow_id;
}

const fetch_api = (path: string, init?: RequestInit) => fetch(`${config.app.apiUrl}${path}`, init);

describe('the dashboard API checks the API key', () => {
  test('no Authorization header, or a Basic one, is 401 auth.missing_key', async () => {
    const basic = { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

    for (const res of [await api.workflows.get(), await api.workflows.get({ $headers: basic })]) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_key' });
      expect(refusal(res).message).toBeString();
    }
  });

  test('a key that is not the API key is 401 auth.invalid_key', async () => {
    const res = await api.workflows.get({ $headers: bearer(WRONG_KEY) });

    expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
  });

  test('a refusal says to send a bearer, and a pass does not', async () => {
    const refused = await fetch_api('/workflows', { headers: bearer(WRONG_KEY) });
    const passed = await fetch_api('/workflows', { headers: bearer(TEST_API_KEY) });

    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(passed.status).toBe(200);
    expect(passed.headers.get('www-authenticate')).toBeNull();
  });

  test('the Bearer scheme is matched in any case and the key is trimmed', async () => {
    const res = await api.workflows.get({
      $headers: { authorization: `bearer   ${TEST_API_KEY}  ` },
    });

    expect(res.error).toBeNull();
  });

  test('the API key gets 200 from every GET under a workflow', async () => {
    const workflow_id = await running_workflow('Key Reads Everything');
    const read = { $headers: bearer(TEST_API_KEY) };
    const workflow = api.workflows[workflow_id]!;

    const responses = await Promise.all([
      workflow.get(read),
      workflow.stats.get(read),
      workflow.requests.get({ ...read, $query: { ...RANGE, limit: 20, offset: 0 } }),
      workflow.metrics.kpis.get({ ...read, $query: RANGE }),
      workflow.monitoring.series.get({ ...read, $query: RANGE }),
      workflow.monitoring.logs.get({
        ...read,
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      workflow.monitoring.traces.get({ ...read, $query: { ...RANGE, limit: 200 } }),
      workflow.monitoring.resources.get({ ...read, $query: RANGE }),
      workflow.monitoring.replicas.get(read),
      workflow.monitoring.endpoint.get(read),
      workflow.prompts.get(read),
      workflow.prompts['app.greet']!.get(read),
      workflow.scaling.get(read),
      workflow.scaling.agents.get(read),
      workflow.governance.get(read),
    ]);

    for (const res of responses) expect(res.error).toBeNull();
    expect((await api.resources.overview.get({ ...read, $query: RANGE })).error).toBeNull();
  });

  test('the API key changes a workflow, and a wrong key changes nothing', async () => {
    const workflow_id = await running_workflow('Key Writes');
    const headers = bearer(TEST_API_KEY);
    const wrong = bearer(WRONG_KEY);
    const workflow = api.workflows[workflow_id]!;

    const refused = await Promise.all([
      workflow.scaling.put(POLICY, { headers: wrong }),
      workflow.scaling.delete(undefined, { headers: wrong }),
      workflow.delete(undefined, { headers: wrong }),
      workflow['sample-data'].post({ workflow: 'helloworld' }, { headers: wrong }),
      workflow.prompts['app.greet']!.versions.post({ content: 'Say goodbye.' }, { headers: wrong }),
      workflow.prompts['app.greet']!.live.put({ version: 'greet-00000001-v1' }, { headers: wrong }),
      workflow.governance.agents.Greeter!.put({ requires: [], spend: null }, { headers: wrong }),
      workflow.governance.agents.Greeter!.stopped.put({ stopped: true }, { headers: wrong }),
    ]);
    for (const res of refused) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    }
    expect((await workflow.scaling.get({ $headers: headers })).data).toEqual({
      workflows: { app: { status: 'none' } },
    });

    expect((await workflow.scaling.put(POLICY, { headers })).error).toBeNull();
    expect((await workflow.scaling.get({ $headers: headers })).data).toEqual({
      workflows: { app: { status: 'applied', policy: POLICY } },
    });
    expect((await workflow.scaling.delete(undefined, { headers })).error).toBeNull();
  });

  test('/auth/check answers ok to the API key and 401 to anything else', async () => {
    expect((await api.auth.check.get({ $headers: bearer(TEST_API_KEY) })).data).toEqual({
      ok: true,
    });
    expect(refusal(await api.auth.check.get())).toMatchObject({
      status: 401,
      error: 'auth.missing_key',
    });
    expect(refusal(await api.auth.check.get({ $headers: bearer(WRONG_KEY) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_key',
    });
  });

  test('/auth/status and /healthz answer with no key', async () => {
    expect((await api.auth.status.get()).data).toEqual({ api_key_required: true });
    expect((await api.healthz.get()).error).toBeNull();
  });

  test('tokens and password sign-in are gone: /auth/token, register, login and profile are 404', async () => {
    for (const [method, path] of [
      ['GET', '/auth/token'],
      ['POST', '/auth/register'],
      ['POST', '/auth/login'],
      ['GET', '/auth/profile'],
    ] as const) {
      const response = await fetch_api(path, {
        method,
        headers: { 'content-type': 'application/json', ...bearer(TEST_API_KEY) },
        body: method === 'POST' ? JSON.stringify({ email: 'a@b.c', password: 'password1' }) : null,
      });
      expect(response.status).toBe(404);
    }
  });

  test('a CORS preflight needs no key', async () => {
    const workflow_id = await running_workflow('Preflight');

    const response = await fetch_api(`/workflows/${workflow_id}/scaling`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization'
    );
  });

  test('twenty concurrent requests alternating the key and a wrong one each get their own verdict', async () => {
    const workflow_id = await running_workflow('Concurrent');
    const replicas = api.workflows[workflow_id]!.monitoring.replicas;

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        replicas.get({ $headers: bearer(i % 2 === 0 ? TEST_API_KEY : WRONG_KEY) })
      )
    );

    responses.forEach((res, i) => {
      if (i % 2 === 0) expect(res.error).toBeNull();
      else expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    });
  });

  test('a path that only starts like a guarded one is not guarded', async () => {
    const response = await fetch_api('/workflows-x');

    expect(response.status).toBe(404);
  });
});

// Written here, not read from the guards, so a route mounted outside them shows up: every route
// is one of these, or needs a key.
const OPEN_ROUTES = [
  'OPTIONS /',
  'OPTIONS /*',
  'GET /docs',
  'GET /docs/json',
  'GET /healthz',
  'GET /readyz',
  'GET /auth/status',
  // The OTLP receivers: an agent process holds no API key.
  'POST /v1/traces',
  'POST /v1/metrics',
  'POST /v1/logs',
];
const CONTROL_KEY_PATH = /^\/v1\/workflow-groups(?:\/|$)/;

describe('every route', () => {
  test('is open by name, or checks its key before it reads the request', async () => {
    const routes = app.routes.map(({ method, path }) => ({
      method,
      path,
      route: `${method} ${path}`,
    }));
    expect(OPEN_ROUTES.filter((route) => !routes.some((r) => r.route === route))).toEqual([]);
    const guarded = routes.filter(({ route }) => !OPEN_ROUTES.includes(route));
    expect(guarded.length).toBeGreaterThan(40);

    for (const { method, path, route } of guarded) {
      // The control key on /v1/workflow-groups, never the API key; the API key everywhere else.
      const [key, wrong_key] = CONTROL_KEY_PATH.test(path)
        ? [TEST_CONTROL_KEY, TEST_API_KEY]
        : [TEST_API_KEY, WRONG_KEY];
      // Params, a query and a body that all fail validation: the key is checked first, so 401.
      const url = `http://localhost${path.replace(/:[^/]+/g, 'not-an-id')}?from=never&limit=lots&tail=lots`;
      const send = (headers: Record<string, string>) =>
        app.handle(
          new Request(url, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            ...(method === 'GET' ? {} : { body: '{' }),
          })
        );
      for (const [headers, error] of [
        [{}, 'auth.missing_key'],
        [bearer(wrong_key), 'auth.invalid_key'],
      ] as const) {
        const response = await send(headers);
        const body = (await response.json()) as { error: string };
        expect({ route, status: response.status, error: body.error }).toEqual({
          route,
          status: 401,
          error,
        });
      }
      // And the right key gets past the guard.
      expect({ route, status: (await send(bearer(key))).status }).not.toEqual({
        route,
        status: 401,
      });
    }
  });
});

/** The status line and body of `GET <target>` sent as is over a socket to the running API, which
 * no URL parser resolves first. */
async function raw_get(target: string): Promise<{ status: number; body: string }> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let received = '';
  await Bun.connect({
    hostname: '127.0.0.1',
    port: config.app.port,
    socket: {
      open(socket) {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      },
      data(_, data) {
        received += data.toString();
      },
      close: () => resolve(received),
      error: () => resolve(received),
    },
  });
  const answer = await promise;
  const [head = '', body = ''] = answer.split('\r\n\r\n');
  return { status: Number(head.split(' ')[1]), body };
}

describe('a path with a dot segment', () => {
  // Bun resolves these in request.url, but its router matches the raw path: each reaches a
  // guarded route with `..` or `.` as its id.
  const targets = [
    '/workflows/../monitoring/logs',
    '/workflows/%2e%2e/monitoring/logs',
    '/workflows/%2E%2e/monitoring/logs?limit=1',
    '/workflows/..',
    '/workflows/.',
    '/v1/workflow-groups/..',
    '/v1/workflow-groups/%2e%2e/workflows/x',
  ];

  for (const target of targets) {
    test(`${target} is 400 bad_request with no key, before any guard`, async () => {
      const { status, body } = await raw_get(target);

      expect(status).toBe(400);
      expect(JSON.parse(body)).toMatchObject({
        error: 'bad_request',
        message: 'Path segments `.` and `..` are not allowed',
      });
    });
  }

  test('the same request with no dot segment is 401', async () => {
    expect((await raw_get(`/workflows/${crypto.randomUUID()}/monitoring/logs`)).status).toBe(401);
    expect((await raw_get(`/v1/workflow-groups/${crypto.randomUUID()}`)).status).toBe(401);
  });
});

const SERVER = new URL('../server.ts', import.meta.url).pathname;
const STARTUP_TIMEOUT_MS = 10_000;

let next_port = config.app.port + 100;

/** Starts `src/server.ts` on its own port with `env` over this run's environment. */
function spawn_api(env: Record<string, string>) {
  const port = next_port++;
  const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
    env: { ...process.env, PORT: String(port), API_URL: `http://localhost:${port}`, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { child, url: `http://localhost:${port}` };
}

/** The exit code and stderr of a server that must refuse to start. */
async function refused_start(env: Record<string, string>) {
  const { child } = spawn_api(env);
  const timeout = setTimeout(() => child.kill(), STARTUP_TIMEOUT_MS);
  const code = await child.exited;
  clearTimeout(timeout);
  return { code, stderr: await new Response(child.stderr).text() };
}

async function with_api(env: Record<string, string>, check: (url: string) => Promise<void>) {
  const { child, url } = spawn_api(env);
  try {
    await until_ready(url);
    await check(url);
  } finally {
    child.kill();
    await child.exited;
  }
}

describe('the API reads CANYONOS_API_KEY_HASH at startup', () => {
  test('the hash of another key lets only that key in', async () => {
    const other_key = 'another machine key';

    await with_api({ CANYONOS_API_KEY_HASH: hashApiKey(other_key) }, async (url) => {
      const status = await fetch(`${url}/auth/status`);
      expect(await status.json()).toEqual({ api_key_required: true });
      expect((await fetch(`${url}/workflows`, { headers: bearer(other_key) })).status).toBe(200);
      expect((await fetch(`${url}/workflows`, { headers: bearer(TEST_API_KEY) })).status).toBe(401);
    });
  }, 40_000);

  test('an empty hash starts open: no key needed, and any bearer is ignored', async () => {
    await with_api({ CANYONOS_API_KEY_HASH: '' }, async (url) => {
      const status = await fetch(`${url}/auth/status`);
      expect(await status.json()).toEqual({ api_key_required: false });
      expect((await fetch(`${url}/workflows`)).status).toBe(200);
      expect((await fetch(`${url}/workflows`, { headers: bearer(WRONG_KEY) })).status).toBe(200);
      expect((await fetch(`${url}/auth/check`)).status).toBe(200);
    });
  }, 40_000);

  const malformed: [string, string][] = [
    ['the raw key instead of its hash', TEST_API_KEY],
    ['uppercase hex', hashApiKey(TEST_API_KEY).toUpperCase()],
    ['a hash with a trailing newline', `${hashApiKey(TEST_API_KEY)}\n`],
    ['a truncated hash', hashApiKey(TEST_API_KEY).slice(0, 63)],
  ];

  for (const [label, value] of malformed) {
    test(`${label} refuses to start, naming the variable`, async () => {
      const { code, stderr } = await refused_start({ CANYONOS_API_KEY_HASH: value });

      expect(code).not.toBe(0);
      expect(stderr).toContain('CANYONOS_API_KEY_HASH must be the sha256 of the API key');
    }, 15_000);
  }
});
