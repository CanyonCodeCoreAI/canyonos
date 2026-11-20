// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import { TEST_CONTROL_KEY } from './api-key-test.utils';
import { spawn_api } from './process-test.utils';
import { bearer } from './workflow-test.utils';
import type { SpawnedApi } from './process-test.utils';

// /v1/workflow-groups on the Kubernetes target, without a cluster: a second API process started
// with CANYONOS_TARGET=kubernetes, its own database, and CANYONOS_K8S_API pointing at a stand-in
// Kubernetes API this test serves, which signs in callers, says what each may do, and holds one
// CanyonProject. The target is chosen once per process, so this one cannot share the suite's.
// What needs a cluster (builds, the operator, the core sidecar) is the Kubernetes E2E's.

const ALICE = 'alice-token';
const BOB = 'bob-token';
const RESTORED_ID = crypto.randomUUID();
// A workflow of the restored workflow group that has its own id.
const WORKFLOW_ID = crypto.randomUUID();
const NAMESPACE = 'team-a';
const PROJECT = 'hello';
const API_KEY_HASH = 'a'.repeat(64);
const DEPLOYED = {
  code: 'c'.repeat(64),
  config: 'd'.repeat(64),
  auth: { apiKeyHash: API_KEY_HASH },
};
const LEFTOVER_BUILD = 'hello-20260101-000000-abcd';
const GC_POD = 'canyonos-gc-5f7d9';
const STOP_TIMEOUT_MS = 30_000;

// Who may do what to CanyonProjects, by user, namespace and verb.
const RIGHTS: Record<string, Record<string, string[]>> = {
  alice: { [NAMESPACE]: ['get', 'update'] },
  bob: { [NAMESPACE]: ['get'] },
};
const USERS: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' };

interface AccessReview {
  user: string;
  namespace: string | null;
  verb: string;
}

const reviews: AccessReview[] = [];
const deleted: string[] = [];
let builds = [LEFTOVER_BUILD];
let project_present = true;

const project = () => ({
  metadata: {
    name: PROJECT,
    namespace: NAMESPACE,
    labels: { 'canyonos.canyoncode.ai/project': PROJECT },
    annotations: { 'canyonos.canyoncode.ai/deployed': JSON.stringify(DEPLOYED) },
  },
  spec: {
    projectID: RESTORED_ID,
    displayName: PROJECT,
    auth: { apiKeyHash: API_KEY_HASH },
    endpoint: {
      routes: [
        // From before workflow ids: served at /<workflow>/<agent>/<method> only.
        { workflow: 'helloworld', agent: 'HelloAgent', method: 'hello', arguments: ['name'] },
        {
          workflow: 'portfolio-6f1e2d3c',
          workflowID: WORKFLOW_ID,
          agent: 'Workflow',
          method: 'main',
          arguments: ['query'],
        },
      ],
    },
  },
  status: {
    endpointURL: 'http://canyonos-endpoint.team-a.svc:8080',
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'ControllerReady', status: 'True', message: 'running' },
      { type: 'RedisReady', status: 'True', message: 'ready' },
      { type: 'EndpointReady', status: 'False', message: 'waiting for its pod' },
    ],
  },
});

const agent = {
  metadata: { name: 'hello-helloagent', namespace: NAMESPACE },
  spec: { agentName: 'HelloAgent', replicas: 2 },
  status: { readyReplicas: 1, conditions: [{ type: 'Ready', status: 'False', reason: 'Scaling' }] },
};

const items = (list: unknown[]) => Response.json({ items: list });

/** The stand-in Kubernetes API: the calls the API makes, and what a cluster would answer. */
async function kubernetes(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const body = request.method === 'POST' ? ((await request.json()) as any) : null;
  const canyonos = `/apis/canyonos.canyoncode.ai/v1alpha1`;
  const scoped = `${canyonos}/namespaces/${NAMESPACE}`;
  if (path === '/apis/authentication.k8s.io/v1/tokenreviews') {
    const username = USERS[body.spec.token];
    return Response.json({
      status: username
        ? {
            authenticated: true,
            user: { username, uid: username, groups: ['system:authenticated'] },
          }
        : { authenticated: false },
    });
  }
  if (path === '/apis/authorization.k8s.io/v1/subjectaccessreviews') {
    const { user, resourceAttributes } = body.spec;
    const namespace = resourceAttributes.namespace ?? null;
    reviews.push({ user, namespace, verb: resourceAttributes.verb });
    const allowed =
      resourceAttributes.resource === 'canyonprojects' &&
      namespace !== null &&
      (RIGHTS[user]?.[namespace] ?? []).includes(resourceAttributes.verb);
    return Response.json({ status: { allowed } });
  }
  if (path === `${canyonos}/canyonprojects`) return items(project_present ? [project()] : []);
  if (path === `${scoped}/canyonprojects`) return items(project_present ? [project()] : []);
  if (path === `${scoped}/canyonagents`) return items(project_present ? [agent] : []);
  if (path === `${scoped}/canyonbuilds`) {
    return items(builds.map((name) => ({ metadata: { name, namespace: NAMESPACE } })));
  }
  if (request.method === 'DELETE') {
    deleted.push(`${path}${url.search}`);
    if (path.startsWith(`${scoped}/canyonbuilds/`)) {
      builds = builds.filter((name) => !path.endsWith(`/${name}`));
    }
    if (path === `${scoped}/canyonprojects/${PROJECT}`) project_present = false;
    return Response.json({});
  }
  if (path === `/api/v1/namespaces/${NAMESPACE}/pods`) {
    const selector = url.searchParams.get('labelSelector') ?? '';
    return items(
      selector.includes('app.kubernetes.io/name=canyonos-gc') && project_present
        ? [{ metadata: { name: GC_POD, namespace: NAMESPACE } }]
        : []
    );
  }
  if (path === `/api/v1/namespaces/${NAMESPACE}/pods/${GC_POD}/log`) {
    const lines = ['controller started', 'polling every 2s', 'all agents up'];
    const tail = Number(url.searchParams.get('tailLines') ?? lines.length);
    const container = url.searchParams.get('container');
    return new Response(`${container}: ${lines.slice(-tail).join('\n')}\n`);
  }
  return Response.json({ kind: 'Status', message: `no ${path}` }, { status: 404 });
}

const stub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: kubernetes });
const workspace = mkdtempSync(join(tmpdir(), 'canyonos-k8s-workspace-'));
let kubernetes_api: SpawnedApi | null = null;

/** A database of its own, emptied, so the second API's restore touches none of the suite's rows. */
async function kubernetes_database(): Promise<string> {
  const url = new URL(Bun.env.DATABASE_URL!);
  const name = `${decodeURIComponent(url.pathname.slice(1))}_kubernetes`;
  const admin_url = new URL(url);
  admin_url.pathname = '/postgres';
  const admin = postgres(admin_url.toString(), { max: 1, onnotice: () => undefined });
  if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).length === 0) {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  }
  await admin.end();
  url.pathname = `/${name}`;
  const database = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await database`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await database`DROP SCHEMA IF EXISTS public CASCADE`;
  await database`CREATE SCHEMA public`;
  await database.end();
  return url.toString();
}

beforeAll(async () => {
  await Bun.write(join(workspace, '.canyonos', 'core-version'), '9.9.9');
  // Ready, not only listening: the /v1 routes answer 503 until its database is migrated.
  kubernetes_api = await spawn_api({
    APP_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL: await kubernetes_database(),
    CANYONOS_TARGET: 'kubernetes',
    CANYONOS_K8S_API: `http://127.0.0.1:${stub.port}`,
    CANYONOS_WORKSPACE_DIR: workspace,
  });
}, 35_000);

afterAll(async () => {
  await kubernetes_api?.stop();
  await stub.stop(true);
  rmSync(workspace, { recursive: true, force: true });
});

function v1(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  return fetch(`${kubernetes_api!.url}/v1/workflow-groups${path}`, {
    ...init,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

const settings = (config: string, extra: Record<string, unknown> = {}) => ({
  method: 'PUT',
  body: JSON.stringify({ name: 'hello', config, env: null, ...extra }),
});

const config_in = (namespace: string) =>
  `workflow_group_id: x\nkubernetes:\n  namespace: ${namespace}\n  registry: registry.example\n`;

describe('the Kubernetes target', () => {
  test("checks the caller's Kubernetes login instead of the control key, before the request is read", async () => {
    for (const token of [null, TEST_CONTROL_KEY, 'not-a-cluster-token']) {
      const refused = await v1('', token);
      expect(refused.status).toBe(401);
      expect(((await refused.json()) as { error: string }).error).toBe('auth.unauthenticated');
    }

    const listed = await v1('', BOB);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      workflow_groups: [{ workflow_group_id: RESTORED_ID, name: PROJECT }],
    });
  });

  test('finds the CanyonProjects running in the cluster again at start, as deploys that are up', async () => {
    const before = reviews.length;
    const status = await v1(`/${RESTORED_ID}`, BOB);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      version: '9.9.9',
      name: PROJECT,
      running: true,
      phase: 'up',
      machine_errors: null,
      last_apply: null,
      endpoint: {
        public_host: 'canyonos-endpoint.team-a.svc',
        api_port: 8080,
        routes: [
          {
            workflow: 'helloworld',
            workflow_id: null,
            agent: 'HelloAgent',
            method: 'hello',
            arguments: ['name'],
            url: 'http://canyonos-endpoint.team-a.svc:8080/helloworld/HelloAgent/hello',
          },
          {
            workflow: 'portfolio-6f1e2d3c',
            workflow_id: WORKFLOW_ID,
            agent: 'Workflow',
            method: 'main',
            arguments: ['query'],
            url: `http://canyonos-endpoint.team-a.svc:8080/${WORKFLOW_ID}`,
          },
        ],
      },
      // No uploaded workflow names it, so it has no id.
      agents: [
        {
          agent_id: null,
          name: 'HelloAgent',
          desired_replicas: 2,
          running_replicas: 1,
          launch_error: null,
        },
      ],
      errors: [],
    });
    // Asked of the cluster in the namespace the restored deploy runs in.
    expect(reviews.slice(before)).toEqual([{ user: 'bob', namespace: NAMESPACE, verb: 'get' }]);
    // A build an earlier API process left behind is gone; the upload went with that pod.
    expect(deleted).toContain(
      `/apis/canyonos.canyoncode.ai/v1alpha1/namespaces/${NAMESPACE}/canyonbuilds/${LEFTOVER_BUILD}`
    );
    expect(await (await v1(`/${RESTORED_ID}/workflows`, BOB)).json()).toEqual({ workflows: [] });

    const health = await v1(`/${RESTORED_ID}/health`, BOB);
    expect(await health.json()).toEqual({
      ok: false,
      checks: [
        { name: 'Global Controller', ok: true, detail: 'running', fix: null },
        { name: 'Redis', ok: true, detail: 'ready', fix: null },
        {
          name: 'Workflow agents',
          ok: false,
          detail: 'HelloAgent: 1 of 2 replicas ready',
          fix: 'run `canyonos logs <agent>` to see why, or `canyonos status` for its launch error',
        },
        {
          name: 'Endpoint',
          ok: false,
          detail: 'waiting for its pod',
          fix: `see \`kubectl -n ${NAMESPACE} describe canyonproject ${PROJECT}\``,
        },
      ],
    });

    const log = await v1(`/${RESTORED_ID}/logs/controller?tail=2`, BOB);
    expect(log.headers.get('content-type')).toStartWith('text/plain');
    expect(await log.text()).toBe('global-controller: polling every 2s\nall agents up\n');

    // No body: the operator's registry, not the caller, says which workflows the group has.
    const dashboard = await v1(`/${RESTORED_ID}/dashboard`, ALICE, { method: 'PUT' });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toEqual({ workflows: [] });
  });

  test('refuses a change in a namespace where the caller may only read', async () => {
    const refused = await v1(`/${RESTORED_ID}`, BOB, { method: 'DELETE' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: 'auth.forbidden',
      message: `bob may not update CanyonProjects in namespace ${NAMESPACE}.`,
    });
    expect(deleted.some((path) => path.includes('/canyonprojects/'))).toBe(false);
  });

  test('checks a PUT against the namespace its body names, before anything is written', async () => {
    const workflow_group_id = crypto.randomUUID();
    const before = reviews.length;
    const elsewhere = await v1(`/${workflow_group_id}`, ALICE, settings(config_in('kube-system')));
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({
      error: 'auth.forbidden',
      message: 'alice may not update CanyonProjects in namespace kube-system.',
    });
    // An id it holds nothing of needs the sign-in only; the body then names the namespace.
    expect(reviews.slice(before)).toEqual([
      { user: 'alice', namespace: 'kube-system', verb: 'update' },
    ]);

    const unnamed = await v1(`/${workflow_group_id}`, ALICE, settings('workflows: {}\n'));
    expect(unnamed.status).toBe(403);
    expect(((await unnamed.json()) as { message: string }).message).toBe(
      'alice may not update CanyonProjects in every namespace.'
    );
    expect(reviews.at(-1)).toEqual({ user: 'alice', namespace: null, verb: 'update' });

    expect((await v1(`/${workflow_group_id}`, ALICE)).status).toBe(404);
    expect(await Bun.file(join(workspace, workflow_group_id, 'workflow_group.yaml')).exists()).toBe(
      false
    );
  });

  test("writes the settings into the workflow group's folder of the workspace", async () => {
    const workflow_group_id = crypto.randomUUID();
    const config = config_in(NAMESPACE);
    const put = await v1(
      `/${workflow_group_id}`,
      ALICE,
      settings(config, { env: 'GREETING=hi\n', workflows: [] })
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ generation: 1, warnings: [] });
    const folder = join(workspace, workflow_group_id);
    expect(await Bun.file(join(folder, 'workflow_group.yaml')).text()).toBe(config);
    expect(await Bun.file(join(folder, '.env')).text()).toBe('GREETING=hi\n');

    const again = await v1(`/${workflow_group_id}`, ALICE, settings(config, { workflows: [] }));
    expect(await again.json()).toEqual({ generation: 2, warnings: [] });
    expect(await Bun.file(join(folder, '.env')).exists()).toBe(false);

    // Its uploaded config names its namespace now, which a read is checked against.
    const status = await v1(`/${workflow_group_id}`, BOB);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ config, running: false, phase: null });
  });

  test('refuses a sync of some workflows only while it holds none of them since it restarted', async () => {
    const partial = await v1(`/${RESTORED_ID}`, ALICE, settings(config_in(NAMESPACE)));
    expect(partial.status).toBe(409);
    expect(((await partial.json()) as { error: string }).error).toBe(
      'workflow_groups.reupload_needed'
    );
  });

  test('an id it holds nothing of is 404 after the sign-in alone', async () => {
    const before = reviews.length;
    const unknown = await v1(`/${crypto.randomUUID()}`, BOB);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe(
      'workflow_groups.unknown_workflow_group'
    );
    expect(reviews.length).toBe(before);
  });

  test(
    'DELETE deletes the CanyonProject and its builds, then what its deploys wrote',
    async () => {
      const stopped = await v1(`/${RESTORED_ID}`, ALICE, { method: 'DELETE' });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ generation: 1 });
      const selector = encodeURIComponent(
        `canyonos.canyoncode.ai/project=${PROJECT},app.kubernetes.io/managed-by=canyonos-cli`
      );
      expect(deleted).toContain(
        `/apis/canyonos.canyoncode.ai/v1alpha1/namespaces/${NAMESPACE}/canyonprojects/${PROJECT}`
      );
      expect(deleted).toContain(
        `/api/v1/namespaces/${NAMESPACE}/secrets?labelSelector=${selector}`
      );
      expect(deleted).toContain(
        `/api/v1/namespaces/${NAMESPACE}/configmaps?labelSelector=${selector}`
      );
    },
    STOP_TIMEOUT_MS
  );
});
