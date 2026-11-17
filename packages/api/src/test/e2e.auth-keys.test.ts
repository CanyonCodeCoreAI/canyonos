// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

import { forgeApi } from '@api/app';
import { requireScope } from '@api/modules/auth/auth.middleware';
import { load_prompts } from '@api/modules/prompts/prompts.service';
import type { ScalingPolicy } from '@api/modules/scaling/scaling.types';
import { config } from '@core/env';
import { errorPlugin } from '@core/errors';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { seed_active_agents, seed_running_project } from './redis-test.utils';
import { signTestToken } from './token-test.utils';

setupE2ETests();

interface Verdict {
  status: number;
  code?: string;
}

interface Vector {
  name: string;
  token: string;
  expect: { endpoint: Verdict; api: Verdict };
}

const VECTORS = (await Bun.file(
  new URL('../../../../tests/auth-vectors/vectors.json', import.meta.url)
).json()) as Vector[];

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
    greet: [{ version: 'greet-00000001-v1', content: 'Say hello.', updated_at: null, live: true }],
  },
};

const READ_ONLY = 'This token may read but not change anything';
const WRITE_ONLY = 'A write token reads only what it can change; send a read token for this';

// What you can change, you can also read: the GETs a write token reads too. Every other GET is
// read only.
const READ_OR_WRITE = new Set([
  '/auth/token',
  '/projects/:project_id',
  '/projects/:project_id/scaling',
  '/projects/:project_id/scaling/agents',
  '/projects/:project_id/governance',
  '/projects/:project_id/prompts',
  '/projects/:project_id/prompts/:name',
]);

type Res = { error: { status: unknown; value: unknown } | null };

const refusal = (res: Res) => ({
  status: res.error?.status as number | undefined,
  ...(res.error?.value as { error?: string; message?: string } | undefined),
});

async function running_project(name: string): Promise<string> {
  const { project_id } = await create_test_project({ name });
  await seed_running_project(project_id, PROMPTS);
  await seed_active_agents(JSON.stringify(['app.Greeter']));
  await load_prompts(project_id);
  return project_id;
}

const in_seconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

describe('the dashboard API verifies API tokens', () => {
  for (const vector of VECTORS) {
    test(`vector ${vector.name}: GET /projects is ${vector.expect.api.status}`, async () => {
      const res = await api.projects.get({ $headers: bearer(vector.token) });

      expect(res.error?.status as number).toBe(vector.expect.api.status);
      if (vector.expect.api.code) expect(refusal(res).error).toBe(vector.expect.api.code);
    });
  }

  test('no Authorization header, or a Basic one, is 401 auth.missing_token', async () => {
    const basic = { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

    for (const res of [await api.projects.get(), await api.projects.get({ $headers: basic })]) {
      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.missing_token' });
      expect(refusal(res).message).toBeString();
    }
  });

  test('the Bearer scheme is matched in any case and the token is trimmed', async () => {
    const token = await authenticate('read');

    const res = await api.projects.get({ $headers: { authorization: `bearer   ${token}  ` } });

    expect(res.error).toBeNull();
  });

  test('a read token gets 200 from every GET under a project', async () => {
    const project_id = await running_project('Read Everything');
    const read = { $headers: bearer(await authenticate('read')) };
    const project = api.projects[project_id]!;

    const responses = await Promise.all([
      project.get(read),
      project.stats.get(read),
      project.requests.get({ ...read, $query: { ...RANGE, limit: 20, offset: 0 } }),
      project.metrics.kpis.get({ ...read, $query: RANGE }),
      project.monitoring.series.get({ ...read, $query: RANGE }),
      project.monitoring.logs.get({
        ...read,
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      project.monitoring.traces.get({ ...read, $query: { ...RANGE, limit: 200 } }),
      project.monitoring.resources.get({ ...read, $query: RANGE }),
      project.monitoring.replicas.get(read),
      project.monitoring.endpoint.get(read),
      project.prompts.get(read),
      project.scaling.get(read),
      project.governance.get(read),
    ]);

    for (const res of responses) expect(res.error).toBeNull();
    expect((await api.resources.overview.get({ ...read, $query: RANGE })).error).toBeNull();
  });

  test('a read token is 403 on every write route, and nothing changes', async () => {
    const project_id = await running_project('Read Only');
    const headers = bearer(await authenticate('read'));
    const project = api.projects[project_id]!;
    const scaling_before = await project.scaling.get({ $headers: headers });

    const responses = await Promise.all([
      project.scaling.app!.put(POLICY, { headers }),
      project.scaling.app!.delete(undefined, { headers }),
      project.delete(undefined, { headers }),
      project['sample-data'].post({ workflow: 'helloworld' }, { headers }),
      project.prompts.greet!.versions.post({ content: 'Say goodbye.' }, { headers }),
      project.prompts.greet!.live.put({ version: 'greet-00000001-v1' }, { headers }),
      project.governance.agents.Greeter!.put({ requires: [], spend: null }, { headers }),
      project.governance.agents.Greeter!.stopped.put({ stopped: true }, { headers }),
    ]);

    for (const res of responses) {
      expect(refusal(res)).toMatchObject({
        status: 403,
        error: 'auth.insufficient_scope',
        message: READ_ONLY,
      });
    }
    const listed = await api.projects.get({ $headers: headers });
    expect(listed.data!.map(({ id }) => id)).toContain(project_id);
    expect((await project.scaling.get({ $headers: headers })).data).toEqual(scaling_before.data!);
  });

  test('a write token reads what it can change: detail, scaling, governance, prompts', async () => {
    const project_id = await running_project('Write Reads What It Changes');
    const headers = bearer(await authenticate('write'));
    const read = { $headers: headers };
    const project = api.projects[project_id]!;

    const responses = await Promise.all([
      project.get(read),
      project.scaling.get(read),
      project.scaling.agents.get(read),
      project.governance.get(read),
      project.prompts.get(read),
      project.prompts.greet!.get(read),
    ]);

    for (const res of responses) expect(res.error).toBeNull();
    const saved = await project.scaling.app!.put(POLICY, { headers });
    expect(saved.error).toBeNull();
    expect((await project.scaling.get(read)).data).toEqual({
      projects: { app: { status: 'applied', policy: POLICY } },
    });
    expect((await project.scaling.app!.delete(undefined, { headers })).error).toBeNull();
  });

  test('a write token is 403 on every read of something it cannot change', async () => {
    const project_id = await running_project('Write Cannot Read');
    const read = { $headers: bearer(await authenticate('write')) };
    const project = api.projects[project_id]!;

    const responses = await Promise.all([
      api.projects.get(read),
      project.stats.get(read),
      project.requests.get({ ...read, $query: { ...RANGE, limit: 20, offset: 0 } }),
      project.metrics.kpis.get({ ...read, $query: RANGE }),
      project.monitoring.series.get({ ...read, $query: RANGE }),
      project.monitoring.logs.get({
        ...read,
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      project.monitoring.traces.get({ ...read, $query: { ...RANGE, limit: 200 } }),
      project.monitoring.replicas.get(read),
      project.monitoring.endpoint.get(read),
      api.resources.overview.get({ ...read, $query: RANGE }),
    ]);

    for (const res of responses) {
      expect(refusal(res)).toMatchObject({
        status: 403,
        error: 'auth.insufficient_scope',
        message: WRITE_ONLY,
      });
    }
  });

  test('/auth/token answers the scope and expiry of a read or a write token', async () => {
    const exp = in_seconds(3600);
    const read = await signTestToken({ scope: 'read' });
    const write = await signTestToken({ scope: 'write', exp });

    expect((await api.auth.token.get({ $headers: bearer(read) })).data).toEqual({
      scope: 'read',
      expires_at: null,
    });
    expect((await api.auth.token.get({ $headers: bearer(write) })).data).toEqual({
      scope: 'write',
      expires_at: new Date(exp * 1000).toISOString(),
    });
  });

  test('/auth/token refuses no token, an expired one and a workflow scope', async () => {
    const expired = await signTestToken({ scope: 'read', exp: in_seconds(-120) });
    const query = await signTestToken({ scope: 'query' });

    expect(refusal(await api.auth.token.get())).toMatchObject({
      status: 401,
      error: 'auth.missing_token',
    });
    expect(refusal(await api.auth.token.get({ $headers: bearer(expired) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_token',
      message: 'This token expired',
    });
    expect(refusal(await api.auth.token.get({ $headers: bearer(query) }))).toMatchObject({
      status: 403,
      error: 'auth.insufficient_scope',
    });
  });

  test('/auth/status and /healthz answer with no token', async () => {
    expect((await api.auth.status.get()).data).toEqual({ disabled: false });
    expect((await api.healthz.get()).error).toBeNull();
  });

  test('password sign-in is gone: register, login and profile are 404', async () => {
    for (const [method, path] of [
      ['POST', '/auth/register'],
      ['POST', '/auth/login'],
      ['GET', '/auth/profile'],
    ] as const) {
      const response = await fetch(`${config.app.apiUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ email: 'a@b.c', password: 'password1' }) : null,
      });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain('token');
    }
  });

  test('a CORS preflight needs no token', async () => {
    const project_id = await running_project('Preflight');

    const response = await fetch(`${config.app.apiUrl}/projects/${project_id}/scaling/app`, {
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

  test('a token signed by a key that is not trusted is 401 auth.invalid_token', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const token = await signTestToken({ scope: 'read', key: privateKey });

    expect(refusal(await api.projects.get({ $headers: bearer(token) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_token',
      message: 'This token is not signed by a key this API trusts',
    });
  });

  test('a trusted key with another issuer, or none, is 401 auth.invalid_token', async () => {
    for (const iss of ['someone-else', null]) {
      const token = await signTestToken({ scope: 'read', iss });

      const res = await api.projects.get({ $headers: bearer(token) });

      expect(refusal(res)).toMatchObject({ status: 401, error: 'auth.invalid_token' });
    }
  });

  test('a workflow token is 401 and says what it is for', async () => {
    const token = await signTestToken({ scope: 'query', aud: ['*'] });

    expect(refusal(await api.projects.get({ $headers: bearer(token) }))).toMatchObject({
      status: 401,
      error: 'auth.invalid_token',
      message: 'This token is for a workflow, not for the dashboard API',
    });
  });

  // A read-only GET, since twenty concurrent saves of one policy conflict (409) by design.
  test('twenty concurrent requests alternating a read and a write token each get their own verdict', async () => {
    const project_id = await running_project('Concurrent');
    const read = bearer(await authenticate('read'));
    const write = bearer(await authenticate('write'));
    const replicas = api.projects[project_id]!.monitoring.replicas;

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => replicas.get({ $headers: i % 2 === 0 ? read : write }))
    );

    responses.forEach((res, i) => {
      if (i % 2 === 0) expect(res.error).toBeNull();
      else expect(refusal(res)).toMatchObject({ status: 403, error: 'auth.insufficient_scope' });
    });
  });

  test('a route that states a scope but never verified a token refuses, even with a bearer', async () => {
    const unverified = new Elysia()
      .use(errorPlugin)
      .resolve(() => ({ auth: undefined }))
      .get('/unverified', () => 'answered', { beforeHandle: requireScope('read') });
    const token = await authenticate('read');

    const response = await unverified.handle(
      new Request('http://localhost/unverified', { headers: bearer(token) })
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('auth.missing_token');
  });

  // `requireScope` tags its hook with the scopes it accepts, so the route table shows which routes
  // would answer a verified token of any scope.
  test('every route under /projects, /resources and /auth/token states the scope it needs', () => {
    const guarded = forgeApi.routes.filter(({ path }) =>
      ['/projects', '/resources', '/auth/token'].some((prefix) => path.startsWith(prefix))
    );
    expect(guarded.length).toBeGreaterThan(30);
    const get_paths = new Set(
      guarded.filter(({ method }) => method === 'GET').map(({ path }) => path)
    );
    expect([...READ_OR_WRITE].filter((path) => !get_paths.has(path))).toEqual([]);

    for (const { method, path, hooks } of guarded) {
      const handlers = [hooks.beforeHandle ?? []].flat() as { fn?: { scopes?: string[] } }[];
      const declared = handlers.flatMap((hook) => hook.fn?.scopes ?? []);
      const expected =
        method !== 'GET' ? ['write'] : READ_OR_WRITE.has(path) ? ['read', 'write'] : ['read'];
      expect({ route: `${method} ${path}`, scopes: declared }).toEqual({
        route: `${method} ${path}`,
        scopes: expected,
      });
    }
  });
});

const SERVER = new URL('../server.ts', import.meta.url).pathname;
const STARTUP_TIMEOUT_MS = 10_000;
const folders: string[] = [];

afterAll(async () => {
  for (const folder of folders) {
    await chmod(folder, 0o755).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
});

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canyonos-trusted-'));
  folders.push(dir);
  return dir;
}

let next_port = config.app.port + 100;

/** Starts `src/server.ts` on its own port with `env` over this run's environment; `undefined`
 * unsets a variable. */
function spawn_api(env: Record<string, string | undefined>) {
  const port = next_port++;
  const merged = {
    ...process.env,
    PORT: String(port),
    API_URL: `http://localhost:${port}`,
    ...env,
  };
  const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
    env: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { child, url: `http://localhost:${port}` };
}

/** The exit code and stderr of a server that must refuse to start. */
async function refused_start(env: Record<string, string | undefined>) {
  const { child } = spawn_api(env);
  const timeout = setTimeout(() => child.kill(), STARTUP_TIMEOUT_MS);
  const code = await child.exited;
  clearTimeout(timeout);
  return { code, signal: child.signalCode, stderr: await new Response(child.stderr).text() };
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

async function key_pair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return {
    pem: await exportSPKI(publicKey),
    private_pem: await exportPKCS8(privateKey),
    privateKey,
  };
}

describe('the API reads its trusted keys at startup', () => {
  test('a ConfigMap layout, with a .DS_Store and a README, starts and verifies', async () => {
    const dir = await folder();
    const key = await key_pair();
    const timestamped = join(dir, '..2026_11_15_00_00_00.1');
    await mkdir(timestamped);
    await writeFile(join(timestamped, 'e2e.pub'), key.pem);
    await symlink('..2026_11_15_00_00_00.1', join(dir, '..data'));
    await symlink('..data/e2e.pub', join(dir, 'e2e.pub'));
    await writeFile(join(dir, '.DS_Store'), 'not a key');
    await writeFile(join(dir, 'README.md'), '# Trusted keys\n');
    const { child, url } = spawn_api({ AUTH_TRUSTED_KEYS_DIR: dir });

    try {
      await until_healthy(url);
      const token = await signTestToken({ scope: 'read', key: key.privateKey });
      const response = await fetch(`${url}/projects`, { headers: bearer(token) });
      expect(response.status).toBe(200);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 40_000);

  test('an empty folder starts, says so, and refuses every token', async () => {
    const dir = await folder();
    const { child, url } = spawn_api({ AUTH_TRUSTED_KEYS_DIR: dir, LOG_LEVEL: 'info' });

    try {
      await until_healthy(url);
      const token = await authenticate('read');
      const response = await fetch(`${url}/projects`, { headers: bearer(token) });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('auth.invalid_token');
    } finally {
      child.kill();
      await child.exited;
    }
    const output = await new Response(child.stdout).text();
    expect(output).toContain(`AUTH_TRUSTED_KEYS_DIR ${dir} holds no public key`);
  }, 40_000);

  const unusable: [string, (dir: string) => Promise<string>][] = [
    [
      'a private key',
      async (dir) => {
        const path = join(dir, 'default.pub');
        await writeFile(path, (await key_pair()).private_pem);
        return path;
      },
    ],
    [
      'an OpenSSH public key',
      async (dir) => {
        const path = join(dir, 'laptop.pub');
        await writeFile(path, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA laptop\n');
        return path;
      },
    ],
  ];

  for (const [label, write] of unusable) {
    test(`a folder holding ${label} refuses to start, naming the file`, async () => {
      const dir = await folder();
      await writeFile(join(dir, 'good.pub'), (await key_pair()).pem);
      const path = await write(dir);

      const { code, stderr } = await refused_start({ AUTH_TRUSTED_KEYS_DIR: dir });

      expect(code).not.toBe(0);
      expect(stderr).toContain('AUTH_TRUSTED_KEYS_DIR');
      expect(stderr).toContain(path);
    }, 15_000);
  }

  test('a folder that does not exist refuses to start, naming it', async () => {
    const dir = join(await folder(), 'missing');

    const { code, stderr } = await refused_start({ AUTH_TRUSTED_KEYS_DIR: dir });

    expect(code).not.toBe(0);
    expect(stderr).toContain(`AUTH_TRUSTED_KEYS_DIR ${dir}`);
  }, 15_000);

  test.skipIf(process.getuid?.() === 0)(
    'a key the API cannot read refuses to start, naming it',
    async () => {
      const dir = await folder();
      const path = join(dir, 'locked.pub');
      await writeFile(path, (await key_pair()).pem);
      await chmod(path, 0o000);

      const { code, stderr } = await refused_start({ AUTH_TRUSTED_KEYS_DIR: dir });

      expect(code).not.toBe(0);
      expect(stderr).toContain('AUTH_TRUSTED_KEYS_DIR');
      expect(stderr).toContain(path);
    },
    15_000
  );

  test('neither AUTH_DISABLED nor AUTH_TRUSTED_KEYS_DIR set refuses to start', async () => {
    const { code, stderr } = await refused_start({
      AUTH_DISABLED: undefined,
      AUTH_TRUSTED_KEYS_DIR: undefined,
    });

    expect(code).not.toBe(0);
    expect(stderr).toContain('AUTH_TRUSTED_KEYS_DIR');
  }, 15_000);

  test('AUTH_DISABLED=maybe refuses to start, naming the two values', async () => {
    const { code, stderr } = await refused_start({ AUTH_DISABLED: 'maybe' });

    expect(code).not.toBe(0);
    expect(stderr).toContain('AUTH_DISABLED must be true or false, got maybe');
  }, 15_000);
});
