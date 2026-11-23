// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { reconcile_live_prompts } from '@api/modules/prompts/prompts.service';
import { with_redis } from '@api/modules/registry/registry.redis';
import type { ScalingPolicy } from '@api/modules/scaling/scaling.types';
import { config } from '@core/env';

import { hashApiKey } from './api-key-test.utils';
import { api, group_workflow, setupE2ETests } from './e2e.setup';
import { refused_start, spawn_api } from './process-test.utils';
import { seed_active_agents, seed_running_workflow, TEST_WORKFLOW } from './redis-test.utils';
import { OPEN_ROUTES, sweep_answer, sweep_routes } from './route-sweep.utils';
import { post_otlp } from './telemetry-test.utils';
import { createApi, raw_request } from './test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';
import type { SpawnedApi } from './process-test.utils';
import type { RouteKind, SweepAnswer, SweptRoute } from './route-sweep.utils';

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
const UNKNOWN_WORKFLOW_ID = '00000000-0000-4000-8000-000000000000';

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

type Client = typeof api;

/** Every GET of `workflow_id`, under /v1/workflows and under its workflow group, and the fleet
 * overview, through `client` with `headers`. The check is wired per routes module, so reaching
 * each proves every composed module serves the caller. */
function read_every_sub_resource(
  client: Client,
  workflow_id: string,
  headers: Record<string, string> = {}
) {
  const read = { $headers: headers };
  const workflow = client.v1.workflows[workflow_id]!;
  const dashboard = client.v1['workflow-groups'][workflow_id]!.workflows[workflow_id]!;
  return Promise.all([
    workflow.get(read),
    dashboard.requests.get({ ...read, $query: { ...RANGE, limit: 20, offset: 0 } }),
    dashboard.metrics.kpis.get({ ...read, $query: RANGE }),
    dashboard.monitoring.series.get({ ...read, $query: RANGE }),
    dashboard.monitoring.logs.get({
      ...read,
      $query: { ...RANGE, limit: 200, errors_only: false },
    }),
    dashboard.monitoring.traces.get({ ...read, $query: { ...RANGE, limit: 200 } }),
    dashboard.monitoring.resources.get({ ...read, $query: RANGE }),
    dashboard.monitoring.replicas.get(read),
    dashboard.monitoring.endpoint.get(read),
    dashboard.prompts.get(read),
    dashboard.prompts['app.greet']!.get(read),
    dashboard.scaling.get(read),
    dashboard.scaling.agents.get(read),
    dashboard.governance.get(read),
    client.v1.resources.overview.get({ ...read, $query: RANGE }),
  ]);
}

/** The ids `client` lists with `headers`. */
async function listed_ids(client: Client, headers: Record<string, string> = {}) {
  const listed = await client.v1.workflows.get({ $headers: headers });
  expect(listed.error).toBeNull();
  return listed.data!.map(({ id }) => id);
}

describe('the dashboard API checks the API key', () => {
  test('no Authorization header, or a Basic one, is 401 auth.missing_key', async () => {
    const basic = { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

    for (const res of [
      await api.v1.workflows.get(),
      await api.v1.workflows.get({ $headers: basic }),
    ]) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_key' });
      expect(refusal(res).message).toBeString();
    }
  });

  test('a key that is not the API key is 401 auth.invalid_key', async () => {
    const res = await api.v1.workflows.get({ $headers: bearer(WRONG_KEY) });
    const dashboard = await group_workflow(UNKNOWN_WORKFLOW_ID).scaling.get({
      $headers: bearer(WRONG_KEY),
    });

    expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    expect(refusal(dashboard)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
  });

  test('a refusal says to send a bearer, and a pass does not', async () => {
    const refused = await fetch_api('/v1/workflows', { headers: bearer(WRONG_KEY) });
    const passed = await fetch_api('/v1/workflows', { headers: bearer(TEST_API_KEY) });

    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(passed.status).toBe(200);
    expect(passed.headers.get('www-authenticate')).toBeNull();
  });

  test('the Bearer scheme is matched in any case and the key is trimmed', async () => {
    const res = await api.v1.workflows.get({
      $headers: { authorization: `bearer   ${TEST_API_KEY}  ` },
    });

    expect(res.error).toBeNull();
  });

  test('the API key reaches the workflow and gets 200 from every GET under it', async () => {
    const workflow_id = await running_workflow('Key Reads Everything');
    const headers = bearer(TEST_API_KEY);

    const responses = await read_every_sub_resource(api, workflow_id, headers);

    for (const res of responses) expect(res.error).toBeNull();
    expect(responses[0].data?.id).toBe(workflow_id);
    expect(await listed_ids(api, headers)).toContain(workflow_id);
  });

  test('a workflow id that does not exist is 404 workflows.not_found once the key is checked', async () => {
    const res = await api.v1.workflows[UNKNOWN_WORKFLOW_ID]!.get({
      $headers: bearer(TEST_API_KEY),
    });

    expect(refusal(res)).toMatchObject({ status: 404, error: 'workflows.not_found' });
  });

  test('a workflow under a workflow group it is not in is 404 workflows.not_found', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Own Group' });
    const { workflow_id: other_group_id } = await create_test_workflow({ name: 'Other Group' });

    const res = await group_workflow(workflow_id, other_group_id).scaling.get({
      $headers: bearer(TEST_API_KEY),
    });

    expect(refusal(res)).toMatchObject({ status: 404, error: 'workflows.not_found' });
  });

  test('a caller with no API key is refused before any workflow is resolved', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'No Key' });
    const workflow = api.v1.workflows[workflow_id]!;

    const refused = await Promise.all([
      workflow.get(),
      group_workflow(workflow_id).prompts.get(),
      group_workflow(workflow_id).scaling.get(),
      api.v1.workflows.get(),
      api.v1.workflows[UNKNOWN_WORKFLOW_ID]!.get(),
    ]);

    for (const res of refused) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_key' });
    }
  });

  test('the API key changes a workflow, and a wrong key changes nothing', async () => {
    const workflow_id = await running_workflow('Key Writes');
    const headers = bearer(TEST_API_KEY);
    const wrong = bearer(WRONG_KEY);
    const dashboard = group_workflow(workflow_id);
    const greeter = dashboard.governance.agents[Bun.randomUUIDv5('app.Greeter', workflow_id)]!;

    const refused = await Promise.all([
      dashboard.scaling.put(POLICY, { headers: wrong }),
      dashboard.scaling.delete(undefined, { headers: wrong }),
      dashboard.history.delete(undefined, { headers: wrong }),
      dashboard['sample-data'].post({ workflow: 'helloworld' }, { headers: wrong }),
      dashboard.prompts['app.greet']!.versions.post(
        { content: 'Say goodbye.' },
        { headers: wrong }
      ),
      dashboard.prompts['app.greet']!.live.put(
        { version: 'greet-00000001-v1' },
        { headers: wrong }
      ),
      greeter.put({ requires: [], spend: null }, { headers: wrong }),
      greeter.stopped.put({ stopped: true }, { headers: wrong }),
    ]);
    for (const res of refused) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    }
    expect((await dashboard.scaling.get({ $headers: headers })).data).toEqual({
      workflows: { app: { status: 'none' } },
    });

    expect((await dashboard.scaling.put(POLICY, { headers })).error).toBeNull();
    expect((await dashboard.scaling.get({ $headers: headers })).data).toEqual({
      workflows: { app: { status: 'applied', policy: POLICY } },
    });
    expect((await dashboard.scaling.delete(undefined, { headers })).error).toBeNull();
  });

  test('/v1/auth/check answers ok to the API key and 401 to anything else', async () => {
    expect((await api.v1.auth.check.get({ $headers: bearer(TEST_API_KEY) })).data).toEqual({
      ok: true,
    });
    expect(refusal(await api.v1.auth.check.get())).toMatchObject({
      status: 401,
      error: 'auth.missing_key',
    });
    expect(refusal(await api.v1.auth.check.get({ $headers: bearer(WRONG_KEY) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_key',
    });
  });

  test('/v1/auth/status and /v1/healthz answer with no key', async () => {
    expect((await api.v1.auth.status.get()).data).toEqual({ api_key_required: true });
    expect((await api.v1.healthz.get()).error).toBeNull();
  });

  test("a workflow group's POST traces takes an empty OTLP export with no key", async () => {
    const response = await post_otlp(UNKNOWN_WORKFLOW_ID, 'traces', new Uint8Array());

    expect(response.status).toBe(200);
  });

  test("a workflow group's POST traces with a group id that is not a UUID is 422 with no key", async () => {
    const response = await post_otlp('not-a-uuid', 'traces', new Uint8Array());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'validation_error' });
  });

  test('POST /v1/traces, /v1/metrics and /v1/logs are gone: 404', async () => {
    for (const signal of ['traces', 'metrics', 'logs']) {
      const response = await fetch_api(`/v1/${signal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: new Uint8Array(),
      });
      expect(response.status).toBe(404);
    }
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

  test('the old routes outside /v1 are gone: /workflows, /healthz, /readyz, /auth/status, /auth/check and /resources/overview are 404', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Old Paths' });

    for (const [method, path] of [
      ['GET', '/workflows'],
      ['GET', `/workflows/${workflow_id}`],
      ['DELETE', `/workflows/${workflow_id}`],
      ['POST', `/workflows/${workflow_id}/sample-data`],
      ['GET', '/healthz'],
      ['GET', '/readyz'],
      ['GET', '/auth/status'],
      ['GET', '/auth/check'],
      ['GET', '/resources/overview'],
    ] as const) {
      const response = await fetch_api(path, {
        method,
        headers: { 'content-type': 'application/json', ...bearer(TEST_API_KEY) },
        body: method === 'POST' ? JSON.stringify({ workflow: 'helloworld' }) : null,
      });
      expect(response.status).toBe(404);
    }
  });

  test('a CORS preflight needs no key', async () => {
    const workflow_id = await running_workflow('Preflight');

    const response = await fetch_api(
      `/v1/workflow-groups/${workflow_id}/workflows/${workflow_id}/scaling`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'authorization',
        },
      }
    );

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization'
    );
  });

  test('twenty concurrent requests alternating the key and a wrong one each get their own verdict', async () => {
    const workflow_id = await running_workflow('Concurrent');
    const replicas = group_workflow(workflow_id).monitoring.replicas;

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
    const response = await fetch_api('/v1/workflows-x');

    expect(response.status).toBe(404);
  });
});

const routes_of = (kind: RouteKind) => sweep_routes().filter((swept) => swept.kind === kind);

/** What each of `routes` answers the API at `url`, sent with `headers`, one after the other. */
async function sweep(
  url: string,
  routes: readonly SweptRoute[],
  headers: Record<string, string>
): Promise<SweepAnswer[]> {
  const answers: SweepAnswer[] = [];
  for (const swept of routes) answers.push(await sweep_answer(url, swept, headers));
  return answers;
}

/** The answers of `routes` that each refuse with 401 `error`. */
const refused_with = (routes: readonly SweptRoute[], error: string) =>
  routes.map(({ route }) => ({ route, status: 401, error }));

describe('every route', () => {
  test('is open by name, or takes the API key', () => {
    const routes = sweep_routes();

    expect(OPEN_ROUTES.filter((route) => !routes.some((swept) => swept.route === route))).toEqual(
      []
    );
    expect(routes.filter(({ kind }) => kind === 'unguarded').map(({ route }) => route)).toEqual([]);
    expect(routes_of('api_key').length).toBeGreaterThan(30);
    expect(routes_of('api_key').map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'GET /v1/workflows/',
        'GET /v1/workflows/:workflow_id',
        'DELETE /v1/workflow-groups/:workflow_group_id/workflows/:workflow_id/history',
        'POST /v1/workflow-groups/:workflow_group_id/workflows/:workflow_id/sample-data',
        'GET /v1/workflow-groups',
        'PUT /v1/workflow-groups/:workflow_group_id',
        'DELETE /v1/workflow-groups/:workflow_group_id',
      ])
    );
  });

  // Params, a query and a body that all fail validation: the key is checked first, so 401.
  test('that takes the API key refuses no key or another before it reads the request, and the key gets past', async () => {
    const routes = routes_of('api_key');
    const url = config.app.apiUrl;

    expect(await sweep(url, routes, {})).toEqual(refused_with(routes, 'auth.missing_key'));
    expect(await sweep(url, routes, bearer(WRONG_KEY))).toEqual(
      refused_with(routes, 'auth.invalid_key')
    );
    for (const answer of await sweep(url, routes, bearer(TEST_API_KEY))) {
      expect(answer).not.toMatchObject({ status: 401 });
    }
  });

  test('that is open answers with no key', async () => {
    for (const answer of await sweep(config.app.apiUrl, routes_of('open'), {})) {
      expect(answer).not.toMatchObject({ status: 401 });
    }
  });
});

describe('a path with a dot segment', () => {
  // Bun resolves these in request.url, but its router matches the raw path: each reaches a
  // guarded route with `..` or `.` as its id.
  const group = `/v1/workflow-groups/${UNKNOWN_WORKFLOW_ID}`;
  const targets = [
    `${group}/workflows/../monitoring/logs`,
    `${group}/workflows/%2e%2e/monitoring/logs`,
    `${group}/workflows/%2E%2e/monitoring/logs?limit=1`,
    '/v1/workflows/..',
    '/v1/workflows/.',
    '/v1/workflow-groups/..',
    '/v1/workflow-groups/%2e%2e/workflows',
  ];

  for (const target of targets) {
    test(`${target} is 400 bad_request with no key, before any guard`, async () => {
      const { status, body } = await raw_request('GET', target);

      expect(status).toBe(400);
      expect(JSON.parse(body)).toMatchObject({
        error: 'bad_request',
        message: 'Path segments `.` and `..` are not allowed',
      });
    });
  }

  test('the same request with no dot segment is 401', async () => {
    expect(
      (await raw_request('GET', `${group}/workflows/${crypto.randomUUID()}/monitoring/logs`)).status
    ).toBe(401);
    expect((await raw_request('GET', `/v1/workflow-groups/${crypto.randomUUID()}`)).status).toBe(
      401
    );
  });
});

describe('a dashboard path with a backslash', () => {
  // request.url reads `\` as `/` but the router does not: each reaches a workflow group's route.
  const group = `/v1/workflow-groups/${UNKNOWN_WORKFLOW_ID}`;
  const targets = [
    ['GET', `${group}\\workflows\\${UNKNOWN_WORKFLOW_ID}\\requests`],
    ['DELETE', `${group}/workflows/${UNKNOWN_WORKFLOW_ID}\\requests`],
  ] as const;

  // Both guards answer auth.missing_key; only the dashboard's, after the CORS plugin, adds CORS.
  for (const [method, target] of targets) {
    test(`${method} ${target} still takes the API key, with no CORS answer`, async () => {
      const { status, headers, body } = await raw_request(method, target, {
        origin: 'http://elsewhere.example',
      });

      expect(status).toBe(401);
      expect(JSON.parse(body)).toMatchObject({ error: 'auth.missing_key' });
      expect(headers.get('access-control-allow-origin')).toBeNull();
    });
  }
});

describe('the API reads CANYONOS_API_KEY_HASH at startup', () => {
  test('the hash of another key lets only that key in', async () => {
    const other_key = 'another machine key';
    const other = await spawn_api({ CANYONOS_API_KEY_HASH: hashApiKey(other_key) });
    try {
      const status = await fetch(`${other.url}/v1/auth/status`);
      expect(await status.json()).toEqual({ api_key_required: true });
      expect(
        (await fetch(`${other.url}/v1/workflows`, { headers: bearer(other_key) })).status
      ).toBe(200);
      expect(
        (await fetch(`${other.url}/v1/workflows`, { headers: bearer(TEST_API_KEY) })).status
      ).toBe(401);
    } finally {
      await other.stop();
    }
  }, 40_000);

  const malformed: [string, string][] = [
    ['the raw key instead of its hash', TEST_API_KEY],
    ['uppercase hex', hashApiKey(TEST_API_KEY).toUpperCase()],
    ['a hash with a trailing newline', `${hashApiKey(TEST_API_KEY)}\n`],
    ['a truncated hash', hashApiKey(TEST_API_KEY).slice(0, 63)],
  ];

  for (const [label, value] of malformed) {
    test(`${label} refuses to start, naming the variable`, async () => {
      const { exit_code, output } = await refused_start({ CANYONOS_API_KEY_HASH: value });

      expect(exit_code).not.toBe(0);
      expect(output).toContain('CANYONOS_API_KEY_HASH must be the sha256 of the API key');
    }, 15_000);
  }
});

const STALE_BEARER = bearer('a key from before the API ran open');

describe('an API started with an empty CANYONOS_API_KEY_HASH', () => {
  let open: SpawnedApi;
  let client: Client;

  beforeAll(async () => {
    open = await spawn_api({ CANYONOS_API_KEY_HASH: '' });
    client = createApi(open.url);
  }, 40_000);

  afterAll(async () => {
    await open.stop();
  });

  test('/v1/auth/status reports that no key is needed', async () => {
    expect((await client.v1.auth.status.get()).data).toEqual({ api_key_required: false });
  });

  test('/v1/auth/check answers ok with no key', async () => {
    expect((await client.v1.auth.check.get()).data).toEqual({ ok: true });
  });

  test('a caller with no key lists workflows and changes scaling', async () => {
    const workflow_id = await running_workflow('Keyless Writes');

    expect(await listed_ids(client)).toContain(workflow_id);
    const dashboard = client.v1['workflow-groups'][workflow_id]!.workflows[workflow_id]!;
    expect((await dashboard.scaling.put(POLICY)).error).toBeNull();
  });

  // A key left in a browser from before the API ran open must not turn into a 401.
  test('a stale bearer is ignored', async () => {
    const workflow_id = await running_workflow('Stale Bearer');

    expect(await listed_ids(client, STALE_BEARER)).toContain(workflow_id);
    const dashboard = client.v1['workflow-groups'][workflow_id]!.workflows[workflow_id]!;
    const saved = await dashboard.scaling.put(POLICY, { headers: STALE_BEARER });
    expect(saved.error).toBeNull();
  });

  test('a caller with no headers lists the workflows and reaches every sub-resource', async () => {
    const workflow_id = await running_workflow('Open Workflow');

    for (const res of await read_every_sub_resource(client, workflow_id)) {
      expect(res.error).toBeNull();
    }
    expect(await listed_ids(client)).toContain(workflow_id);
  });

  test('a browser on another origin gets no CORS answer from /v1/workflow-groups', async () => {
    const preflight = await fetch(`${open.url}/v1/workflow-groups/${UNKNOWN_WORKFLOW_ID}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://elsewhere.example', 'access-control-request-method': 'PUT' },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a workflow id that does not exist is 404 workflows.not_found', async () => {
    const res = await client.v1.workflows[UNKNOWN_WORKFLOW_ID]!.get();

    expect(refusal(res)).toMatchObject({ status: 404, error: 'workflows.not_found' });
  });

  test('no route is 401 with no key or a stale bearer', async () => {
    const routes = [...routes_of('api_key'), ...routes_of('open')];
    for (const headers of [{}, STALE_BEARER]) {
      for (const answer of await sweep(open.url, routes, headers)) {
        expect(answer).not.toMatchObject({ status: 401 });
      }
    }
  });
});
