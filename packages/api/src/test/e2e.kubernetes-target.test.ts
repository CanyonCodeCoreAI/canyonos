// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

import { hashApiKey, TEST_API_KEY } from './api-key-test.utils';
import { spawn_api } from './process-test.utils';
import { raw_request } from './test.utils';
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
// The workflow group's own key, which its CanyonProject holds and the API restores.
const API_KEY_HASH = hashApiKey(TEST_API_KEY);
const DEPLOYED = {
  code: 'c'.repeat(64),
  config: 'd'.repeat(64),
  auth: { apiKeyHash: API_KEY_HASH },
};
const LEFTOVER_BUILD = 'hello-20260101-000000-abcd';
const GC_POD = 'canyonos-gc-5f7d9';
const STOP_TIMEOUT_MS = 30_000;
// Another workflow group, in its own namespace, with its own key.
const OTHER_ID = crypto.randomUUID();
const OTHER_NAMESPACE = 'team-c';
const OTHER_PROJECT = 'other';
const OTHER_KEY = 'the-other-groups-key';
// A CanyonProject someone who may edit CanyonProjects in `team-b` made by hand, claiming the
// restored workflow group's id with a key of their own, after the real one.
const IMPOSTOR_NAMESPACE = 'team-b';
const IMPOSTOR_KEY = 'the-impostors-key';

// Who may do what to CanyonProjects, by user, namespace and verb.
const RIGHTS: Record<string, Record<string, string[]>> = {
  alice: { [NAMESPACE]: ['get', 'update'] },
  bob: { [NAMESPACE]: ['get'] },
  carol: { [OTHER_NAMESPACE]: ['get', 'update'], [IMPOSTOR_NAMESPACE]: ['get', 'update'] },
};
const USERS: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob', 'carol-token': 'carol' };

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
    creationTimestamp: '2026-01-01T00:00:00Z',
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

const other_project = {
  metadata: {
    name: OTHER_PROJECT,
    namespace: OTHER_NAMESPACE,
    creationTimestamp: '2026-01-02T00:00:00Z',
    labels: { 'canyonos.canyoncode.ai/project': OTHER_PROJECT },
  },
  spec: {
    projectID: OTHER_ID,
    displayName: OTHER_PROJECT,
    auth: { apiKeyHash: hashApiKey(OTHER_KEY) },
  },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
};

const impostor = {
  metadata: {
    name: PROJECT,
    namespace: IMPOSTOR_NAMESPACE,
    creationTimestamp: '2026-01-03T00:00:00Z',
    labels: { 'canyonos.canyoncode.ai/project': PROJECT },
  },
  spec: {
    projectID: RESTORED_ID,
    displayName: PROJECT,
    auth: { apiKeyHash: hashApiKey(IMPOSTOR_KEY) },
  },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
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
  if (path === `${canyonos}/canyonprojects`) {
    return items([...(project_present ? [project()] : []), other_project, impostor]);
  }
  if (path === `${scoped}/canyonprojects`) return items(project_present ? [project()] : []);
  if (path === `${canyonos}/namespaces/${OTHER_NAMESPACE}/canyonprojects`) {
    return items([other_project]);
  }
  if (path === `${canyonos}/namespaces/${IMPOSTOR_NAMESPACE}/canyonprojects`) {
    return items([impostor]);
  }
  if (path.startsWith(`${canyonos}/namespaces/${OTHER_NAMESPACE}/`)) return items([]);
  if (path.startsWith(`${canyonos}/namespaces/${IMPOSTOR_NAMESPACE}/`)) return items([]);
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
let database_url = '';

/** Starts the Kubernetes API against the stub and `database_url`, and waits until it is ready:
 * the /v1 routes answer 503 until its database is migrated and its restore ran. */
const start_kubernetes_api = () =>
  spawn_api({
    APP_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL: database_url,
    CANYONOS_TARGET: 'kubernetes',
    CANYONOS_K8S_API: `http://127.0.0.1:${stub.port}`,
    CANYONOS_WORKSPACE_DIR: workspace,
  });

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
  database_url = await kubernetes_database();
  kubernetes_api = await start_kubernetes_api();
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
  test("checks the caller's Kubernetes login instead of a key, before the request is read", async () => {
    for (const token of [null, TEST_API_KEY, 'not-a-cluster-token']) {
      const refused = await v1('', token);
      expect(refused.status).toBe(401);
      expect(((await refused.json()) as { error: string }).error).toBe('auth.unauthenticated');
    }

    const listed = await v1('', BOB);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      workflow_groups: [
        { workflow_group_id: RESTORED_ID, name: PROJECT },
        { workflow_group_id: OTHER_ID, name: OTHER_PROJECT },
      ].sort((x, y) => x.workflow_group_id.localeCompare(y.workflow_group_id)),
    });
  });

  test("a key of one workflow group on another's workflow is 404 workflows.not_found, and a key of neither 401", async () => {
    const scaling = (workflow_group_id: string, headers: Record<string, string>) =>
      fetch(
        `${kubernetes_api!.url}/v1/workflow-groups/${workflow_group_id}/workflows/${WORKFLOW_ID}/scaling`,
        { headers }
      );

    const crossed = await scaling(OTHER_ID, bearer(TEST_API_KEY));
    const crossed_back = await scaling(RESTORED_ID, bearer(OTHER_KEY));
    const stranger = await scaling(OTHER_ID, bearer('a key of no workflow group'));

    for (const refused of [crossed, crossed_back]) {
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: 'workflows.not_found' });
    }
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toMatchObject({ error: 'auth.invalid_key' });
  });

  test("a CanyonProject made by hand in another namespace, claiming a running workflow group's id, restores nothing: the first one's key and namespace hold", async () => {
    const scaling = (headers: Record<string, string>) =>
      fetch(
        `${kubernetes_api!.url}/v1/workflow-groups/${RESTORED_ID}/workflows/${WORKFLOW_ID}/scaling`,
        { headers }
      );

    expect((await scaling(bearer(TEST_API_KEY))).status).not.toBe(401);
    const impostor_key = await scaling(bearer(IMPOSTOR_KEY));
    expect(impostor_key.status).toBe(401);
    expect(await impostor_key.json()).toMatchObject({ error: 'auth.invalid_key' });
    // Its deploy stays in team-a: bob, who may read there, reads it; carol, who may edit
    // team-b, may not.
    expect((await v1(`/${RESTORED_ID}`, BOB)).status).toBe(200);
    const carol = await v1(`/${RESTORED_ID}`, 'carol-token');
    expect(carol.status).toBe(403);
    expect(await carol.json()).toMatchObject({
      message: `carol may not get CanyonProjects in namespace ${NAMESPACE}.`,
    });
  });

  test('a change on a workflow group whose id is percent-encoded in the path is checked against its namespace, as the router reads the id', async () => {
    const encoded = `%${RESTORED_ID.charCodeAt(0).toString(16)}${RESTORED_ID.slice(1)}`;
    const before = deleted.length;

    const refused = await v1(`/${encoded}`, BOB, { method: 'DELETE' });

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'auth.forbidden' });
    expect(deleted.length).toBe(before);
    expect((await v1(`/${encoded}`, BOB)).status).toBe(200);
  });

  test("a workflow's dashboard routes take the key its workflow group's CanyonProject holds", async () => {
    const scaling = (headers: Record<string, string>) =>
      fetch(
        `${kubernetes_api!.url}/v1/workflow-groups/${RESTORED_ID}/workflows/${WORKFLOW_ID}/scaling`,
        { headers }
      );

    const missing = await scaling({});
    const wrong = await scaling(bearer(ALICE));
    const keyed = await scaling(bearer(TEST_API_KEY));

    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: 'auth.missing_key' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'auth.invalid_key' });
    expect(keyed.status).not.toBe(401);
  });

  // request.url reads `\` as `/` but the router does not: each reaches a workflow group's route,
  // not the dashboard's, which would take the workflow group's key.
  const group = `/v1/workflow-groups/${RESTORED_ID}`;
  const backslash_targets = [
    ['GET', `${group}\\workflows\\${WORKFLOW_ID}\\requests`],
    ['DELETE', `${group}/workflows/${WORKFLOW_ID}\\requests`],
  ] as const;

  for (const [method, target] of backslash_targets) {
    test(`${method} ${target} takes the Kubernetes login, not the workflow group's key`, async () => {
      const { status, body } = await raw_request(
        method,
        target,
        bearer(TEST_API_KEY),
        kubernetes_api!.port
      );

      expect(status).toBe(401);
      expect(JSON.parse(body)).toMatchObject({ error: 'auth.unauthenticated' });
    });
  }

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

  test('an API started again finds the workflow groups once more, each behind its own key', async () => {
    const scaling = (workflow_group_id: string, headers: Record<string, string>) =>
      fetch(
        `${kubernetes_api!.url}/v1/workflow-groups/${workflow_group_id}/workflows/${WORKFLOW_ID}/scaling`,
        { headers }
      );
    await kubernetes_api!.stop();
    kubernetes_api = await start_kubernetes_api();

    const listed = (await (await v1('', BOB)).json()) as {
      workflow_groups: { workflow_group_id: string }[];
    };
    expect(listed.workflow_groups.map(({ workflow_group_id }) => workflow_group_id)).toEqual(
      expect.arrayContaining([RESTORED_ID, OTHER_ID])
    );
    expect((await v1(`/${RESTORED_ID}`, BOB)).status).toBe(200);
    expect((await scaling(RESTORED_ID, bearer(TEST_API_KEY))).status).not.toBe(401);
    expect((await scaling(RESTORED_ID, bearer(IMPOSTOR_KEY))).status).toBe(401);
    expect((await scaling(RESTORED_ID, bearer(OTHER_KEY))).status).toBe(404);
    expect((await scaling(OTHER_ID, bearer(OTHER_KEY))).status).not.toBe(401);
    expect((await scaling(OTHER_ID, bearer(TEST_API_KEY))).status).toBe(404);
  }, 40_000);

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
