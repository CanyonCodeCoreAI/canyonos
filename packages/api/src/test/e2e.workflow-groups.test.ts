// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflowGroups, workflows } from '@api/db/schema';
import { join_controller_networks } from '@api/modules/registry/registry.network';
import { registry_repo } from '@api/modules/registry/registry.repo';
import type {
  DashboardRegistration,
  WorkflowGroupStatus,
} from '@api/modules/workflow-groups/workflow-groups.types';
import * as docker_engine from '@core/docker';
import { config } from '@core/env';

import { TEST_API_KEY, TEST_CONTROL_KEY } from './api-key-test.utils';
import { api, setupE2ETests } from './e2e.setup';
import { core_image, create_fake_controller, docker, free_port } from './process-test.utils';
import {
  reset_controller,
  seed_endpoint,
  seed_reconciler_errors,
  seed_replica,
  seed_running_workflow,
  seed_scaling_agents,
} from './redis-test.utils';
import { bearer } from './workflow-test.utils';

// /v1/workflow-groups against the real Docker daemon and the real core image, whose
// `canyonos_core.cli` commands the API runs in job containers and in the Global Controller.
// Throws here, failing the run, when CANYONOS_CORE_IMAGE is unset.
const CORE_IMAGE = core_image();

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

/** The Global Controller container as `canyonos deploy` creates it, with its network and
 * /workspace volume, not started. */
async function create_controller(redis_port: number): Promise<string> {
  await docker(['network', 'create', '--label', `com.docker.compose.project=${project}`, project]);
  await docker([
    'volume',
    'create',
    '--label',
    `com.docker.compose.project=${project}`,
    `${project}-workspace`,
  ]);
  return docker([
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
    CORE_IMAGE,
  ]);
}

/** A stand-in Global Controller of another workflow group that runs `on_term` when it gets
 * SIGTERM. */
const create_stopping_controller = (fake_group_id: string, on_term: string) =>
  create_fake_controller({
    project,
    workflow_group_id: fake_group_id,
    script: `trap "${on_term}" TERM; sleep 300 & wait`,
  });

/** A Global Controller of another workflow group, created and not started. */
const create_stopped_controller = (fake_group_id: string) =>
  create_fake_controller({
    project,
    workflow_group_id: fake_group_id,
    script: 'sleep 300',
    start: false,
  });

// What `run-deploy` writes once the deploy is up.
const UP_PROGRESS =
  'import json, time; json.dump({"version": "e2e", "started_at": time.time(), "phase": "up", ' +
  '"message": None, "steps": [], "slowest_step": None, "last_output_at": None, "error": None, ' +
  '"error_code": None, "root_cause": None, "reload": {"seq": 0, "ok": None, "error": None}, ' +
  '"stopping": False, "finished": False, "exit_code": None}, ' +
  'open("/var/lib/canyonos/progress.json", "w"))';

/** A stand-in Global Controller of another workflow group whose deploy reports itself up. */
const create_up_controller = (fake_group_id: string) =>
  create_fake_controller({
    project,
    workflow_group_id: fake_group_id,
    script: `mkdir -p /var/lib/canyonos && python -c '${UP_PROGRESS}' && sleep 300`,
  });

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

const put_workflow = (workflow_id: string, archive: Uint8Array<ArrayBuffer>) =>
  v1(`/${workflow_group_id}/workflows/${workflow_id}`, {
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
// The workflow_id the uploaded workflow_group.yaml gives the workflow named helloworld.
const helloworld_id = crypto.randomUUID();

beforeAll(() => {
  redis_port = free_port();
  config_text =
    `workflow_group_id: ${workflow_group_id}\n` +
    'target: docker\nprovider: local\nlogs: false\n' +
    `redis:\n  port: ${redis_port}\n` +
    `workflows:\n  helloworld:\n    path: helloworld\n    workflow_id: ${helloworld_id}\n`;
});

afterAll(async () => {
  const leftovers = await docker([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]).catch(() => '');
  const ids = leftovers.split('\n').filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]).catch(() => undefined);
  await docker(['rm', '-f', `${project}-redis-localhost`]).catch(() => undefined);
  await docker(['network', 'rm', project]).catch(() => undefined);
  for (const network of [`${project}-joined`, `${project}-own`]) {
    await docker(['network', 'rm', network]).catch(() => undefined);
  }
  await docker(['volume', 'rm', `${project}-workspace`]).catch(() => undefined);
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
    const [health, agent_logs, log] = await Promise.all([
      group().health.get({ $headers: control }),
      group().logs.agents[Bun.randomUUIDv5('helloworld.Workflow', helloworld_id)]!.get({
        $headers: control,
        $query: { tail: '10' },
      }),
      v1(`/${workflow_group_id}/logs/controller?tail=all`),
    ]);

    for (const res of [health, agent_logs]) {
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
      const unlisted = await put_workflow(crypto.randomUUID(), new Uint8Array([1, 2, 3, 4]));
      expect(unlisted.status).toBe(404);
      expect(await unlisted.json()).toMatchObject({ error: 'workflow_groups.unknown_workflow' });

      const bad_archive = await put_workflow(helloworld_id, new Uint8Array([1, 2, 3, 4]));
      expect(bad_archive.status).toBe(400);
      expect(await bad_archive.json()).toMatchObject({ error: 'workflow_groups.bad_archive' });

      const invalid = await put_workflow(
        helloworld_id,
        await gzip_tar({ 'config/workflow_config.yaml': 'agents: 5\n' })
      );
      const refusal = (await invalid.json()) as { error: string; findings: string[] };
      expect(invalid.status).toBe(400);
      expect(refusal.error).toBe('workflow_groups.workflow_invalid');
      expect(refusal.findings.length).toBeGreaterThan(0);
      expect(refusal.findings.join('\n')).toContain('helloworld/');

      const no_manifest = await put_workflow(helloworld_id, await gzip_tar({ 'README.md': 'hi' }));
      expect(no_manifest.status).toBe(400);
      expect(await no_manifest.json()).toMatchObject({
        error: 'workflow_groups.workflow_invalid',
      });

      expect((await group().workflows.get({ $headers: control })).data).toEqual({ workflows: [] });
      const no_graph = await v1(`/${workflow_group_id}/workflows/${helloworld_id}/graph`);
      expect(no_graph.status).toBe(404);
      expect(await no_graph.json()).toMatchObject({ error: 'workflow_groups.unknown_workflow' });
      expect((await status()).generation).toBe(1);
    },
    APPLY_TIMEOUT_MS
  );

  test(
    'a valid upload is listed with its fingerprints and starts the deploy, whose progress and log show',
    async () => {
      const uploaded = await put_workflow(helloworld_id, await gzip_tar(await helloworld_files()));
      expect(uploaded.status).toBe(200);
      expect(await uploaded.json()).toEqual({ generation: 2, warnings: [] });

      const listed = await group().workflows.get({ $headers: control });
      expect(listed.data).toEqual({
        workflows: [
          {
            workflow_id: helloworld_id,
            name: 'helloworld',
            fingerprints: {
              code: expect.stringMatching(/^[0-9a-f]{64}$/),
              config: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            test_query: 'CanyonOS',
          },
        ],
      });

      const graph = await v1(`/${workflow_group_id}/workflows/${helloworld_id}/graph`);
      expect(graph.status).toBe(200);
      expect(await graph.json()).toMatchObject({
        version: 1,
        workflow: 'helloworld',
        routes: [{ agent: 'Workflow', method: 'main' }],
        edges: [{ source: 'Workflow', target: 'HelloAgent', methods: ['hello'] }],
        calls: [{ source: 'Workflow', target: 'HelloAgent', method: 'hello', declared: true }],
        notes: [],
      });

      // An upload from before the API read graphs, or one whose code couldn't be read, has none.
      await db
        .update(workflowGroups)
        .set({
          workflows: sql`jsonb_set(${workflowGroups.workflows}, ARRAY[${helloworld_id}::text, 'graph'], 'null'::jsonb)`,
        })
        .where(eq(workflowGroups.id, workflow_group_id));
      const unread = await v1(`/${workflow_group_id}/workflows/${helloworld_id}/graph`);
      expect(unread.status).toBe(404);
      expect(await unread.json()).toMatchObject({ error: 'workflow_groups.graph_unavailable' });

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
    const unknown = await group().workflows[crypto.randomUUID()]!.delete(undefined, {
      headers: control,
    });
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
    await create_stopping_controller(failing_id, 'exit 3');

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
      await create_stopping_controller(slow_id, `sleep ${SLOW_STOP_SECONDS}; exit 0`);

      const res = await api.v1['workflow-groups'][slow_id]!.delete(undefined, {
        headers: control,
      });

      expect(res.error).toBeNull();
      expect(res.data).toEqual({ generation: 0 });
    },
    (SLOW_STOP_SECONDS + 30) * 1000
  );
});

describe('canyonos deploy registers the workflow group with the dashboard, and the status reads its Redis', () => {
  beforeEach(reset_controller);

  const CLOSED_PORT = 1;
  const TLS = { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' };

  const registration = (
    names: Record<string, string>,
    redis: Partial<DashboardRegistration> = {}
  ): DashboardRegistration => ({
    workflows: names,
    redis_host: `canyonos-${name}-redis-localhost`,
    redis_port: config.canyonos.redisPort,
    redis_password: '',
    redis_tls: null,
    ...redis,
  });

  const register = (group_id: string, body: DashboardRegistration) =>
    api.v1['workflow-groups'][group_id]!.dashboard.put(body, { headers: control });

  async function read_workflow(workflow_id: string) {
    const [row] = await db.select().from(workflows).where(eq(workflows.id, workflow_id)).limit(1);
    return row;
  }

  async function group_status(group_id: string): Promise<WorkflowGroupStatus> {
    const res = await api.v1['workflow-groups'][group_id]!.get({ $headers: control });
    if (res.error || !res.data)
      throw new Error(`GET status failed: ${JSON.stringify(refusal(res))}`);
    return res.data;
  }

  /** Polls the group's status, which is read at most every two seconds, until `done` holds. */
  async function group_status_when(
    group_id: string,
    done: (current: WorkflowGroupStatus) => boolean
  ): Promise<WorkflowGroupStatus> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = await group_status(group_id);
      if (done(current)) return current;
      if (Date.now() > deadline) {
        throw new Error(`Status never got there: ${JSON.stringify(current)}`);
      }
      await Bun.sleep(250);
    }
  }

  test('no body, or one naming another host, a port out of range or a workflow by no uuid is 422; a workflow group with no container 404', async () => {
    const group_id = crypto.randomUUID();
    await create_stopped_controller(group_id);
    const workflow_id = crypto.randomUUID();

    const refused = await Promise.all([
      ...['10.0.0.5', 'example.com', 'canyonos-a-redis-localhost.evil.com'].map((redis_host) =>
        register(group_id, registration({ [workflow_id]: 'app' }, { redis_host }))
      ),
      ...[0, 65536, 6379.5].map((redis_port) =>
        register(group_id, registration({ [workflow_id]: 'app' }, { redis_port }))
      ),
      register(group_id, registration({ 'not-a-uuid': 'app' })),
    ]);
    for (const res of refused) {
      expect(refusal(res)).toMatchObject({ status: 422, error: 'validation_error' });
    }
    // Optional for Kubernetes only: on Docker the body is the only source of the workflows.
    const bodiless = await fetch(`${config.app.apiUrl}/v1/workflow-groups/${group_id}/dashboard`, {
      method: 'PUT',
      headers: control,
    });
    expect(bodiless.status).toBe(422);
    expect(await bodiless.json()).toMatchObject({ error: 'workflow_groups.registration_required' });
    const unknown = await register(crypto.randomUUID(), registration({ [workflow_id]: 'app' }));
    expect(refusal(unknown)).toMatchObject({
      status: 404,
      error: 'workflow_groups.unknown_workflow_group',
    });
    expect(await read_workflow(workflow_id)).toBeUndefined();
  }, 60_000);

  test('it stores each workflow with the Redis before the Global Controller starts, without reaching it', async () => {
    const group_id = crypto.randomUUID();
    await create_stopped_controller(group_id);
    const alpha = crypto.randomUUID();
    const beta = crypto.randomUUID();

    // Nothing answers on CLOSED_PORT: the registration does not connect to the Redis.
    const res = await register(
      group_id,
      registration(
        { [beta]: 'beta', [alpha]: 'alpha' },
        { redis_port: CLOSED_PORT, redis_password: 's3cret', redis_tls: TLS }
      )
    );

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      workflows: [
        { workflow_id: alpha, name: 'alpha' },
        { workflow_id: beta, name: 'beta' },
      ],
    });
    for (const workflow_id of [alpha, beta]) {
      const row = await read_workflow(workflow_id);
      expect(row).toMatchObject({
        workflow_group_id: group_id,
        redis_host: `canyonos-${name}-redis-localhost`,
        redis_port: CLOSED_PORT,
      });
      // Sealed in the database, opened for the api.
      expect(row?.redis_password).not.toContain('s3cret');
      expect(row?.redis_tls).not.toContain('cert-pem');
      expect(await registry_repo.find_redis(workflow_id)).toMatchObject({
        redis_password: 's3cret',
        redis_tls: TLS,
      });
    }

    // Again, as `canyonos serve` does: the new Redis is taken, the stored name stays.
    const again = await register(group_id, registration({ [alpha]: 'renamed' }));
    expect(again.data).toEqual({ workflows: [{ workflow_id: alpha, name: 'alpha' }] });
    expect(await registry_repo.find_redis(alpha)).toMatchObject({
      redis_port: config.canyonos.redisPort,
      redis_password: '',
      redis_tls: null,
    });
  }, 60_000);

  test('the status reads the endpoint, agents and machine errors from the registered Redis once the controller publishes there', async () => {
    const group_id = crypto.randomUUID();
    await create_up_controller(group_id);
    const workflow_id = crypto.randomUUID();

    const unregistered = await group_status_when(group_id, ({ phase }) => phase === 'up');
    expect(unregistered).toMatchObject({
      running: true,
      endpoint: null,
      agents: null,
      machine_errors: null,
      errors: ['Not registered with the dashboard; run canyonos deploy again'],
    });

    expect((await register(group_id, registration({ [workflow_id]: 'app' }))).error).toBeNull();
    const unpublished = await group_status_when(group_id, ({ errors }) =>
      errors.every((error) => !error.startsWith('Not registered'))
    );
    expect(unpublished).toMatchObject({
      endpoint: null,
      agents: null,
      machine_errors: null,
      errors: ['The Global Controller has not published to its Redis yet'],
    });

    // Its identity names the registered workflow; no agent spec is published yet.
    await seed_running_workflow(workflow_id, { prompts: {} });
    const published = await group_status_when(group_id, ({ errors }) => errors.length === 0);
    expect(published).toMatchObject({ endpoint: null, agents: [], machine_errors: {} });

    const route = {
      workflow: 'app',
      workflow_id,
      agent: 'Alpha',
      method: 'main',
      arguments: ['query'],
      url: `http://203.0.113.7:8080/${workflow_id}`,
    };
    await seed_endpoint({
      public_host: '203.0.113.7',
      api_port: '8080',
      routes: JSON.stringify([route]),
    });
    await seed_scaling_agents([{ name: 'app.Alpha', desired: 2 }, { name: 'app.Beta' }]);
    await seed_replica('app.Alpha', 'app.Alpha-1a2b3c4d', '10.0.0.1:9000');
    // Still starting: its launch has not written its address.
    await seed_replica('app.Alpha', 'app.Alpha-5e6f7a8b', null);
    await seed_reconciler_errors({ 'app.Beta': 'no such image' }, { 't3.small': 'quota' });

    const running = await group_status_when(group_id, ({ endpoint }) => endpoint !== null);
    expect(running).toMatchObject({
      endpoint: { public_host: '203.0.113.7', api_port: 8080, routes: [route] },
      agents: [
        {
          agent_id: Bun.randomUUIDv5('app.Alpha', workflow_id),
          name: 'app.Alpha',
          desired_replicas: 2,
          running_replicas: 1,
          launch_error: null,
        },
        {
          agent_id: Bun.randomUUIDv5('app.Beta', workflow_id),
          name: 'app.Beta',
          desired_replicas: 0,
          running_replicas: 0,
          launch_error: 'no such image',
        },
      ],
      machine_errors: { 't3.small': 'quota' },
      errors: [],
    });
  }, 60_000);

  test('a registered Redis that does not answer is named under errors', async () => {
    const group_id = crypto.randomUUID();
    await create_up_controller(group_id);
    expect(
      (
        await register(
          group_id,
          registration({ [crypto.randomUUID()]: 'app' }, { redis_port: CLOSED_PORT })
        )
      ).error
    ).toBeNull();

    const unread = await group_status_when(group_id, ({ phase }) => phase === 'up');

    expect(unread).toMatchObject({ endpoint: null, agents: null, machine_errors: null });
    expect(unread.errors).toEqual([
      expect.stringMatching(/^Could not read the deploy's state in Redis: /),
    ]);
  }, 60_000);
});

describe("the API's container joins the network of a workflow group's Global Controller container", () => {
  // In the dashboard's compose file the API runs in a container that reads each group's Redis
  // by name; here the API runs on the host, so a container stands in for it.
  test('it joins the networks it is not on, keeps its own gateway, resolves the names there, and joining again changes nothing', async () => {
    const group_id = crypto.randomUUID();
    const network = `${project}-joined`;
    // The stand-in's own network sorts after the one it joins, which would take its default
    // gateway, and with it its published ports, at the same gateway priority.
    const own_network = `${project}-own`;
    for (const created of [network, own_network]) {
      await docker([
        'network',
        'create',
        '--label',
        `com.docker.compose.project=${project}`,
        created,
      ]);
    }
    const controller_name = `${project}-joined-controller`;
    const labelled_sleeper = (container_name: string, labels: string[], args: string[] = []) =>
      docker([
        'run',
        '-d',
        '--init',
        '--name',
        container_name,
        '--label',
        `com.docker.compose.project=${project}`,
        ...labels.flatMap((label) => ['--label', label]),
        ...args,
        '--entrypoint',
        'sh',
        CORE_IMAGE,
        '-c',
        'sleep 300',
      ]);
    await labelled_sleeper(
      controller_name,
      ['canyonos.role=global-controller', `canyonos.workflow_group_id=${group_id}`],
      ['--network', network]
    );
    const api_name = `${project}-joined-api`;
    await labelled_sleeper(api_name, [], ['--network', own_network]);
    const in_api = (code: string) => docker(['exec', api_name, 'python', '-c', code]);
    const gateway_interface = () =>
      in_api(
        "print(*[l.split()[0] for l in open('/proc/net/route') if l.split()[1] == '00000000'])"
      );
    const gateway_before = await gateway_interface();
    const resolves_controller = () =>
      in_api(`import socket; socket.gethostbyname("${controller_name}")`).then(
        () => true,
        () => false
      );
    expect(await resolves_controller()).toBe(false);

    expect(await join_controller_networks(api_name, group_id)).toEqual([network]);

    expect((await docker_engine.inspect(api_name)).networks).toContain(network);
    expect(await resolves_controller()).toBe(true);
    expect(await gateway_interface()).toBe(gateway_before);
    // Already on it: nothing to join, and a connect Docker refuses as a duplicate succeeds.
    expect(await join_controller_networks(api_name, group_id)).toEqual([]);
    await docker_engine.connect_network(network, api_name);
    expect(
      (await docker_engine.inspect(api_name)).networks.filter((on) => on === network)
    ).toHaveLength(1);
    // A workflow group with no Global Controller container has no network to join.
    expect(await join_controller_networks(api_name, crypto.randomUUID())).toBeNull();
  }, 60_000);
});

describe("put-workflow reads each upload's agent graph from its code", () => {
  const EXAMPLES = new URL('../../../../examples/', import.meta.url).pathname;

  type Graph = {
    agents: { name: string; endpoint: boolean; read: boolean }[];
    edges: { source: string; target: string; methods: string[] }[];
    calls: {
      id: string;
      source: string;
      target: string;
      method: string;
      declared: boolean;
      path: string;
      waits_on: string[];
      after: string[];
    }[];
    notes: { agent: string; path: string }[];
    routes: { agent: string; method: string | null }[];
  };

  /** What `put-workflow` answers for `files` uploaded as workflow `workflow`, run as the API
   * runs it: in a job container of the core image, with no network, in its /workspace.
   * `python` runs `canyonos_core.cli` with the arguments after it. */
  async function put_workflow_job(
    workflow: string,
    files: Record<string, string>,
    python = 'python -m canyonos_core.cli'
  ): Promise<{ answer: { graph: Graph | null }; stderr: string }> {
    const child = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        CORE_IMAGE,
        '-c',
        'mkdir -p /tmp/workspace && cd /tmp/workspace && cat > /tmp/upload.tar.gz && ' +
          `${python} put-workflow ${workflow} --archive /tmp/upload.tar.gz`,
      ],
      { stdin: await gzip_tar(files), stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exit_code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit_code !== 0) throw new Error(`put-workflow exited ${exit_code}: ${stdout}${stderr}`);
    return { answer: JSON.parse(stdout) as { graph: Graph | null }, stderr };
  }

  async function graph_of(workflow: string, files: Record<string, string>): Promise<Graph> {
    const { answer, stderr } = await put_workflow_job(workflow, files);
    if (!answer.graph) throw new Error(`put-workflow read no graph: ${stderr}`);
    return answer.graph;
  }

  async function example(folder: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for await (const path of new Bun.Glob('**/*').scan({ cwd: `${EXAMPLES}${folder}` })) {
      if (path.includes('__pycache__')) continue;
      files[path] = await Bun.file(`${EXAMPLES}${folder}/${path}`).text();
    }
    return files;
  }

  const edges = (graph: Graph) =>
    new Set(graph.edges.map((e) => `${e.source} -> ${e.target}.${e.methods.join('/')}`));
  const by_target = (graph: Graph) => Object.fromEntries(graph.calls.map((c) => [c.target, c]));

  test('pr_review calls each agent from its endpoint, each taking the one before', async () => {
    const graph = await graph_of('pr_review', await example('pr_review/pr_review'));

    expect(graph.routes).toEqual([{ agent: 'Workflow', method: 'review' }]);
    expect(graph.agents.filter((a) => a.endpoint).map((a) => a.name)).toEqual(['Workflow']);
    expect(edges(graph)).toEqual(
      new Set([
        'Workflow -> TestRunnerAgent.run',
        'Workflow -> ReviewAgent.review',
        'Workflow -> MergeAgent.merge',
      ])
    );
    const calls = Object.fromEntries(graph.calls.map((c) => [c.method, c]));
    expect(calls.run!.waits_on).toEqual([]);
    expect(calls.review!.waits_on).toEqual([calls.run!.id]);
    expect(calls.merge!.waits_on).toEqual([calls.review!.id]);
    expect(graph.calls.every((c) => c.declared)).toBe(true);
    expect(graph.notes).toEqual([]);
  }, 60_000);

  test('portfolio has a call between two agents below the endpoint, and stages that take what the ones before built', async () => {
    const graph = await graph_of('portfolio', await example('portfolio/portfolio'));

    expect(edges(graph)).toContain('MetricsAgent -> PriceAgent.get_history');
    const from_workflow = Object.fromEntries(
      graph.calls.filter((c) => c.source === 'Workflow').map((c) => [c.method, c])
    );
    const [parse, compute, assess] = ['parse', 'compute', 'assess'].map(
      (method) => from_workflow[method]!.id
    );
    expect(from_workflow.parse!.waits_on).toEqual([]);
    expect(from_workflow.compute!.waits_on).toEqual([parse!]);
    expect(from_workflow.assess!.waits_on).toEqual([parse!, compute!].sort());
    expect(from_workflow.summarize!.waits_on).toEqual([parse!, compute!, assess!].sort());
  }, 60_000);

  test('it reads every way an agent reaches another, and says what it cannot read', async () => {
    const graph = await graph_of('reach', {
      'config/workflow_config.yaml': [
        'agents:',
        '  - name: Alpha',
        '    entrypoint: agents/alpha.py',
        '    functions: [{name: go, returns: {type: str}}]',
        '  - name: Beta',
        '    entrypoint: agents/beta.py',
        '    functions:',
        '      - {name: run, arguments: [{name: x, type: str}], returns: {type: str}}',
        '  - name: Gamma',
        '    entrypoint: agents/gamma.py',
        '    functions:',
        '      - {name: run, arguments: [{name: query, type: str}], returns: {type: str}}',
        '  - name: Delta',
        '    entrypoint: agents/delta.py',
        '    functions: [{name: run, returns: {type: str}}]',
        '  - name: Store',
        '    type: database',
        '    image: redis:8',
        '  - name: Workflow',
        '    entrypoint: agents/workflow.py',
        '    functions:',
        '      - {name: main, arguments: [{name: query, type: str}], returns: {type: str}}',
        'endpoint:',
        '  routes:',
        '    - {agent: Workflow, method: main}',
        '',
      ].join('\n'),
      'agents/alpha.py': 'class Alpha(object):\n    def go(self):\n        return "done"\n',
      'agents/beta.py': 'class Beta(object):\n    def run(self, x):\n        return x\n',
      'agents/gamma.py': 'class Gamma(object):\n    def run(self, query):\n        return query\n',
      // Loading a module by name: what it reaches only running the code can tell.
      'agents/delta.py':
        'import importlib\n\n\nclass Delta(object):\n    def run(self):\n' +
        '        return str(importlib.import_module("agents.alpha"))\n',
      // A helper module that calls an agent is read through.
      'agents/helpers.py':
        'from agents.gamma import Gamma\n\n\ndef ask(query):\n' +
        '    return Gamma().run(query=query)\n',
      // A module alias, an agent's object kept on `self`, and the helper.
      'agents/workflow.py': [
        'import agents.alpha as alpha_module',
        'from agents.beta import Beta',
        'from agents.helpers import ask',
        '',
        '',
        'class Workflow(object):',
        '    def __init__(self):',
        '        self.beta = Beta()',
        '',
        '    def main(self, query: str):',
        '        first = alpha_module.Alpha().go()',
        '        second = self.beta.run(x=first)',
        '        return ask(second)',
        '',
      ].join('\n'),
    });

    expect(edges(graph)).toEqual(
      new Set(['Workflow -> Alpha.go', 'Workflow -> Beta.run', 'Workflow -> Gamma.run'])
    );
    const calls = by_target(graph);
    expect(calls.Beta!.waits_on).toEqual([calls.Alpha!.id]);
    expect(calls.Gamma!.path).toBe('agents/helpers.py');
    expect(graph.agents.find((a) => a.name === 'Store')).toMatchObject({ read: false });
    expect(graph.notes.map((n) => [n.agent, n.path])).toEqual([['Delta', 'agents/delta.py']]);
  }, 60_000);

  test('a call starts after the results its caller used before it, though it takes none of them', async () => {
    const agent = (name: string, returns: string) =>
      `class ${name}(object):\n    def run(self, q):\n        return ${returns}\n`;
    const graph = await graph_of('chain', {
      'config/workflow_config.yaml': [
        'agents:',
        ...[
          ['Decide', 'dict'],
          ['Write', 'str'],
          ['Publish', 'dict'],
        ].flatMap(([name, returns]) => [
          `  - name: ${name}`,
          `    entrypoint: agents/${name!.toLowerCase()}.py`,
          '    functions:',
          `      - {name: run, arguments: [{name: q, type: str}], returns: {type: ${returns}}}`,
        ]),
        '  - name: Workflow',
        '    entrypoint: agents/workflow.py',
        '    functions:',
        '      - {name: main, arguments: [{name: query, type: str}], returns: {type: dict}}',
        'endpoint:',
        '  routes:',
        '    - {agent: Workflow, method: main}',
        '',
      ].join('\n'),
      'agents/decide.py': agent('Decide', '{"skip": False, "text": q}'),
      'agents/write.py': agent('Write', 'q'),
      'agents/publish.py': agent('Publish', '{"published": q}'),
      // CanyonOS waits at `decision["skip"]`, so Publish starts after Decide; `print`, a
      // library call, waits on Write's result as `.value()` would.
      'agents/workflow.py': [
        'from agents.decide import Decide',
        'from agents.write import Write',
        'from agents.publish import Publish',
        '',
        '',
        'class Workflow(object):',
        '    def main(self, query: str):',
        '        decision = Decide().run(q=query)',
        '        if decision["skip"]:',
        '            return {}',
        '        draft = Write().run(q=decision["text"])',
        '        print(draft)',
        '        return Publish().run(q=query)',
        '',
      ].join('\n'),
    });

    const calls = by_target(graph);
    expect(calls.Decide).toMatchObject({ waits_on: [], after: [] });
    expect(calls.Write!.waits_on).toEqual([calls.Decide!.id]);
    expect(calls.Publish!.waits_on).toEqual([]);
    expect(calls.Publish!.after).toEqual([calls.Decide!.id, calls.Write!.id].sort());
  }, 60_000);

  test('an upload whose graph cannot be read is kept, without a graph', async () => {
    // Reading the graph fails however the code is written, so the upload alone decides.
    const failing_read = [
      "python -c 'import runpy, sys, canyonos_core.graph as graph",
      'def unreadable(*args): raise RuntimeError("unreadable")',
      'graph.build_graph = unreadable',
      'sys.argv[0] = "canyonos_core.cli"',
      'runpy.run_module("canyonos_core.cli", run_name="__main__")\'',
    ].join('\n');

    const { answer, stderr } = await put_workflow_job(
      'helloworld',
      await helloworld_files(),
      failing_read
    );

    expect(answer).toMatchObject({ graph: null, test_query: 'CanyonOS' });
    expect(stderr).toContain("Could not read helloworld's agent graph");
  }, 60_000);
});
