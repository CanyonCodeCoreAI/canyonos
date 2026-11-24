// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { reconcile_live_prompts } from '@api/modules/prompts/prompts.service';
import { with_redis } from '@api/modules/registry/registry.redis';
import { WORKFLOW_GROUPS_PATH } from '@api/modules/workflow-groups/workflow-groups.caller';
import type { ScalingPolicy } from '@api/modules/scaling/scaling.types';
import { config } from '@core/env';

import { hashApiKey } from './api-key-test.utils';
import { api, group_workflow, setupE2ETests } from './e2e.setup';
import { refused_start, spawn_api } from './process-test.utils';
import { seed_active_agents, seed_running_workflow, TEST_WORKFLOW } from './redis-test.utils';
import { OPEN_ROUTES, sweep_answer, sweep_routes } from './route-sweep.utils';
import { post_otlp } from './telemetry-test.utils';
import { createApi, raw_request } from './test.utils';
import {
  bearer,
  create_test_workflow,
  create_test_workflow_group,
  TEST_API_KEY,
  TEST_DEPLOY_KEY,
} from './workflow-test.utils';
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

async function running_workflow(name: string, api_key: string | null = TEST_API_KEY) {
  const { workflow_id } = await create_test_workflow({ name, api_key });
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

/** The ids the fleet overview shows with `headers`. */
async function overview_ids(headers: Record<string, string> = {}) {
  const overview = await api.v1.resources.overview.get({ $headers: headers, $query: RANGE });
  expect(overview.error).toBeNull();
  return overview.data!.workflows.map(({ id }) => id);
}

/** The workflow group ids the list of workflow groups shows with `headers`. */
async function listed_group_ids(headers: Record<string, string> = {}) {
  const listed = await api.v1['workflow-groups'].get({ $headers: headers });
  expect(listed.error).toBeNull();
  return listed.data!.workflow_groups.map(({ workflow_group_id }) => workflow_group_id);
}

describe('a workflow group takes its own API key', () => {
  test('no Authorization header, or a Basic one, is 401 auth.missing_key', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Basic' });
    const basic = { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

    for (const res of [
      await group_workflow(workflow_id).scaling.get(),
      await group_workflow(workflow_id).scaling.get({ $headers: basic }),
      await api.v1.auth.check.get({ $headers: basic }),
    ]) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_key' });
      expect(refusal(res).message).toBeString();
    }
  });

  test('a key that is not the workflow group key is 401 auth.invalid_key, naming the workflow group', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Wrong Key' });

    const res = await api.v1.workflows.get({ $headers: bearer(WRONG_KEY) });
    const dashboard = await group_workflow(workflow_id).scaling.get({
      $headers: bearer(WRONG_KEY),
    });

    expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    expect(refusal(dashboard)).toMatchObject({ status: 401, error: 'auth.invalid_key' });
    expect(refusal(dashboard).message).toContain(`workflow group ${workflow_id}`);
  });

  test('a refusal says to send a bearer, and a pass does not', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Bearer Header' });
    const path = `/v1/workflow-groups/${workflow_id}/workflows/${workflow_id}/scaling`;

    const refused = await fetch_api(path, { headers: bearer(WRONG_KEY) });
    const passed = await fetch_api(path, { headers: bearer(TEST_API_KEY) });

    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(passed.status).not.toBe(401);
    expect(passed.headers.get('www-authenticate')).toBeNull();
  });

  test('the Bearer scheme is matched in any case and the key is trimmed', async () => {
    const workflow_id = await running_workflow('Any Case');
    const headers = { authorization: `bearer   ${TEST_API_KEY}  ` };

    expect((await group_workflow(workflow_id).scaling.get({ $headers: headers })).error).toBeNull();
    expect(await listed_ids(api, headers)).toContain(workflow_id);
  });

  test('the key reaches its workflow and gets 200 from every GET under it', async () => {
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

  test("a caller with no key is refused a keyed workflow group's routes before any workflow is resolved, and lists none of its workflows", async () => {
    const { workflow_id } = await create_test_workflow({ name: 'No Key' });

    const refused = await Promise.all([
      group_workflow(workflow_id).prompts.get(),
      group_workflow(workflow_id).scaling.get(),
      group_workflow(UNKNOWN_WORKFLOW_ID, workflow_id).scaling.get(),
    ]);

    for (const res of refused) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_key' });
    }
    expect(refusal(await api.v1.workflows[workflow_id]!.get())).toMatchObject({
      status: 404,
      error: 'workflows.not_found',
    });
    expect(await listed_ids(api)).not.toContain(workflow_id);
  });

  test('the key changes a workflow, and a wrong key changes nothing', async () => {
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

  test('/v1/auth/check answers ok to a workflow group key and 401 to anything else', async () => {
    await create_test_workflow_group();

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

  test('/v1/auth/status says a key is needed once a workflow group has one, and /v1/healthz answers with no key', async () => {
    await create_test_workflow_group();

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

  test('a browser on another origin gets no CORS answer from /v1/workflow-groups', async () => {
    const preflight = await fetch_api(`${WORKFLOW_GROUPS_PATH}/${UNKNOWN_WORKFLOW_ID}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://elsewhere.example',
        'access-control-request-method': 'PUT',
        ...bearer(TEST_DEPLOY_KEY),
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a path that only starts like a guarded one is not guarded', async () => {
    const response = await fetch_api('/v1/workflows-x');

    expect(response.status).toBe(404);
  });
});

const routes_of = (kind: RouteKind) => sweep_routes().filter((swept) => swept.kind === kind);

/** The /v1/workflow-groups routes on one workflow group the deploy key opens: all but the list. */
const deploy_routes = () =>
  routes_of('deploy_key').filter(({ path }) => path.startsWith(`${WORKFLOW_GROUPS_PATH}/:`));

const reads = (routes: readonly SweptRoute[]) => routes.filter(({ method }) => method === 'GET');

/** What each of `routes` answers the API at `url`, sent with `headers` and the path parameters
 * `params` names, one after the other. */
async function sweep(
  url: string,
  routes: readonly SweptRoute[],
  headers: Record<string, string>,
  params: Record<string, string> = {}
): Promise<SweepAnswer[]> {
  const answers: SweepAnswer[] = [];
  for (const swept of routes) answers.push(await sweep_answer(url, swept, headers, '{', params));
  return answers;
}

/** The answers of `routes` that each refuse with 401 `error`. */
const refused_with = (routes: readonly SweptRoute[], error: string, status = 401) =>
  routes.map(({ route }) => ({ route, status, error }));

/** The answers of `answers` that are 401. */
const unauthorized_of = (answers: readonly SweepAnswer[]) =>
  answers.filter(({ status }) => status === 401);

describe('two workflow groups, each with its own key', () => {
  const KA = `workflow-group-a-${crypto.randomUUID()}`;
  const KB = `workflow-group-b-${crypto.randomUUID()}`;
  let a = '';
  let b = '';
  let open = '';
  let unrecorded = { workflow_id: '', workflow_group_id: '' };
  let ungrouped = '';
  const url = () => config.app.apiUrl;
  const of = (workflow_id: string) => ({ workflow_group_id: workflow_id, workflow_id });

  beforeAll(async () => {
    // In the database only: no controller runs them, so a route past the key may answer 404
    // registry.workflow_not_running, but never 401.
    ({ workflow_id: a } = await create_test_workflow({ name: 'Group A', api_key: KA }));
    ({ workflow_id: b } = await create_test_workflow({ name: 'Group B', api_key: KB }));
    ({ workflow_id: open } = await create_test_workflow({ name: 'Open Group', api_key: null }));
    unrecorded = await create_test_workflow({
      name: 'No Group Row',
      workflow_group_id: crypto.randomUUID(),
    });
    const [row] = await db
      .insert(workflows)
      .values({ name: 'No Workflow Group' })
      .returning({ id: workflows.id });
    ungrouped = row!.id;
  });

  test("KA reaches every dashboard route of A, and B's are 404 to it before it reads the request: KA is a good key, B's workflows are not its own", async () => {
    const routes = routes_of('group_key');

    expect(unauthorized_of(await sweep(url(), reads(routes), bearer(KA), of(a)))).toEqual([]);
    expect(await sweep(url(), routes, bearer(KA), of(b))).toEqual(
      refused_with(routes, 'workflows.not_found', 404)
    );
    expect(await sweep(url(), routes, {}, of(b))).toEqual(refused_with(routes, 'auth.missing_key'));
    for (const res of await read_every_sub_resource(api, a, bearer(KA))) {
      expect(refusal(res).status).not.toBe(401);
    }
  });

  test("KA is refused on B's Docker routes, reads and changes alike; KB and the deploy key get past", async () => {
    const routes = deploy_routes();
    // Every route but the stop, which would stop B; the stop with its own key is the Docker
    // suite's (e2e.workflow-groups).
    const harmless = routes.filter(
      ({ route }) => route !== 'DELETE /v1/workflow-groups/:workflow_group_id'
    );
    expect(harmless.some(({ method }) => method !== 'GET')).toBe(true);

    expect(await sweep(url(), routes, bearer(KA), of(b))).toEqual(
      refused_with(routes, 'auth.invalid_key')
    );
    expect(await sweep(url(), routes, {}, of(b))).toEqual(refused_with(routes, 'auth.missing_key'));
    for (const [key, workflow_group_id] of [
      [KA, a],
      [KB, b],
      [TEST_DEPLOY_KEY, a],
      [TEST_DEPLOY_KEY, b],
    ] as const) {
      const answers = await sweep(url(), harmless, bearer(key), of(workflow_group_id));
      expect(unauthorized_of(answers)).toEqual([]);
    }
  });

  test("a workflow group's key opens its Docker routes with its id percent-encoded in the path, as the router reads it", async () => {
    const encoded = `%${b.charCodeAt(0).toString(16)}${b.slice(1)}`;
    const status = (headers: Record<string, string>) =>
      fetch_api(`${WORKFLOW_GROUPS_PATH}/${encoded}`, { headers });

    expect((await status(bearer(KB))).status).not.toBe(401);
    expect((await status(bearer(KA))).status).toBe(401);
    expect((await status({})).status).toBe(401);
  });

  test('the list of workflow groups is 401 to a key that opens none', async () => {
    expect(
      refusal(await api.v1['workflow-groups'].get({ $headers: bearer(WRONG_KEY) }))
    ).toMatchObject({ status: 401, error: 'auth.invalid_key' });
  });

  const registration = (names: Record<string, string>) => ({
    workflows: names,
    redis_host: 'canyonos-e2e-auth-redis-localhost',
    redis_port: config.canyonos.redisPort,
    redis_password: '',
    redis_tls: null,
  });
  const register = (workflow_group_id: string, headers: Record<string, string>, body: unknown) =>
    fetch_api(`${WORKFLOW_GROUPS_PATH}/${workflow_group_id}/dashboard`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test("a registration with KA, or with no key on the open workflow group, never takes B's workflow: B keeps it and KA gets no access to it", async () => {
    const taking = registration({ [b]: 'Taken' });

    const with_ka = await register(a, bearer(KA), taking);
    const with_none = await register(open, {}, taking);

    for (const refused of [with_ka, with_none]) {
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: 'registry.workflow_taken' });
    }
    expect((await api.v1.workflows[b]!.get({ $headers: bearer(KB) })).data).toMatchObject({
      id: b,
      workflow_group_id: b,
    });
    expect(refusal(await api.v1.workflows[b]!.get({ $headers: bearer(KA) }))).toMatchObject({
      status: 404,
      error: 'workflows.not_found',
    });
    expect(refusal(await group_workflow(b, a).scaling.get({ $headers: bearer(KA) }))).toMatchObject(
      { status: 404, error: 'workflows.not_found' }
    );
    expect(await listed_ids(api, bearer(KA))).not.toContain(b);
    expect(await listed_ids(api)).not.toContain(b);
  });

  test('a registration moves a workflow out of a workflow group the caller opens: with its key, or with the deploy key', async () => {
    const KC = `workflow-group-c-${crypto.randomUUID()}`;
    const { workflow_id: c } = await create_test_workflow({ name: 'Group C', api_key: KC });
    const { workflow_id: d } = await create_test_workflow({ name: 'Group D', api_key: KC });
    const { workflow_id: moved } = await create_test_workflow({ name: 'Moved', api_key: null });

    // KC opens both C and D: C's workflow may go into D.
    const into_d = await register(d, bearer(KC), registration({ [c]: 'From C' }));
    expect(into_d.status).toBe(200);
    expect((await api.v1.workflows[c]!.get({ $headers: bearer(KC) })).data?.workflow_group_id).toBe(
      d
    );
    // The deploy key moves any workflow: the machine's own deploys do.
    const into_a = await register(a, bearer(TEST_DEPLOY_KEY), registration({ [moved]: 'Moved' }));
    expect(into_a.status).toBe(200);
    expect((await api.v1.workflows[moved]!.get({ $headers: bearer(KA) })).data).toMatchObject({
      workflow_group_id: a,
    });
    // Its own key registers its own workflows again, as `canyonos serve` does.
    expect((await register(a, bearer(KA), registration({ [a]: 'Group A' }))).status).toBe(200);
  });

  test('a new workflow group takes the deploy key only', async () => {
    const created = `${WORKFLOW_GROUPS_PATH}/${crypto.randomUUID()}`;
    const put = (headers: Record<string, string>) =>
      fetch_api(created, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'new', config: 'workflow_group_id: x\n', env: null }),
      });

    const with_ka = await put(bearer(KA));
    const with_none = await put({});
    const with_deploy_key = await put(bearer(TEST_DEPLOY_KEY));

    expect(with_ka.status).toBe(401);
    expect(await with_ka.json()).toMatchObject({ error: 'auth.invalid_key' });
    expect(with_none.status).toBe(401);
    expect(await with_none.json()).toMatchObject({ error: 'auth.missing_key' });
    expect(with_deploy_key.status).not.toBe(401);
  });

  test('a PUT whose api_key_hash is not a sha256 in lowercase hex is 422 and changes no key', async () => {
    for (const api_key_hash of ['not-a-hash', 'A'.repeat(64), 'a'.repeat(63)]) {
      const res = await fetch_api(`${WORKFLOW_GROUPS_PATH}/${a}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...bearer(KA) },
        body: JSON.stringify({ name: 'a', config: 'target: docker\n', env: null, api_key_hash }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'validation_error' });
    }
    expect(refusal(await group_workflow(a).scaling.get({ $headers: bearer(KA) })).status).not.toBe(
      401
    );
  });

  // A stopped workflow group keeping its key, and a key changed by a PUT, are the Docker suite's
  // (e2e.workflow-groups), through the real stop and the real PUT.

  test('the routes with no workflow group in the path answer KA with A and the open groups only', async () => {
    const headers = bearer(KA);

    const listed = await listed_ids(api, headers);
    expect(listed).toEqual(expect.arrayContaining([a, open]));
    expect(listed).not.toContain(b);
    expect((await api.v1.workflows[a]!.get({ $headers: headers })).data?.id).toBe(a);
    expect((await api.v1.workflows[open]!.get({ $headers: headers })).data?.id).toBe(open);
    expect(refusal(await api.v1.workflows[b]!.get({ $headers: headers }))).toMatchObject({
      status: 404,
      error: 'workflows.not_found',
    });

    const overview = await overview_ids(headers);
    expect(overview).toEqual(expect.arrayContaining([a, open]));
    expect(overview).not.toContain(b);

    const groups = await listed_group_ids(headers);
    expect(groups).toEqual(expect.arrayContaining([a, open]));
    expect(groups).not.toContain(b);
    expect(await listed_group_ids(bearer(TEST_DEPLOY_KEY))).toEqual(
      expect.arrayContaining([a, b, open])
    );
  });

  test('an open workflow group needs no key; with no key the other routes show the open ones only', async () => {
    for (const res of await read_every_sub_resource(api, open)) {
      expect(refusal(res).status).not.toBe(401);
    }
    expect(
      refusal(await group_workflow(open).scaling.get({ $headers: bearer(KB) })).status
    ).not.toBe(401);

    const listed = await listed_ids(api);
    expect(listed).toContain(open);
    expect(listed).not.toContain(a);
    expect(listed).not.toContain(b);
    const overview = await overview_ids();
    expect(overview).toContain(open);
    expect(overview).not.toContain(a);
    const groups = await listed_group_ids();
    expect(groups).toContain(open);
    expect(groups).not.toContain(a);
    expect(unauthorized_of(await sweep(url(), reads(deploy_routes()), {}, of(open)))).toEqual([]);
  });

  test("a workflow whose workflow group has no row, or that has no workflow group, is nobody's", async () => {
    const { workflow_id, workflow_group_id } = unrecorded;
    for (const [headers, status] of [
      [{}, 401],
      [bearer(TEST_DEPLOY_KEY), 401],
      [bearer(TEST_API_KEY), 404],
    ] as const) {
      const res = await group_workflow(workflow_id, workflow_group_id).scaling.get({
        $headers: headers,
      });
      expect(refusal(res).status).toBe(status);
    }
    for (const headers of [{}, bearer(TEST_API_KEY), bearer(KA)]) {
      const listed = await listed_ids(api, headers);
      expect(listed).not.toContain(workflow_id);
      expect(listed).not.toContain(ungrouped);
      expect(await overview_ids(headers)).not.toContain(workflow_id);
      for (const hidden of [workflow_id, ungrouped]) {
        expect(refusal(await api.v1.workflows[hidden]!.get({ $headers: headers }))).toMatchObject({
          status: 404,
          error: 'workflows.not_found',
        });
      }
    }
  });

  test('/v1/auth/check answers ok to KA and KB, and 401 to a wrong key', async () => {
    for (const key of [KA, KB]) {
      expect((await api.v1.auth.check.get({ $headers: bearer(key) })).data).toEqual({ ok: true });
    }
    expect(refusal(await api.v1.auth.check.get({ $headers: bearer(WRONG_KEY) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_key',
    });
  });
});

describe('every route', () => {
  test('is open by name, or takes a key', () => {
    const routes = sweep_routes();

    expect(OPEN_ROUTES.filter((route) => !routes.some((swept) => swept.route === route))).toEqual(
      []
    );
    expect(routes.filter(({ kind }) => kind === 'unguarded').map(({ route }) => route)).toEqual([]);
    expect(routes_of('group_key').length).toBeGreaterThan(20);
    expect(routes_of('group_key').map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'DELETE /v1/workflow-groups/:workflow_group_id/workflows/:workflow_id/history',
        'POST /v1/workflow-groups/:workflow_group_id/workflows/:workflow_id/sample-data',
      ])
    );
    expect(routes_of('workflows_key').map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'GET /v1/workflows/',
        'GET /v1/workflows/:workflow_id',
        'GET /v1/resources/overview',
        'GET /v1/auth/check',
      ])
    );
    expect(routes_of('deploy_key').map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'GET /v1/workflow-groups',
        'PUT /v1/workflow-groups/:workflow_group_id',
        'DELETE /v1/workflow-groups/:workflow_group_id',
      ])
    );
  });

  // Params, a query and a body that all fail validation: the key is checked first, so 401.
  test("that takes its workflow group's key refuses no key or another before it reads the request", async () => {
    const routes = routes_of('group_key');
    const url = config.app.apiUrl;

    expect(await sweep(url, routes, {})).toEqual(refused_with(routes, 'auth.missing_key'));
    expect(await sweep(url, routes, bearer(WRONG_KEY))).toEqual(
      refused_with(routes, 'auth.invalid_key')
    );
  });

  test('that answers with what the key opens refuses a wrong key before it reads the request, and takes a workflow group key', async () => {
    await create_test_workflow_group();
    const routes = routes_of('workflows_key');
    const url = config.app.apiUrl;

    expect(await sweep(url, routes, bearer(WRONG_KEY))).toEqual(
      refused_with(routes, 'auth.invalid_key')
    );
    expect(unauthorized_of(await sweep(url, routes, bearer(TEST_API_KEY)))).toEqual([]);
    expect(unauthorized_of(await sweep(url, routes, {})).map(({ route }) => route)).toEqual([
      'GET /v1/auth/check',
    ]);
  });

  test('on Docker, that takes the deploy key refuses no key or another for a workflow group it does not know, before it reads the request', async () => {
    const routes = deploy_routes();
    const url = config.app.apiUrl;

    expect(await sweep(url, routes, {})).toEqual(refused_with(routes, 'auth.missing_key'));
    expect(await sweep(url, routes, bearer(TEST_API_KEY))).toEqual(
      refused_with(routes, 'auth.invalid_key')
    );
    expect(unauthorized_of(await sweep(url, routes, bearer(TEST_DEPLOY_KEY)))).toEqual([]);
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
    test(`${method} ${target} takes the deploy key, with no CORS answer`, async () => {
      const { status, headers, body } = await raw_request(method, target, {
        origin: 'http://elsewhere.example',
      });

      expect(status).toBe(401);
      expect(JSON.parse(body)).toMatchObject({ error: 'auth.missing_key' });
      expect(headers.get('access-control-allow-origin')).toBeNull();
    });
  }

  test("a workflow group's key does not open a route the backslash took it to", async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Backslash' });
    const { status, body } = await raw_request(
      'GET',
      `/v1/workflow-groups/${workflow_id}\\workflows\\${workflow_id}\\requests`,
      bearer(TEST_API_KEY)
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'auth.invalid_key' });
  });
});

const new_group_put = (url: string, headers: Record<string, string>) =>
  fetch(`${url}${WORKFLOW_GROUPS_PATH}/${crypto.randomUUID()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'new', config: 'workflow_group_id: x\n', env: null }),
  });

describe('the API reads CANYONOS_DEPLOY_KEY_HASH at startup', () => {
  test('the hash of another deploy key lets only that key create a workflow group', async () => {
    const other_key = 'another machine deploy key';
    const other = await spawn_api({ CANYONOS_DEPLOY_KEY_HASH: hashApiKey(other_key) });
    try {
      expect((await new_group_put(other.url, bearer(other_key))).status).not.toBe(401);
      expect((await new_group_put(other.url, bearer(TEST_DEPLOY_KEY))).status).toBe(401);
    } finally {
      await other.stop();
    }
  }, 40_000);

  const malformed: [string, string][] = [
    ['the raw key instead of its hash', TEST_DEPLOY_KEY],
    ['uppercase hex', hashApiKey(TEST_DEPLOY_KEY).toUpperCase()],
    ['a hash with a trailing newline', `${hashApiKey(TEST_DEPLOY_KEY)}\n`],
    ['a truncated hash', hashApiKey(TEST_DEPLOY_KEY).slice(0, 63)],
  ];

  for (const [label, value] of malformed) {
    test(`${label} refuses to start, naming the variable`, async () => {
      const { exit_code, output } = await refused_start({ CANYONOS_DEPLOY_KEY_HASH: value });

      expect(exit_code).not.toBe(0);
      expect(output).toContain('CANYONOS_DEPLOY_KEY_HASH must be the sha256 of the key');
    }, 15_000);
  }

  test('a malformed SEED_DEV_API_KEY_HASH refuses to start, naming the variable', async () => {
    const { exit_code, output } = await refused_start({ SEED_DEV_API_KEY_HASH: TEST_API_KEY });

    expect(exit_code).not.toBe(0);
    expect(output).toContain('SEED_DEV_API_KEY_HASH must be the sha256 of the key');
  }, 15_000);
});

describe('an API started with an empty CANYONOS_DEPLOY_KEY_HASH', () => {
  let open: SpawnedApi;

  beforeAll(async () => {
    open = await spawn_api({ CANYONOS_DEPLOY_KEY_HASH: '' });
  }, 40_000);

  afterAll(async () => {
    await open.stop();
  });

  test('a new workflow group takes no key', async () => {
    expect((await new_group_put(open.url, {})).status).not.toBe(401);
  });

  test("a workflow group's routes still take its key", async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Keyed Without A Deploy Key' });

    for (const path of [
      `${WORKFLOW_GROUPS_PATH}/${workflow_id}`,
      `${WORKFLOW_GROUPS_PATH}/${workflow_id}/workflows/${workflow_id}/scaling`,
    ]) {
      expect((await fetch(`${open.url}${path}`)).status).toBe(401);
      expect((await fetch(`${open.url}${path}`, { headers: bearer(WRONG_KEY) })).status).toBe(401);
      expect(
        (await fetch(`${open.url}${path}`, { headers: bearer(TEST_API_KEY) })).status
      ).not.toBe(401);
    }
  });

  test("a workflow group's routes take its key with its id percent-encoded in the path, as the router reads it", async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Encoded Without A Deploy Key' });
    const encoded = `%${workflow_id.charCodeAt(0).toString(16)}${workflow_id.slice(1)}`;
    const path = `${open.url}${WORKFLOW_GROUPS_PATH}/${encoded}`;
    const put = (headers: Record<string, string>) =>
      fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          name: 'taken',
          config: 'target: docker\n',
          env: null,
          api_key_hash: '',
        }),
      });

    expect((await fetch(path)).status).toBe(401);
    expect((await put({})).status).toBe(401);
    expect((await put(bearer(WRONG_KEY))).status).toBe(401);
    expect((await fetch(path, { headers: bearer(TEST_API_KEY) })).status).not.toBe(401);
    // Nothing opened it: its key still holds.
    expect(
      (
        await fetch(`${open.url}${WORKFLOW_GROUPS_PATH}/${workflow_id}`, {
          headers: bearer(TEST_API_KEY),
        })
      ).status
    ).not.toBe(401);
  });

  // Every workflow group, recorded or not: past the key, the list asks Docker, off here.
  test('the list of workflow groups takes no key', async () => {
    const listed = await fetch(`${open.url}${WORKFLOW_GROUPS_PATH}`);

    expect(listed.status).toBe(503);
    expect(await listed.json()).toMatchObject({ error: 'docker.disabled' });
  });
});

/** A database of its own beside the suite's, emptied, for an API whose workflow groups are only
 * the ones the test makes. */
async function empty_database(suffix: string): Promise<string> {
  const url = new URL(config.database.url);
  const name = `${decodeURIComponent(url.pathname.slice(1))}_${suffix}`;
  const admin_url = new URL(url);
  admin_url.pathname = '/postgres';
  const admin = postgres(admin_url.toString(), { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  url.pathname = `/${name}`;
  return url.toString();
}

const STALE_BEARER = bearer('a key from before the workflow groups ran open');

describe('an API whose workflow groups have no key', () => {
  let open: SpawnedApi;
  let client: Client;
  let database: postgres.Sql;
  const workflow_id = crypto.randomUUID();

  beforeAll(async () => {
    const url = await empty_database('open_groups');
    open = await spawn_api({ DATABASE_URL: url });
    client = createApi(open.url);
    database = postgres(url, { max: 1, onnotice: () => undefined });
    await database`INSERT INTO workflow_groups (id) VALUES (${workflow_id})`;
    await database`INSERT INTO workflows (id, name, workflow_group_id) VALUES (${workflow_id}, 'Open', ${workflow_id})`;
  }, 40_000);

  afterAll(async () => {
    await database.end();
    await open.stop();
  });

  test('/v1/auth/status reports that no key is needed', async () => {
    expect((await client.v1.auth.status.get()).data).toEqual({ api_key_required: false });
  });

  test('/v1/auth/check answers ok with no key', async () => {
    expect((await client.v1.auth.check.get()).data).toEqual({ ok: true });
  });

  // A key left in a browser from before the workflow groups ran open must not turn into a 401.
  test('a stale bearer is ignored', async () => {
    expect((await client.v1.auth.check.get({ $headers: STALE_BEARER })).data).toEqual({
      ok: true,
    });
    expect(await listed_ids(client, STALE_BEARER)).toEqual([workflow_id]);
    const scaling = await client.v1['workflow-groups'][workflow_id]!.workflows[
      workflow_id
    ]!.scaling.get({ $headers: STALE_BEARER });
    expect(refusal(scaling).status).not.toBe(401);
  });

  test('a workflow id that does not exist is 404 workflows.not_found', async () => {
    const res = await client.v1.workflows[UNKNOWN_WORKFLOW_ID]!.get();

    expect(refusal(res)).toMatchObject({ status: 404, error: 'workflows.not_found' });
  });
});
