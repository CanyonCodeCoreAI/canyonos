// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import type { Context } from 'elysia';

import { config } from '@core/env';
import { AppError, early_refusal, forbidden, unauthorized } from '@core/errors';
import * as k8s from '@core/kubernetes';

import { check_api_key, DASHBOARD_PATH, is_routed_to, TELEMETRY_PATH } from '../auth/auth.plugin';
import { deploy_namespace } from './workflow-groups.kubernetes';
import { workflow_groups_repo } from './workflow-groups.repo';

// Who may call /v1/workflow-groups. On Docker, whoever holds the API key (auth/auth.plugin.ts),
// and anyone when the API runs with none. On Kubernetes the caller sends their own Kubernetes
// login, `Authorization: Bearer <token>`: the cluster checks the token (a TokenReview, else 401)
// and whether they may `get` (for a read) or `update` (for a change) CanyonProjects in each
// namespace the request acts in (a SubjectAccessReview, else 403), so a deploy reaches only the
// namespaces its caller may edit. Before the body is read; a PUT of a workflow group's settings
// is checked again, against the namespace its body names, before anything is written.

// These routes serve no browser: no CORS. The exceptions: the dashboard's routes under a
// workflow's own path, which take the API key, and a workflow group's telemetry routes, which
// take no key.
export const WORKFLOW_GROUPS_PATH = '/v1/workflow-groups';

const BEARER = /^bearer\s+(.+)$/i;
const GROUP_PATH =
  /^\/v1\/workflow-groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

interface KubernetesUser {
  username?: string;
  uid?: string;
  groups?: string[];
  extra?: Record<string, string[]>;
}

interface TokenReview {
  status?: { authenticated?: boolean; user?: KubernetesUser };
}

interface SubjectAccessReview {
  status?: { allowed?: boolean };
}

type Verb = 'get' | 'update';

// The user each accepted request signed in as.
const callers = new WeakMap<Request, KubernetesUser>();

/** The namespace a workflow_group.yaml text names under `kubernetes.namespace`; null when it
 * names none or cannot be read, which asks for the right in every namespace. */
export function namespace_of(config_text: string): string | null {
  try {
    const parsed = Bun.YAML.parse(config_text) as { kubernetes?: { namespace?: unknown } } | null;
    const namespace = parsed?.kubernetes?.namespace;
    return typeof namespace === 'string' && namespace !== '' ? namespace : null;
  } catch {
    return null;
  }
}

/** The user the cluster signs `token` in as; null when it does not accept it. */
async function review_token(token: string): Promise<KubernetesUser | null> {
  const review = await k8s.request<TokenReview>(
    'POST',
    '/apis/authentication.k8s.io/v1/tokenreviews',
    {
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token },
      },
    }
  );
  return review.status?.authenticated ? (review.status.user ?? {}) : null;
}

/** Whether `user` may `verb` CanyonProjects in `namespace`, or in every namespace for null. */
async function may(user: KubernetesUser, verb: Verb, namespace: string | null): Promise<boolean> {
  const review = await k8s.request<SubjectAccessReview>(
    'POST',
    '/apis/authorization.k8s.io/v1/subjectaccessreviews',
    {
      body: {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SubjectAccessReview',
        spec: {
          user: user.username,
          uid: user.uid,
          groups: user.groups,
          extra: user.extra,
          resourceAttributes: {
            ...(namespace === null ? {} : { namespace }),
            verb,
            group: k8s.API_GROUP,
            resource: 'canyonprojects',
          },
        },
      },
    }
  );
  return review.status?.allowed === true;
}

function refused(user: KubernetesUser, verb: Verb, namespace: string | null): AppError {
  return forbidden(
    'auth.forbidden',
    `${user.username ?? 'This user'} may not ${verb} CanyonProjects ` +
      (namespace === null ? 'in every namespace.' : `in namespace ${namespace}.`)
  );
}

/** The namespaces a request about the workflow group acts in: its running deploy's, and the
 * one its uploaded workflow_group.yaml names. */
async function namespaces_of(workflow_group_id: string): Promise<Set<string | null>> {
  const namespaces = new Set<string | null>();
  const deployed = deploy_namespace(workflow_group_id);
  if (deployed) namespaces.add(deployed);
  const row = await workflow_groups_repo.find(workflow_group_id);
  if (row?.config != null) namespaces.add(namespace_of(row.config));
  return namespaces;
}

type Guarded = Pick<Context, 'request' | 'set'>;

/** Whether `request` is for a /v1/workflow-groups route this guard checks: not the dashboard's,
 * not the telemetry's. */
export function is_guarded_workflow_groups_path(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    (pathname === WORKFLOW_GROUPS_PATH || pathname.startsWith(`${WORKFLOW_GROUPS_PATH}/`)) &&
    !is_routed_to(request, DASHBOARD_PATH) &&
    !is_routed_to(request, TELEMETRY_PATH)
  );
}

/** Drops what the CORS plugin added: a browser on another origin may not read /v1/workflow-groups answers. */
function drop_cors_headers(set: Guarded['set']): void {
  for (const name of Object.keys(set.headers)) {
    if (name.startsWith('access-control-') || name === 'vary') delete set.headers[name];
  }
}

/** On Docker, lets a /v1/workflow-groups request through only with the API key, when the API
 * runs with one. Before its body is read or checked. Answers a preflight itself, 204 with no
 * CORS grant, so the CORS plugin never answers it. */
export function requireDockerCaller({ request, set }: Guarded) {
  if (!is_guarded_workflow_groups_path(request)) return;
  drop_cors_headers(set);
  const refusal = check_api_key({ request, set });
  if (refusal || request.method !== 'OPTIONS') return refusal;
  set.status = 204;
  return '';
}

function unauthenticated(set: Guarded['set'], message: string) {
  set.headers['www-authenticate'] = 'Bearer';
  return early_refusal(set, unauthorized('auth.unauthenticated', message));
}

/** Lets a /v1/workflow-groups request through only from a user the cluster signs in with its token, who may
 * act on CanyonProjects in the namespaces the request acts in. A request naming no workflow
 * group this API knows, such as the list, needs the sign-in only. */
export async function requireKubernetesCaller({ request, set }: Guarded) {
  if (!is_guarded_workflow_groups_path(request)) return;
  drop_cors_headers(set);
  const token = request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim();
  if (!token) {
    return unauthenticated(set, 'Send your Kubernetes login: `Authorization: Bearer <token>`.');
  }
  try {
    const user = await review_token(token);
    if (!user)
      return unauthenticated(set, 'The cluster does not accept this token: sign in again.');
    callers.set(request, user);
    const workflow_group_id = GROUP_PATH.exec(new URL(request.url).pathname)?.[1];
    if (!workflow_group_id) return;
    const verb: Verb = request.method === 'GET' || request.method === 'HEAD' ? 'get' : 'update';
    for (const namespace of await namespaces_of(workflow_group_id.toLowerCase())) {
      if (!(await may(user, verb, namespace))) {
        return early_refusal(set, refused(user, verb, namespace));
      }
    }
  } catch (error) {
    if (error instanceof AppError) return early_refusal(set, error);
    throw error;
  }
}

/** On Kubernetes, refuses (403) a PUT of a workflow group's settings unless its caller may
 * update CanyonProjects in the namespace `config_text` names, in every namespace when it names
 * none; checked once the body is read, before anything is written. Nothing to check on Docker,
 * whose API key may do everything. */
export async function check_settings_caller(request: Request, config_text: string): Promise<void> {
  if (config.workflowGroups.target !== 'kubernetes') return;
  const user = callers.get(request);
  if (!user) throw unauthorized('auth.unauthenticated', 'The request was not signed in');
  const namespace = namespace_of(config_text);
  if (!(await may(user, 'update', namespace))) throw refused(user, 'update', namespace);
}

/** Checks the caller of every /v1/workflow-groups request, by this API's target; mount it before the CORS
 * plugin, so a /v1/workflow-groups preflight gets no CORS answer. */
export const workflowGroupsGuard =
  config.workflowGroups.target === 'kubernetes'
    ? new Elysia({ name: 'auth.kubernetes-caller' }).onRequest(requireKubernetesCaller)
    : new Elysia({ name: 'auth.docker-caller' }).onRequest(requireDockerCaller);

/** Takes back the CORS headers the CORS plugin gave a /v1/workflow-groups request; mount it after that plugin. */
export const noCorsOnWorkflowGroups = new Elysia({
  name: 'auth.no-cors-on-workflow-groups',
}).onRequest(({ request, set }) => {
  if (is_guarded_workflow_groups_path(request)) drop_cors_headers(set);
});
