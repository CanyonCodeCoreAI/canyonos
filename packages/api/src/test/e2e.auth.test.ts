// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { forgeApi } from '@api/app';
import { requireApiKey } from '@api/modules/auth/auth.middleware';
import { load_prompts } from '@api/modules/prompts/prompts.service';
import type { ScalingPolicy } from '@api/modules/scaling/scaling.types';
import { config } from '@core/env';

import { hashApiKey } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { seed_active_agents, seed_running_workflow } from './redis-test.utils';
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
  await load_prompts(workflow_id);
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

  test('every route under /workflows, /resources and /auth/check checks the key', () => {
    const guarded = forgeApi.routes.filter(({ path }) =>
      ['/workflows', '/resources', '/auth/check'].some((prefix) => path.startsWith(prefix))
    );
    expect(guarded.length).toBeGreaterThan(30);

    for (const { method, path, hooks } of guarded) {
      const handlers = [hooks.beforeHandle ?? []].flat() as { fn?: unknown }[];
      expect({
        route: `${method} ${path}`,
        checked: handlers.some(({ fn }) => fn === requireApiKey),
      }).toEqual({ route: `${method} ${path}`, checked: true });
    }
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

async function until_healthy(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS * 3;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${url}/healthz`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return;
    await Bun.sleep(200);
  }
  throw new Error(`${url} never answered /healthz`);
}

async function with_api(env: Record<string, string>, check: (url: string) => Promise<void>) {
  const { child, url } = spawn_api(env);
  try {
    await until_healthy(url);
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
