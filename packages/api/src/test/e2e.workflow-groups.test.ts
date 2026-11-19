// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { WorkflowGroupStatus } from '@api/modules/workflow-groups/workflow-groups.types';
import { config } from '@core/env';

import { TEST_API_KEY, TEST_CONTROL_KEY } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { bearer } from './workflow-test.utils';

// /v1/workflow-groups against the real Docker daemon and the real core image, whose
// `canyonos_core.cli` commands the API runs in job containers and in the Global Controller.
const CORE_IMAGE = Bun.env.CANYONOS_CORE_IMAGE;
if (!CORE_IMAGE) {
  throw new Error(
    'Set CANYONOS_CORE_IMAGE to the core image to test /v1/workflow-groups against, e.g. one ' +
      'built with `docker build -f packages/core/Dockerfile -t canyonos-core:dev .`'
  );
}

setupE2ETests();

const control = bearer(TEST_CONTROL_KEY);
const HELLOWORLD = new URL('../../../../examples/helloworld/', import.meta.url).pathname;
const DOCKER_SOCKET = '/var/run/docker.sock';
const APPLY_TIMEOUT_MS = 60_000;
const DEPLOY_TIMEOUT_MS = 120_000;
// Past the 30 s Bun gives a silent request before it cuts the connection.
const SLOW_STOP_SECONDS = 35;

const run_id = Bun.randomUUIDv7().replaceAll('-', '').slice(-8);
const name = `e2e-${run_id}`;
const workflow_group_id = crypto.randomUUID();
const project = `canyonos-${name}`;

async function docker_cli(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit_code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit_code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

/** A port nothing listens on: CI's Redis service holds 6379. */
function free_port(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

/** The Global Controller container as `canyonos deploy` creates it, with its network and
 * /workspace volume, not started. */
async function create_controller(redis_port: number): Promise<string> {
  await docker_cli([
    'network',
    'create',
    '--label',
    `com.docker.compose.project=${project}`,
    project,
  ]);
  await docker_cli([
    'volume',
    'create',
    '--label',
    `com.docker.compose.project=${project}`,
    `${project}-workspace`,
  ]);
  return docker_cli([
    'create',
    '--init',
    '--name',
    `${project}-global-controller`,
    '--network',
    project,
    '--label',
    `com.docker.compose.project=${project}`,
    '--label',
    'canyonos.role=global-controller',
    '--label',
    `canyonos.workflow_group_id=${workflow_group_id}`,
    '-v',
    `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    '-v',
    `${project}-workspace:/workspace`,
    '-e',
    `CANYONOS_REDIS_HOST=${project}-redis-localhost`,
    '-e',
    `CANYONOS_REDIS_PORT=${redis_port}`,
    '-e',
    `DOCKER_HOST=unix://${DOCKER_SOCKET}`,
    '-e',
    `CANYONOS_CONTROLLER_IMAGE=${CORE_IMAGE}`,
    '-e',
    `CANYONOS_COLLECTOR_IMAGE=${CORE_IMAGE}`,
    '-e',
    `CANYONOS_DOCKER_PROJECT=${name}`,
    '-e',
    `CANYONOS_WORKFLOW_GROUP_ID=${workflow_group_id}`,
    '-e',
    `CANYONOS_REDIS_PASSWORD=${run_id}`,
    CORE_IMAGE!,
  ]);
}

/** A stand-in Global Controller of another workflow group, labelled as one, that runs `on_term`
 * when it gets SIGTERM. */
async function create_fake_controller(fake_group_id: string, on_term: string): Promise<string> {
  const id = await docker_cli([
    'create',
    '--init',
    '--label',
    `com.docker.compose.project=${project}`,
    '--label',
    'canyonos.role=global-controller',
    '--label',
    `canyonos.workflow_group_id=${fake_group_id}`,
    '--entrypoint',
    'sh',
    CORE_IMAGE!,
    '-c',
    `trap "${on_term}" TERM; sleep 300 & wait`,
  ]);
  await docker_cli(['start', id]);
  return id;
}

/** A gzip tar of `files`, by path, as the CLI uploads a workflow. */
const gzip_tar = (files: Record<string, string>) =>
  new Bun.Archive(files, { compress: 'gzip' }).bytes();

/** The helloworld example's workflow folder, by path relative to it. */
async function helloworld_files(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const path of new Bun.Glob('**/*').scan({ cwd: `${HELLOWORLD}helloworld` })) {
    files[path] = await Bun.file(`${HELLOWORLD}helloworld/${path}`).text();
  }
  return files;
}

const v1 = (
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}
) =>
  fetch(`${config.app.apiUrl}/v1/workflow-groups${path}`, {
    ...init,
    headers: { ...control, ...init.headers },
  });

const put_workflow = (workflow: string, archive: Uint8Array<ArrayBuffer>) =>
  v1(`/${workflow_group_id}/workflows/${workflow}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body: archive,
  });

const group = () => api.v1['workflow-groups'][workflow_group_id]!;

type Res = { error: unknown };

/** The status and body of an Eden error answer. */
const refusal = (res: Res) => {
  const error = res.error as { status: number; value: Record<string, unknown> } | null;
  return { status: error?.status, ...error?.value };
};

async function status(): Promise<WorkflowGroupStatus> {
  const res = await group().get({ $headers: control });
  if (res.error || !res.data) throw new Error(`GET status failed: ${JSON.stringify(refusal(res))}`);
  return res.data;
}

/** Polls the status until `done` holds for it, at most `timeout_ms`. */
async function status_when(done: (current: WorkflowGroupStatus) => boolean, timeout_ms: number) {
  const deadline = Date.now() + timeout_ms;
  for (;;) {
    const current = await status();
    if (done(current)) return current;
    if (Date.now() > deadline)
      throw new Error(`Status never got there: ${JSON.stringify(current)}`);
    await Bun.sleep(500);
  }
}

let redis_port = 0;
let config_text = '';

beforeAll(() => {
  redis_port = free_port();
  config_text =
    `workflow_group_id: ${workflow_group_id}\n` +
    'target: docker\nprovider: local\nlogs: false\n' +
    `redis:\n  port: ${redis_port}\n`;
});

afterAll(async () => {
  const leftovers = await docker_cli([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]).catch(() => '');
  const ids = leftovers.split('\n').filter(Boolean);
  if (ids.length > 0) await docker_cli(['rm', '-f', ...ids]).catch(() => undefined);
  await docker_cli(['rm', '-f', `${project}-redis-localhost`]).catch(() => undefined);
  await docker_cli(['network', 'rm', project]).catch(() => undefined);
  await docker_cli(['volume', 'rm', `${project}-workspace`]).catch(() => undefined);
}, 60_000);

describe('the workflow groups API drives the Global Controller container', () => {
  test('every route needs the control key, checked before the request is read', async () => {
    const responses = await Promise.all([
      api.v1['workflow-groups'].get(),
      group().get({ $headers: bearer(TEST_API_KEY) }),
      fetch(`${config.app.apiUrl}/v1/workflow-groups/not-a-uuid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    ]);
    const [missing, api_key, unread] = responses;
    expect(refusal(missing)).toMatchObject({
      status: 401,
      error: 'auth.missing_key',
    });
    expect(refusal(api_key)).toMatchObject({ error: 'auth.invalid_key' });
    expect(unread!.status).toBe(401);
    expect(await unread!.json()).toMatchObject({ error: 'auth.missing_key' });
  });

  test('a browser on another origin gets no CORS answer', async () => {
    const preflight = await fetch(`${config.app.apiUrl}/v1/workflow-groups/`, {
      method: 'OPTIONS',
      headers: { origin: 'http://elsewhere.example', 'access-control-request-method': 'GET' },
    });
    const keyed = await v1('/', { headers: { origin: 'http://elsewhere.example' } });

    expect(preflight.status).toBe(401);
    expect(keyed.status).toBe(200);
    for (const response of [preflight, keyed]) {
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('an unknown workflow group is 404, and a PUT without its container is 409', async () => {
    const missing = await group().get({ $headers: control });
    const put = await group().put({ name, config: config_text, env: null }, { headers: control });
    const malformed = await api.v1['workflow-groups']['not-a-uuid']!.get({ $headers: control });

    expect(refusal(missing)).toMatchObject({
      status: 404,
      error: 'workflow_groups.unknown_workflow_group',
    });
    expect(refusal(put)).toMatchObject({ error: 'workflow_groups.controller_missing' });
    expect(refusal(malformed)).toMatchObject({
      status: 422,
      error: 'validation_error',
    });
  });

  test(
    'a PUT writes the settings; with no workflow nothing starts',
    async () => {
      await create_controller(redis_port);

      const put = await group().put(
        { name, config: config_text, env: 'GREETING=hello\n', workflows: [], api_key_hash: '' },
        { headers: control }
      );
      expect(put.data).toEqual({ generation: 1, warnings: [] });

      const listed = await api.v1['workflow-groups'].get({ $headers: control });
      expect(listed.data?.workflow_groups).toContainEqual({ workflow_group_id, name });

      const applied = await status_when(
        ({ applied_generation }) => applied_generation >= 1,
        APPLY_TIMEOUT_MS
      );
      expect(applied).toMatchObject({
        version: null,
        name,
        config: config_text,
        running: false,
        phase: null,
        steps: [],
        generation: 1,
        applying: null,
        last_apply: { generation: 1, action: 'none', ok: true, error: null, code: null },
        errors: [],
      });
    },
    APPLY_TIMEOUT_MS + 30_000
  );

  test('the routes that need a running deploy are 409 before it starts', async () => {
    const [health, agent_logs, dashboard, log] = await Promise.all([
      group().health.get({ $headers: control }),
      group().logs.agents['helloworld.Workflow']!.get({
        $headers: control,
        $query: { tail: '10' },
      }),
      group().dashboard.put(undefined, { headers: control }),
      v1(`/${workflow_group_id}/logs/controller?tail=all`),
    ]);

    for (const res of [health, agent_logs, dashboard]) {
      expect(refusal(res)).toMatchObject({
        status: 409,
        error: 'workflow_groups.not_running',
      });
    }
    expect(log.status).toBe(200);
    expect(await log.text()).toBe('');
  });

  test(
    'an upload that is no archive, or fails the check, is 400 and changes nothing',
    async () => {
      const bad_archive = await put_workflow('helloworld', new Uint8Array([1, 2, 3, 4]));
      expect(bad_archive.status).toBe(400);
      expect(await bad_archive.json()).toMatchObject({ error: 'workflow_groups.bad_archive' });

      const invalid = await put_workflow(
        'helloworld',
        await gzip_tar({ 'config/workflow_config.yaml': 'agents: 5\n' })
      );
      const refusal = (await invalid.json()) as { error: string; findings: string[] };
      expect(invalid.status).toBe(400);
      expect(refusal.error).toBe('workflow_groups.workflow_invalid');
      expect(refusal.findings.length).toBeGreaterThan(0);
      expect(refusal.findings.join('\n')).toContain('helloworld/');

      const no_manifest = await put_workflow('helloworld', await gzip_tar({ 'README.md': 'hi' }));
      expect(no_manifest.status).toBe(400);
      expect(await no_manifest.json()).toMatchObject({
        error: 'workflow_groups.workflow_invalid',
      });

      expect((await group().workflows.get({ $headers: control })).data).toEqual({ workflows: [] });
      expect((await status()).generation).toBe(1);
    },
    APPLY_TIMEOUT_MS
  );

  test(
    'a valid upload is listed with its fingerprints and starts the deploy, whose progress and log show',
    async () => {
      const uploaded = await put_workflow('helloworld', await gzip_tar(await helloworld_files()));
      expect(uploaded.status).toBe(200);
      expect(await uploaded.json()).toEqual({ generation: 2, warnings: [] });

      const listed = await group().workflows.get({ $headers: control });
      expect(listed.data).toEqual({
        workflows: [
          {
            name: 'helloworld',
            fingerprints: {
              code: expect.stringMatching(/^[0-9a-f]{64}$/),
              config: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            test_query: 'CanyonOS',
          },
        ],
      });
      const workflow = await group().workflows.helloworld!.get({ $headers: control });
      expect(workflow.data).toEqual(listed.data!.workflows[0]!);
      const unknown = await group().workflows.nothing!.get({ $headers: control });
      expect(refusal(unknown)).toMatchObject({ error: 'workflow_groups.unknown_workflow' });

      const started = await status_when(
        ({ applied_generation }) => applied_generation >= 2,
        APPLY_TIMEOUT_MS
      );
      expect(started.last_apply).toMatchObject({ generation: 2, action: 'start', ok: true });

      const reporting = await status_when(({ version }) => version !== null, DEPLOY_TIMEOUT_MS);
      expect(reporting.phase).not.toBeNull();

      const log = await v1(`/${workflow_group_id}/logs/controller?tail=all`);
      expect(log.headers.get('content-type')).toStartWith('text/plain');
      expect((await log.text()).length).toBeGreaterThan(0);
    },
    APPLY_TIMEOUT_MS + DEPLOY_TIMEOUT_MS + 30_000
  );

  test('DELETE stops the deploy and forgets the upload', async () => {
    const unknown = await group().workflows.nothing!.delete(undefined, { headers: control });
    expect(refusal(unknown)).toMatchObject({ error: 'workflow_groups.unknown_workflow' });

    const deleted = await group().delete(undefined, { headers: control });
    expect(deleted.error).toBeNull();
    expect(deleted.data?.generation).toBeGreaterThanOrEqual(3);

    const after = await status();
    expect(after).toMatchObject({ name: '', config: null, running: false, generation: 0 });
    expect(['stopped', 'failed']).toContain(after.phase!);
  }, 300_000);

  test('a Global Controller with no upload here is stopped too, and a failed stop is 500', async () => {
    const failing_id = crypto.randomUUID();
    await create_fake_controller(failing_id, 'exit 3');

    const res = await api.v1['workflow-groups'][failing_id]!.delete(undefined, {
      headers: control,
    });

    expect(refusal(res)).toMatchObject({
      status: 500,
      error: 'workflow_groups.stop_failed',
      message: 'Global Controller stopped with exit code 3',
    });
  }, 60_000);

  test(
    'a stop that outlasts the idle timeout still answers',
    async () => {
      const slow_id = crypto.randomUUID();
      await create_fake_controller(slow_id, `sleep ${SLOW_STOP_SECONDS}; exit 0`);

      const res = await api.v1['workflow-groups'][slow_id]!.delete(undefined, {
        headers: control,
      });

      expect(res.error).toBeNull();
      expect(res.data).toEqual({ generation: 0 });
    },
    (SLOW_STOP_SECONDS + 30) * 1000
  );
});
