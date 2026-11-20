// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { DeployedFingerprints } from '@api/db/schema';
import { badGateway, conflict, notFound, serviceUnavailable } from '@core/errors';
import * as k8s from '@core/kubernetes';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { AppError } from '@core/errors';
import type { KubernetesObject } from '@core/kubernetes';

import { registry_repo } from '../registry/registry.repo';
import { core_answer } from './workflow-groups.core';
import { unknown_workflow_group } from './workflow-groups.errors';
import { with_group_lock } from './workflow-groups.lock';
import { workflow_groups_repo } from './workflow-groups.repo';
import {
  bundle_path,
  core_version,
  group_dir,
  run_sidecar_job,
  uploads_dir,
  write_whole,
} from './workflow-groups.sidecar';
import type { CoreReply } from './workflow-groups.core';
import type { WorkflowGroupRow } from './workflow-groups.repo';
import type { ApplyFailure, DeployReport, WorkflowGroupTarget } from './workflow-groups.target';
import type {
  AgentStatus,
  DeployPhase,
  Endpoint,
  HealthCheck,
  WorkflowGroupStatus,
} from './workflow-groups.types';

// The Kubernetes target, in the API pod: a deploy is a CanyonBuild, whose build pod takes the
// workflow group's upload, builds its images and applies its CanyonProject and CanyonAgents,
// which the operator runs. The upload lives in the pod's /workspace emptyDir, which the `core`
// sidecar shares and runs the `canyonos_core.cli` commands in (workflow-groups.sidecar.ts). There
// is no runner process: each deploy's progress is kept here, in memory, and rebuilt from the
// CanyonProjects after a restart. It behaves as the Python server that ran Kubernetes workflow
// groups before this API did.

const k8s_logger = logger.child({ domain: LOG_DOMAINS.WORKFLOW_GROUPS });

const STARTUP_TIMEOUT_MINUTES = 30;
// As long as `canyonos stop` used to wait for a project's agents to drain.
const STOP_TIMEOUT_MINUTES = 15;
const POLL_MS = 2_000;
// Where a build pod takes the upload (the operator's builders.UploadPort).
const UPLOAD_PORT = 8090;
const UPLOAD_TIMEOUT_MS = 300_000;
const PLAN_TIMEOUT_SECONDS = 120;
const PUT_WORKFLOW_TIMEOUT_SECONDS = 300;
const REMOVE_WORKFLOWS_TIMEOUT_SECONDS = 60;
const BUNDLE_TIMEOUT_SECONDS = 300;
const EXPLAINED_FAILURE_EXIT_CODE = 1;
const ERROR_TEXT_CHARACTERS = 300;
// Reasons the operator gives for a CanyonAgent that will never start as configured.
const FATAL_REASONS = ['NameMismatch', 'Unsupported', 'ProjectNotFound'];
const LABEL_PROJECT = `${k8s.API_GROUP}/project`;
const LABEL_AGENT = `${k8s.API_GROUP}/agent`;
// The fingerprints a workflow group runs, kept on its CanyonProject for after a restart.
const DEPLOYED_ANNOTATION = `${k8s.API_GROUP}/deployed`;
// What the operator labels the pods it runs with.
const OPERATOR_MANAGED_BY = 'canyonos-operator';
const GC_NAME = 'canyonos-gc';
const GC_CONTAINER = 'global-controller';
const BUILD_CONTAINER = 'build';
const DEPLOYMENT_CONFIG = 'workflow_group.yaml';
const ENV_FILE = '.env';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What `kubernetes-plan` answers: the deploy's `kubernetes:` settings and the Secrets of its
// `.env` files, by name, with their values; never logged or shown.
const PlanSchema = z.object({
  ok: z.literal(true),
  namespace: z.string().min(1),
  registry: z.string().nullish(),
  platform: z.string().nullish(),
  image_pull_secret: z.string().nullish(),
  env_secret: z.string().nullish(),
  secrets: z.record(z.record(z.string())),
  project: z.string().min(1),
  workflows: z.array(z.string()),
});
const PlanRefusalSchema = z.object({ error: z.string() });
const RemovedSchema = z.object({ removed: z.array(z.string()) });
const BundleSchema = z.object({ path: z.string(), bytes: z.number() });

type Plan = z.infer<typeof PlanSchema>;

interface Condition {
  type: string;
  status?: string;
  reason?: string;
  message?: string;
}

type Conditions = Record<string, Condition>;

interface Route {
  workflow: string;
  workflow_id?: string | null;
  agent: string;
  method: string;
  arguments?: string[];
}

type CanyonProject = KubernetesObject<
  {
    projectID?: string;
    displayName?: string;
    auth?: { apiKeyHash?: string };
    endpoint?: { routes?: Route[] };
  },
  { conditions?: Condition[]; endpointURL?: string }
>;
type CanyonAgent = KubernetesObject<
  { agentName: string; replicas: number },
  { conditions?: Condition[]; readyReplicas?: number }
>;
type CanyonBuild = KubernetesObject<
  Record<string, unknown>,
  { phase?: string; podName?: string; message?: string }
>;
type Pod = KubernetesObject<Record<string, unknown>, { podIP?: string }>;

/** One deploy of a workflow group to the cluster: where it runs, fixed when it starts (or found
 * again by `restore`), and its progress as the status reports it. */
interface ClusterDeploy {
  /** The workflow group's name, the `project` of its CanyonBuilds. */
  name: string;
  /** Null for a deploy whose config named none: it failed before it reached the cluster. */
  namespace: string | null;
  /** resource_name(name): the name of its CanyonProject and its objects' project label. */
  project: string | null;
  /** The CanyonBuild in progress, and its pod once the operator made one. */
  build: { name: string; pod: string | null } | null;
  /** The pod of its last build, whose log shows why a build failed. */
  last_build_pod: string | null;
  /** Found again by `restore`, so its upload is gone. */
  restored: boolean;
  phase: DeployPhase;
  message: string | null;
  steps: string[];
  error: string | null;
  error_code: WorkflowGroupStatus['error_code'];
  root_cause: string | null;
  stopping: boolean;
  finished: boolean;
  /** Woken when it starts stopping, finishes or changes phase. */
  waiters: Set<() => void>;
}

// By workflow_group_id.
const deploys = new Map<string, ClusterDeploy>();
// Workflow groups whose upload went with an earlier pod: a sync that sends some workflows only
// would build the group without the others.
const forgotten = new Set<string>();

class DeployTimeout extends Error {}

const message_of = (error: unknown) => (error instanceof Error ? error.message : String(error));

function new_deploy(name: string): ClusterDeploy {
  return {
    name,
    namespace: null,
    project: null,
    build: null,
    last_build_pod: null,
    restored: false,
    phase: 'starting',
    message: null,
    steps: [],
    error: null,
    error_code: null,
    root_cause: null,
    stopping: false,
    finished: false,
    waiters: new Set(),
  };
}

const is_running = (deploy: ClusterDeploy | undefined): deploy is ClusterDeploy =>
  deploy !== undefined && !deploy.finished;

function wake(deploy: ClusterDeploy): void {
  for (const waiter of deploy.waiters) waiter();
  deploy.waiters.clear();
}

/** Resolves when the deploy next changes, or after `ms`. */
function changed(deploy: ClusterDeploy, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  deploy.waiters.add(resolve);
  return promise.finally(() => clearTimeout(timer));
}

/** Waits a poll interval, cut short when the deploy starts stopping; whether it is not being
 * stopped. Throws DeployTimeout past `deadline`. */
async function poll(deploy: ClusterDeploy, deadline: number): Promise<boolean> {
  if (!deploy.stopping) await changed(deploy, POLL_MS);
  if (Date.now() > deadline) throw new DeployTimeout();
  return !deploy.stopping;
}

/** Marks the deploy failed, unless it is being stopped. */
function fail(
  deploy: ClusterDeploy,
  error: string,
  code: 'deploy_failed' | 'deploy_timeout',
  root_cause: string | null = null
): void {
  if (deploy.stopping) return;
  Object.assign(deploy, { phase: 'failed', error, error_code: code, root_cause });
  wake(deploy);
}

function finish(deploy: ClusterDeploy): void {
  if (deploy.phase !== 'failed') deploy.phase = 'stopped';
  deploy.finished = true;
  wake(deploy);
}

const canyon_path = (namespace: string, plural: string, name?: string) =>
  `${k8s.CANYONOS_API}/namespaces/${namespace}/${plural}${name ? `/${name}` : ''}`;
const core_path = (namespace: string, plural: string, name?: string) =>
  `/api/v1/namespaces/${namespace}/${plural}${name ? `/${name}` : ''}`;

/** The deploy's namespace and project, which a running deploy always has. */
function placed(deploy: ClusterDeploy): { namespace: string; project: string } {
  if (!deploy.namespace || !deploy.project) {
    throw new Error(`The deploy of ${deploy.name} has no namespace`);
  }
  return { namespace: deploy.namespace, project: deploy.project };
}

function conditions_of(object: { status?: { conditions?: Condition[] } }): Conditions {
  return Object.fromEntries((object.status?.conditions ?? []).map((c) => [c.type, c]));
}

/** The deploy's CanyonProject, null until its build applied it, and its CanyonAgents. */
async function project_objects(
  deploy: ClusterDeploy
): Promise<{ project: CanyonProject | null; agents: CanyonAgent[] }> {
  const { namespace, project } = placed(deploy);
  const labels = { [LABEL_PROJECT]: project };
  const [projects, agents] = await Promise.all([
    k8s.list<CanyonProject>(canyon_path(namespace, 'canyonprojects'), labels),
    k8s.list<CanyonAgent>(canyon_path(namespace, 'canyonagents'), labels),
  ]);
  return { project: projects[0] ?? null, agents };
}

/** Splits text into its lines, as Python's str.splitlines does. */
const split_lines = (text: string) =>
  text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);

/** The `kubernetes:` settings and `.env` Secrets of the upload, or why its config is invalid. */
async function plan(
  workflow_group_id: string,
  name: string
): Promise<{ plan: Plan } | { violations: string }> {
  const reply = await run_sidecar_job({
    workflow_group_id,
    command: ['kubernetes-plan', '--name', name],
    timeout_seconds: PLAN_TIMEOUT_SECONDS,
    secret: true,
  });
  if (reply.exit_code === 0) {
    const parsed = PlanSchema.safeParse(reply.answer);
    if (parsed.success) return { plan: parsed.data };
  } else if (reply.exit_code === EXPLAINED_FAILURE_EXIT_CODE) {
    const refusal = PlanRefusalSchema.safeParse(reply.answer);
    if (refusal.success) return { violations: refusal.data.error };
  }
  // Its answer holds the `.env` values: none of it is shown.
  throw badGateway(
    'workflow_groups.controller_failed',
    `The API's core sidecar could not plan the deploy (\`kubernetes-plan\` exit code ${reply.exit_code}); its answer is not shown, since it holds the .env values`
  );
}

/** Drops what the CanyonBuild leaves unset: null, empty text, `{}` and `[]`. */
function set_fields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => {
      if (value === null || value === undefined || value === '') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    })
  );
}

/** `YYYYmmdd-HHMMSS` in UTC, a CanyonBuild's image tag. */
function build_tag(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-` +
    `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`
  );
}

/** Whether a fetch failed to reach the pod at all, such as its receiver not listening yet. */
const unreached = (error: unknown) =>
  !(
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );

/** Sends the workflow group's workspace, without its `.env` files, to the receiver in build pod
 * `pod`; false when the receiver is not listening yet, so it is sent again next poll. */
async function upload(
  workflow_group_id: string,
  deploy: ClusterDeploy,
  pod: string
): Promise<boolean> {
  const { namespace } = placed(deploy);
  const bundle = bundle_path(workflow_group_id);
  if (!(await Bun.file(bundle).exists())) {
    await mkdir(join(bundle, '..'), { recursive: true });
    core_answer(
      await run_sidecar_job({
        workflow_group_id,
        command: ['bundle-workspace', '--out', bundle],
        timeout_seconds: BUNDLE_TIMEOUT_SECONDS,
      }),
      BundleSchema
    );
  }
  const address = (await k8s.get<Pod>(core_path(namespace, 'pods', pod))).status?.podIP;
  if (!address) return false;
  const host = address.includes(':') ? `[${address}]` : address;
  let response: Response;
  try {
    response = await fetch(`http://${host}:${UPLOAD_PORT}/`, {
      method: 'PUT',
      body: Bun.file(bundle),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (unreached(error)) return false;
    throw new Error(`The upload to build pod ${pod} failed: ${message_of(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Build pod ${pod} refused the upload with ${response.status}: ${text.slice(0, ERROR_TEXT_CHARACTERS)}`
    );
  }
  return true;
}

/** Builds the deploy's workflows as `plan` says: the `.env` files into Secrets, then a
 * CanyonBuild whose pod takes the upload, builds and pushes the images and applies the workflow
 * group. Returns why it failed, or null once it succeeded. */
async function build(
  workflow_group_id: string,
  deploy: ClusterDeploy,
  planned: Plan,
  auth: DeployedFingerprints['auth'],
  deadline: number
): Promise<string | null> {
  const { namespace, project } = placed(deploy);
  const labels = { [LABEL_PROJECT]: project, [k8s.MANAGED_BY_LABEL]: k8s.FIELD_MANAGER };
  for (const [secret, values] of Object.entries(planned.secrets)) {
    await k8s.apply(core_path(namespace, 'secrets', secret), {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: { name: secret, namespace, labels },
      stringData: values,
    });
  }
  const tag = build_tag();
  // Random too: two builds in the same second would otherwise share a name.
  const suffix = `-${tag}-${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
  const name = project.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix;
  const path = canyon_path(namespace, 'canyonbuilds', name);
  deploy.build = { name, pod: null };
  try {
    await k8s.apply(path, {
      apiVersion: `${k8s.API_GROUP}/${k8s.API_VERSION}`,
      kind: 'CanyonBuild',
      metadata: { name, namespace, labels },
      spec: set_fields({
        project: deploy.name,
        config: DEPLOYMENT_CONFIG,
        registry: planned.registry,
        tag,
        platform: planned.platform,
        envSecretRef: planned.env_secret,
        registrySecretRef: planned.image_pull_secret,
        imagePullSecrets: planned.image_pull_secret ? [{ name: planned.image_pull_secret }] : null,
        auth,
      }),
    });
    let uploaded = false;
    while (await poll(deploy, deadline)) {
      const status = (await k8s.get<CanyonBuild>(path)).status ?? {};
      if (status.podName) deploy.build.pod = deploy.last_build_pod = status.podName;
      if (status.phase === 'Failed') return status.message || 'The image build failed.';
      if (status.phase === 'Succeeded') {
        await k8s.remove(path);
        return null;
      }
      if (status.phase === 'Receiving' && !uploaded && status.podName) {
        uploaded = await upload(workflow_group_id, deploy, status.podName);
      }
    }
    return 'The deploy was stopped.';
  } finally {
    deploy.build = null;
    await rm(bundle_path(workflow_group_id), { force: true });
    // A stop that listed the builds before this one was applied would leave it behind.
    if (deploy.stopping) await k8s.remove(path).catch(() => undefined);
  }
}

/** Keeps the fingerprints the workflow group runs on its CanyonProject, where `restore` reads
 * them after the API restarts. */
async function record_deployed(
  workflow_group_id: string,
  deploy: ClusterDeploy,
  project: CanyonProject
): Promise<void> {
  const { namespace } = placed(deploy);
  const deployed = (await workflow_groups_repo.find(workflow_group_id))?.deployed ?? null;
  await k8s.merge_patch(canyon_path(namespace, 'canyonprojects', project.metadata.name), {
    metadata: { annotations: { [DEPLOYED_ANNOTATION]: JSON.stringify(deployed) } },
  });
}

/** Builds the deploy in the cluster, then waits for its agents, and stops it, holding the
 * workflow group's lock, once it failed. Runs on its own, after `start` returned. */
async function deploy_in_cluster(
  workflow_group_id: string,
  deploy: ClusterDeploy,
  planned: Plan,
  auth: DeployedFingerprints['auth']
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MINUTES * 60_000;
  try {
    deploy.message = 'Building images in the cluster...';
    const failure = await build(workflow_group_id, deploy, planned, auth, deadline);
    if (failure) {
      fail(deploy, 'Deploy failed.', 'deploy_failed', failure);
    } else {
      deploy.steps.push('Build complete');
      deploy.message = 'Starting agents...';
    }
    while (deploy.phase === 'starting' && (await poll(deploy, deadline))) {
      const { project, agents } = await project_objects(deploy);
      const fatal = agents.flatMap((agent) => {
        const ready = conditions_of(agent).Ready;
        return ready?.reason && FATAL_REASONS.includes(ready.reason)
          ? [`${agent.spec?.agentName}: ${ready.message}`]
          : [];
      });
      if (fatal.length > 0) {
        fail(deploy, 'Deploy failed.', 'deploy_failed', fatal.join('\n'));
      } else if (
        project &&
        agents.length > 0 &&
        [project, ...agents].every((object) => conditions_of(object).Ready?.status === 'True')
      ) {
        await record_deployed(workflow_group_id, deploy, project);
        deploy.phase = 'up';
        deploy.message = null;
        deploy.steps.push(`${agents.length} agent(s) ready`);
        wake(deploy);
      }
    }
  } catch (error) {
    if (error instanceof DeployTimeout) {
      fail(
        deploy,
        `The deploy was not up within ${STARTUP_TIMEOUT_MINUTES} minutes.`,
        'deploy_timeout'
      );
    } else {
      fail(deploy, 'Deploy failed.', 'deploy_failed', message_of(error));
    }
  }
  k8s_logger.info('Deploy settled', { workflow_group_id, phase: deploy.phase });
  await with_group_lock(workflow_group_id, async () => {
    if (deploy.phase === 'failed' && !deploy.finished) {
      const failure = await stop(deploy);
      if (failure)
        k8s_logger.warn('Could not stop a failed deploy', { workflow_group_id, failure });
    }
  });
}

/** Deletes the deploy's CanyonBuilds and CanyonProject, from which the operator removes the
 * rest, until none is left, then the ConfigMaps and Secrets its deploys wrote; fails when the
 * cluster refused, or they were still there after 15 minutes. */
async function stop(deploy: ClusterDeploy): Promise<ApplyFailure | null> {
  deploy.stopping = true;
  wake(deploy);
  if (!deploy.namespace || !deploy.project) {
    finish(deploy);
    return null;
  }
  const { namespace, project } = placed(deploy);
  const deadline = Date.now() + STOP_TIMEOUT_MINUTES * 60_000;
  try {
    for (;;) {
      const found: { path: string; deleting: boolean }[] = [];
      for (const plural of ['canyonbuilds', 'canyonprojects']) {
        for (const object of await k8s.list<KubernetesObject>(canyon_path(namespace, plural), {
          [LABEL_PROJECT]: project,
        })) {
          found.push({
            path: canyon_path(namespace, plural, object.metadata.name),
            deleting: object.metadata.deletionTimestamp !== undefined,
          });
        }
      }
      if (found.length === 0) break;
      if (Date.now() > deadline) {
        return {
          error: `${deploy.name} was still in the cluster after ${STOP_TIMEOUT_MINUTES} minutes`,
          code: 'stop_timeout',
        };
      }
      for (const { path, deleting } of found) {
        if (deleting) continue;
        await k8s.remove(path).catch((error: unknown) => {
          if (!k8s.is_not_found(error)) throw error;
        });
      }
      await Bun.sleep(POLL_MS);
    }
    const written = { [LABEL_PROJECT]: project, [k8s.MANAGED_BY_LABEL]: k8s.FIELD_MANAGER };
    for (const plural of ['configmaps', 'secrets']) {
      await k8s.remove_all(core_path(namespace, plural), written);
    }
  } catch (error) {
    return { error: message_of(error), code: 'stop_failed' };
  }
  finish(deploy);
  return null;
}

/** Plans the upload and starts building it in the cluster; how the deploy goes then shows in its
 * phase, as on the server it replaces: a config the plan refuses fails the deploy, not the
 * start. */
async function start(
  row: WorkflowGroupRow,
  uploaded: DeployedFingerprints
): Promise<ApplyFailure | null> {
  const planned = await plan(row.id, row.name);
  const deploy = new_deploy(row.name);
  deploys.set(row.id, deploy);
  if ('violations' in planned) {
    fail(deploy, 'Deploy failed.', 'deploy_failed', planned.violations);
    deploy.finished = true;
    return null;
  }
  deploy.namespace = planned.plan.namespace;
  deploy.project = planned.plan.project;
  await workflow_groups_repo.save_deployed(row.id, uploaded, null);
  void deploy_in_cluster(row.id, deploy, planned.plan, uploaded.auth);
  k8s_logger.info('Deploy started', {
    workflow_group_id: row.id,
    namespace: deploy.namespace,
    project: deploy.project,
  });
  return null;
}

/** Rebuilds the running deploy from the uploaded config, in the namespace it runs in, which
 * updates the config its Global Controller reloads, and waits for the build. */
async function reload(
  row: WorkflowGroupRow,
  deploy: ClusterDeploy,
  uploaded: DeployedFingerprints
): Promise<ApplyFailure | null> {
  const planned = await plan(row.id, deploy.name);
  if ('violations' in planned) return { error: planned.violations, code: 'config_invalid' };
  const deployed = row.deployed ?? uploaded;
  let failure: string | null;
  try {
    failure = await build(
      row.id,
      deploy,
      planned.plan,
      deployed.auth,
      Date.now() + STARTUP_TIMEOUT_MINUTES * 60_000
    );
  } catch (error) {
    if (error instanceof DeployTimeout) {
      return {
        error: `The build was not done within ${STARTUP_TIMEOUT_MINUTES} minutes.`,
        code: 'reload_timeout',
      };
    }
    failure = message_of(error);
  }
  if (failure) return { error: failure, code: 'reload_failed' };
  await workflow_groups_repo.save_deployed(row.id, { ...deployed, config: uploaded.config }, null);
  const { project } = await project_objects(deploy);
  if (project) await record_deployed(row.id, deploy, project);
  return null;
}

/** The workflow ids the uploaded workflow_group.yaml gives its workflows, by name. */
export function workflow_ids(config: string | null): Record<string, string> {
  if (config === null) return {};
  try {
    const parsed = Bun.YAML.parse(config) as {
      workflows?: Record<string, { workflow_id?: unknown }>;
    };
    return Object.fromEntries(
      Object.entries(parsed?.workflows ?? {}).flatMap(([name, workflow]) =>
        typeof workflow?.workflow_id === 'string' ? [[name, workflow.workflow_id]] : []
      )
    );
  } catch {
    return {};
  }
}

function endpoint_of(project: CanyonProject | null, row: WorkflowGroupRow | null): Endpoint | null {
  const url = project?.status?.endpointURL;
  if (!url) return null;
  const parsed = new URL(url);
  const ids = workflow_ids(row?.config ?? null);
  const base = url.replace(/\/+$/, '');
  return {
    public_host: parsed.hostname.replace(/^\[|\]$/g, ''),
    api_port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    routes: (project.spec?.endpoint?.routes ?? []).map((route) => {
      // The path the cluster's endpoint serves, as core's `route_path` makes it from the
      // route itself: `/<workflow_id>` only for a route that carries one. The workflow id the
      // config gives a workflow is reported, but the endpoint does not serve it as a path.
      const path = route.workflow_id
        ? `/${route.workflow_id}`
        : `/${route.workflow}/${route.agent}/${route.method}`;
      return {
        workflow: route.workflow,
        workflow_id: route.workflow_id ?? ids[route.workflow] ?? null,
        agent: route.agent,
        method: route.method,
        arguments: route.arguments ?? [],
        url: base + path,
      };
    }),
  };
}

function agents_of(agents: CanyonAgent[], row: WorkflowGroupRow | null): AgentStatus[] {
  const ids = workflow_ids(row?.config ?? null);
  return agents.map((agent) => {
    const ready = conditions_of(agent).Ready;
    const fatal = ready?.reason && [...FATAL_REASONS, 'Unschedulable'].includes(ready.reason);
    const name = agent.spec?.agentName ?? agent.metadata.name;
    // Agents are named `<workflow>.<agent>`.
    const workflow_id = ids[name.split('.')[0]!];
    return {
      agent_id: workflow_id ? Bun.randomUUIDv5(name, workflow_id) : null,
      name,
      desired_replicas: agent.spec?.replicas ?? 1,
      running_replicas: agent.status?.readyReplicas ?? 0,
      launch_error: fatal ? (ready.message ?? null) : null,
    };
  });
}

function not_running(): AppError {
  return conflict('workflow_groups.not_running', 'The deploy is not running');
}

/** The deploy of a workflow group this API holds; 404 when it has no row either. */
function located(
  workflow_group_id: string,
  row: WorkflowGroupRow | null
): ClusterDeploy | undefined {
  const deploy = deploys.get(workflow_group_id);
  if (!row && !deploy) throw unknown_workflow_group(workflow_group_id);
  return deploy;
}

function running_deploy(workflow_group_id: string, row: WorkflowGroupRow | null): ClusterDeploy {
  const deploy = located(workflow_group_id, row);
  if (!is_running(deploy)) throw not_running();
  return deploy;
}

/** The pod whose log is the deploy's log: its build pod's `build` container while it builds,
 * else its Global Controller, else the pod of its last build; null for none. */
async function log_source(
  deploy: ClusterDeploy
): Promise<{ pod: string; container: string } | null> {
  if (deploy.build?.pod) return { pod: deploy.build.pod, container: BUILD_CONTAINER };
  const { namespace, project } = placed(deploy);
  const [gc] = await k8s.list<Pod>(core_path(namespace, 'pods'), {
    'app.kubernetes.io/name': GC_NAME,
    [LABEL_PROJECT]: project,
  });
  if (gc) return { pod: gc.metadata.name, container: GC_CONTAINER };
  return deploy.last_build_pod ? { pod: deploy.last_build_pod, container: BUILD_CONTAINER } : null;
}

/** The deploy's log as it comes, from one pod to the next as the deploy moves from its build to
 * its Global Controller, until the deploy finishes or `signal` aborts. */
function follow_deploy_log(
  deploy: ClusterDeploy,
  tail: string,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  );
  const over = () => deploy.finished || signal.aborted;
  const ended = (async () => {
    while (!over()) await Promise.race([changed(deploy, POLL_MS), aborted]);
  })();
  async function* lines(): AsyncGenerator<Uint8Array> {
    const { namespace } = placed(deploy);
    let last: string | null = null;
    while (!over()) {
      const source = await log_source(deploy).catch(() => null);
      const key = source && `${source.pod}/${source.container}`;
      if (!source || key === last) {
        await Promise.race([changed(deploy, POLL_MS), ended]);
        if (!source) continue;
      }
      let stream: ReadableStream<Uint8Array>;
      try {
        // A pod already followed is followed again from its new lines, as after a restart.
        stream = await k8s.follow_pod_log(
          namespace,
          source.pod,
          { container: source.container, tail: last === null ? tail : key === last ? '0' : 'all' },
          signal
        );
      } catch {
        last = key;
        continue;
      }
      last = key;
      const reader = stream.getReader();
      try {
        for (;;) {
          const next = await Promise.race([reader.read(), ended.then(() => null)]);
          if (next === null || next.done) break;
          yield next.value;
        }
      } catch {
        // The pod went, or the caller left.
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    }
  }
  const generator = lines();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await generator.return(undefined);
    },
  });
}

const text = (body: BodyInit | null) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** The namespaces a request about the workflow group acts in, for the caller check: the one its
 * running deploy is in. */
export function deploy_namespace(workflow_group_id: string): string | null {
  return deploys.get(workflow_group_id)?.namespace ?? null;
}

/** Whether this API runs a deploy of the workflow group, or found one at restore. */
export const holds_deploy = (workflow_group_id: string) => deploys.has(workflow_group_id);

/** Streams an upload's body to a file in /workspace, outside every workflow group's folder. */
async function receive_archive(body: ReadableStream<Uint8Array>): Promise<Blob> {
  await mkdir(uploads_dir(), { recursive: true });
  const path = join(uploads_dir(), `${crypto.randomUUID()}.tar.gz`);
  const sink = Bun.file(path).writer();
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await sink.write(value);
    }
    await sink.end();
  } catch (error) {
    await Promise.resolve(sink.end()).catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  return Bun.file(path);
}

async function remove_workflows(workflow_group_id: string, names: string[]): Promise<void> {
  core_answer(
    await run_sidecar_job({
      workflow_group_id,
      command: ['remove-workflows', ...names],
      timeout_seconds: REMOVE_WORKFLOWS_TIMEOUT_SECONDS,
    }),
    RemovedSchema
  );
}

/** Writes workflow_group.yaml and its `.env` into the workflow group's folder, each whole, and
 * removes that `.env` for none. */
async function write_group_files(
  workflow_group_id: string,
  config: string,
  env: string | null
): Promise<void> {
  const dir = group_dir(workflow_group_id);
  await mkdir(dir, { recursive: true });
  await write_whole(join(dir, DEPLOYMENT_CONFIG), config);
  if (env === null) await rm(join(dir, ENV_FILE), { force: true });
  else await write_whole(join(dir, ENV_FILE), env);
}

export const kubernetes_target: WorkflowGroupTarget = {
  resumes_apply_loops: false,

  async workflow_group_ids() {
    return [...deploys.keys()];
  },

  async put_group_files(workflow_group_id, body) {
    const before = await workflow_groups_repo.find(workflow_group_id);
    if (
      body.workflows == null &&
      forgotten.has(workflow_group_id) &&
      Object.keys(before?.workflows ?? {}).length === 0
    ) {
      throw conflict(
        'workflow_groups.reupload_needed',
        "Run `canyonos deploy` again: the API restarted and holds none of this workflow group's workflows"
      );
    }
    const row = await workflow_groups_repo.claim(workflow_group_id, null);
    await write_group_files(workflow_group_id, body.config, body.env);
    const listed = body.workflows ? new Set(body.workflows) : null;
    const removed = Object.entries(row.workflows).filter(
      ([workflow_id]) => listed && !listed.has(workflow_id)
    );
    if (removed.length > 0) {
      await remove_workflows(
        workflow_group_id,
        removed.map(([, workflow]) => workflow.name)
      );
    }
    if (listed) forgotten.delete(workflow_group_id);
    return { removed_workflows: removed.map(([workflow_id]) => workflow_id) };
  },

  receive_archive,

  async put_workflow(workflow_group_id, name, archive): Promise<CoreReply> {
    const path = (archive as Blob & { name?: string }).name;
    if (!path) throw new Error('The upload was not received into a file');
    try {
      await workflow_groups_repo.claim(workflow_group_id, null);
      return await run_sidecar_job({
        workflow_group_id,
        command: ['put-workflow', name, '--archive', path],
        timeout_seconds: PUT_WORKFLOW_TIMEOUT_SECONDS,
      });
    } finally {
      await rm(path, { force: true });
    }
  },

  remove_workflows,

  async uploaded_workflows(workflow_group_id, row) {
    located(workflow_group_id, row);
    return row?.workflows ?? {};
  },

  async stop_unlisted(workflow_group_id) {
    const deploy = located(workflow_group_id, null);
    return is_running(deploy) ? stop(deploy) : null;
  },

  /** Holds again each workflow group whose CanyonProject is in the cluster, as a deploy that is
   * up, so stop, status and logs reach it: its namespace and name from the CanyonProject, and
   * the fingerprints and API key it runs from its annotation and spec. The uploads were in the
   * old pod's /workspace, so every row starts with no workflows and nothing to apply, and a
   * CanyonBuild a restart cut short is deleted. */
  async restore() {
    await workflow_groups_repo.forget_uploads();
    for (const { id } of await workflow_groups_repo.list()) forgotten.add(id);
    const projects = await k8s.list<CanyonProject>(`${k8s.CANYONOS_API}/canyonprojects`);
    for (const project of projects) {
      const workflow_group_id = project.spec?.projectID;
      const name = project.spec?.displayName;
      const namespace = project.metadata.namespace;
      if (!workflow_group_id || !UUID.test(workflow_group_id) || !name || !namespace) continue;
      let deployed: DeployedFingerprints | null = null;
      try {
        const annotation = project.metadata.annotations?.[DEPLOYED_ANNOTATION];
        deployed = annotation ? (JSON.parse(annotation) as DeployedFingerprints) : null;
      } catch {
        // Not readable: its next deploy restarts it.
      }
      await workflow_groups_repo.restore(workflow_group_id, {
        name,
        api_key_hash: project.spec?.auth?.apiKeyHash ?? null,
        deployed,
      });
      const deploy = new_deploy(name);
      Object.assign(deploy, {
        namespace,
        project: k8s.resource_name(name),
        restored: true,
        phase: 'up',
      });
      deploys.set(workflow_group_id, deploy);
      forgotten.add(workflow_group_id);
      const builds = await k8s
        .list<CanyonBuild>(canyon_path(namespace, 'canyonbuilds'), {
          [LABEL_PROJECT]: deploy.project!,
        })
        .catch(() => []);
      for (const leftover of builds) {
        await k8s
          .remove(canyon_path(namespace, 'canyonbuilds', leftover.metadata.name))
          .catch((error: unknown) =>
            k8s_logger.warn('Could not delete a CanyonBuild a restart cut short', { error })
          );
      }
    }
    k8s_logger.info('Restored the workflow groups running in the cluster', {
      workflow_groups: deploys.size,
    });
  },

  async begin_apply(row) {
    const deploy = deploys.get(row.id);
    const running = is_running(deploy);
    return {
      row,
      running,
      start: (uploaded) => start(row, uploaded),
      stop: async () => (is_running(deploy) ? stop(deploy) : null),
      reload: async (uploaded) => (is_running(deploy) ? reload(row, deploy, uploaded) : null),
    };
  },

  async starting(workflow_group_id) {
    const deploy = deploys.get(workflow_group_id);
    return is_running(deploy) && deploy.phase === 'starting';
  },

  async report(workflow_group_id, row): Promise<DeployReport> {
    const deploy = located(workflow_group_id, row);
    const report: DeployReport = {
      version: await core_version(),
      running: is_running(deploy),
      phase: deploy?.phase ?? null,
      message: deploy?.message ?? null,
      steps: [...(deploy?.steps ?? [])],
      slowest_step: null,
      idle_seconds: null,
      error: deploy?.error ?? null,
      error_code: deploy?.error_code ?? null,
      root_cause: deploy?.root_cause ?? null,
      endpoint: null,
      agents: null,
      machine_errors: null,
      errors: [],
    };
    if (!is_running(deploy) || !deploy.namespace) return report;
    try {
      const { project, agents } = await project_objects(deploy);
      report.endpoint = endpoint_of(project, row);
      report.agents = agents_of(agents, row);
    } catch (error) {
      report.errors.push(`Could not read the deploy in the cluster: ${message_of(error)}`);
    }
    return report;
  },

  async controller_log(workflow_group_id, row, tail, follow, signal) {
    const deploy = located(workflow_group_id, row);
    if (!deploy?.namespace) return text('');
    if (follow) return text(follow_deploy_log(deploy, tail, signal));
    const source = await log_source(deploy);
    if (!source) return text('');
    try {
      return text(await k8s.pod_log(deploy.namespace, source.pod, { ...source, tail }));
    } catch (error) {
      if (k8s.is_not_found(error)) return text('');
      throw error;
    }
  },

  async health(workflow_group_id, row) {
    const deploy = running_deploy(workflow_group_id, row);
    const { namespace, project: project_name } = placed(deploy);
    const { project, agents } = await project_objects(deploy);
    const conditions = project ? conditions_of(project) : {};
    const describe = `see \`kubectl -n ${namespace} describe canyonproject ${project_name}\``;
    const condition_check = (name: string, kind: string): HealthCheck => {
      const ok = conditions[kind]?.status === 'True';
      return {
        name,
        ok,
        detail: conditions[kind]?.message || 'not reported yet',
        fix: ok ? null : describe,
      };
    };
    const short = agents.flatMap((agent) => {
      const ready = agent.status?.readyReplicas ?? 0;
      const replicas = agent.spec?.replicas ?? 1;
      return ready < replicas
        ? [`${agent.spec?.agentName}: ${ready} of ${replicas} replicas ready`]
        : [];
    });
    const checks: HealthCheck[] = [
      condition_check('Global Controller', 'ControllerReady'),
      condition_check('Redis', 'RedisReady'),
      {
        name: 'Workflow agents',
        ok: short.length === 0,
        detail: short.join('; ') || `${agents.length} agent(s) running`,
        fix:
          short.length === 0
            ? null
            : 'run `canyonos logs <agent>` to see why, or `canyonos status` for its launch error',
      },
      condition_check('Endpoint', 'EndpointReady'),
    ];
    return { ok: checks.every(({ ok }) => ok), checks };
  },

  async agent_logs(workflow_group_id, row, name, tail) {
    const deploy = running_deploy(workflow_group_id, row);
    const { namespace, project } = placed(deploy);
    let agents: CanyonAgent[];
    let pods: string[];
    let objects: Set<string>;
    try {
      agents = await k8s.list<CanyonAgent>(canyon_path(namespace, 'canyonagents'), {
        [LABEL_PROJECT]: project,
      });
      objects = new Set(
        agents.filter((agent) => agent.spec?.agentName === name).map((a) => a.metadata.name)
      );
      // One replica: its pod has its name, as Kubernetes writes it.
      let replica: string | null = null;
      try {
        replica = k8s.resource_name(name);
      } catch {
        replica = null;
      }
      pods = (
        await k8s.list<Pod>(core_path(namespace, 'pods'), {
          [k8s.MANAGED_BY_LABEL]: OPERATOR_MANAGED_BY,
        })
      )
        .filter(
          (pod) =>
            pod.metadata.name === replica || objects.has(pod.metadata.labels?.[LABEL_AGENT] ?? '')
        )
        .map((pod) => pod.metadata.name);
    } catch (error) {
      throw serviceUnavailable(
        'workflow_groups.replicas_unreadable',
        `Could not read the replicas: ${message_of(error)}`
      );
    }
    if (pods.length === 0 && objects.size === 0) {
      const names = agents.map((agent) => agent.spec?.agentName).join(', ');
      throw notFound(
        'workflow_groups.unknown_agent',
        `No agent or replica is named ${name}; the agents are ${names}`
      );
    }
    const logs = await Promise.all(
      pods.map(async (pod): Promise<[string, string[]]> => {
        try {
          return [pod, split_lines(await k8s.pod_log(namespace, pod, { tail }))];
        } catch (error) {
          return [pod, [`Could not read the log: ${message_of(error)}`]];
        }
      })
    );
    return { logs: Object.fromEntries(logs) };
  },

  /** The operator's registry already makes the dashboard know the workflow group's workflows:
   * nothing to register, only the workflows it knows; a registration sent is not used. */
  async register_dashboard(workflow_group_id, row) {
    located(workflow_group_id, row);
    return { workflows: await registry_repo.workflows_of_group(workflow_group_id) };
  },
};
