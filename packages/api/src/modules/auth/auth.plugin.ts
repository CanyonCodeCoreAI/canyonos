// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto';

import { Elysia } from 'elysia';
import type { BunRequest } from 'bun';
import type { Context } from 'elysia';

import { database_state, require_database } from '@api/db/database';
import { config } from '@core/env';
import { early_refusal, known_app_error, unauthorized } from '@core/errors';
import type { AppError } from '@core/errors';

import { workflow_groups_repo } from '../workflow-groups/workflow-groups.repo';
import { workflow_not_found } from '../workflows/workflows.service';

// Each workflow group has its own API key: `workflow_groups.api_key_hash`, its sha256, set by its
// deploy; a workflow group whose hash is null is open. Every check reads the hash from the
// database as the request arrives, so a changed key holds from the next request on. One rule
// decides every check (`opens`): the dashboard routes of a workflow (apiKeyGuard, here), the
// routes with no workflow group in their path, which answer with what the key opens
// (`opened_by_key`), and the /v1/workflow-groups routes on Docker, which the machine's deploy key
// opens too (workflow-groups.caller.ts).

/** The paths with no workflow group in them that answer with the workflows of the workflow
 * groups the key opens: each, and everything under it. */
export const API_KEY_PATHS = ['/v1/workflows', '/v1/resources', '/v1/auth/check'] as const;

const AUTH_CHECK_PATH = '/v1/auth/check';

/** What the dashboard reads and sets of one workflow, under its workflow group: these take that
 * workflow group's key on Kubernetes too, where the other /v1/workflow-groups routes take the
 * caller's Kubernetes login. */
export const DASHBOARD_PATH =
  /^\/v1\/workflow-groups\/[^/]+\/workflows\/[^/]+\/(?:requests|metrics|monitoring|prompts|scaling|governance|history|sample-data)(?:\/|$)/;

/** Where a Global Controller sends its workflow group's telemetry, which takes no key. */
export const TELEMETRY_PATH = /^\/v1\/workflow-groups\/[^/]+\/(traces|metrics|logs)$/;

/** A route on one workflow group, its id as the path spells it in group 1. */
const WORKFLOW_GROUP_PATH = /^\/v1\/workflow-groups\/([^/]+)(?:\/|$)/;

/** A workflow group's id, the only kind this API records. */
export const WORKFLOW_GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route's path parameters as the router decoded them; none for a request no route took. */
const routed_params = (request: Request): Record<string, string> =>
  (request as Partial<BunRequest>).params ?? {};

/** Whether the router answers `request` on a path `pattern` matches. */
export function is_routed_to(request: Request, pattern: RegExp): boolean {
  return (
    pattern.test(new URL(request.url).pathname) &&
    // request.url takes `\` for `/` and the router does not: such a path reached another route.
    !Object.values(routed_params(request)).some((value) => value.includes('\\'))
  );
}

function decoded(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The workflow group id of the route that answers `request`, lowercase, as the router reads it:
 * decoded, so a percent-encoded id is the same workflow group. Null when the path names none, or
 * one this API could not record. */
export function routed_workflow_group_id(request: Request): string | null {
  const id =
    routed_params(request).workflow_group_id ??
    decoded(WORKFLOW_GROUP_PATH.exec(new URL(request.url).pathname)?.[1]);
  return id && WORKFLOW_GROUP_ID.test(id) ? id.toLowerCase() : null;
}

/** The workflow id of the dashboard route that answers `request`, as the router reads it. */
const routed_workflow_id = (request: Request): string => routed_params(request).workflow_id ?? '';

const BEARER = /^bearer\s+(.+)$/i;

/** The key `request` sends as `Authorization: Bearer <key>`, trimmed; null for none. */
export function bearer_key(request: Request): string | null {
  return request.headers.get('authorization')?.trim().match(BEARER)?.[1]?.trim() || null;
}

/** The sha256 of the key `request` sends; null for none. */
export function sent_key_hash(request: Request): Buffer | null {
  const key = bearer_key(request);
  return key ? createHash('sha256').update(key, 'utf8').digest() : null;
}

/** The rule every check applies: whether `key_hash` opens a workflow group whose key hash is
 * `stored`. One with no key is open to anyone; else the hash must be its own, compared in
 * constant time. */
export function opens(key_hash: Buffer | null, stored: string | null): boolean {
  if (stored === null) return true;
  if (key_hash === null) return false;
  const expected = Buffer.from(stored, 'hex');
  return expected.length === key_hash.length && timingSafeEqual(expected, key_hash);
}

const deploy_key_hash = config.auth.deployKeyHash;

/** Whether this API has no deploy key hash, so what only the deploy key may do is open. */
export const DEPLOY_KEY_UNSET = deploy_key_hash === null;

/** Whether `key_hash` is this machine's deploy key's; never while the API has none. */
export const is_deploy_key = (key_hash: Buffer | null): boolean =>
  deploy_key_hash !== null && key_hash !== null && opens(key_hash, deploy_key_hash);

/** The workflow groups a caller opens: every one, as the deploy key does, or those of `ids`. */
export type OpenedWorkflowGroups = 'every' | { readonly ids: readonly string[] };

/** Whether `opened` has workflow group `workflow_group_id`. */
export const opened_has = (opened: OpenedWorkflowGroups, workflow_group_id: string): boolean =>
  opened === 'every' || opened.ids.includes(workflow_group_id);

/** What a key reaches of the recorded workflow groups. */
export interface KeyReach {
  /** The workflow groups it opens: the open ones, and each whose key it is. */
  readonly ids: string[];
  /** Whether it is the key of a workflow group. */
  readonly unlocks: boolean;
  /** Whether any workflow group has a key. */
  readonly any_keyed: boolean;
}

export async function reach_of(key_hash: Buffer | null): Promise<KeyReach> {
  require_database();
  const groups = await workflow_groups_repo.api_key_hashes();
  const keyed = groups.filter(({ api_key_hash }) => api_key_hash !== null);
  return {
    ids: groups.filter(({ api_key_hash }) => opens(key_hash, api_key_hash)).map(({ id }) => id),
    unlocks: key_hash !== null && keyed.some(({ api_key_hash }) => opens(key_hash, api_key_hash)),
    any_keyed: keyed.length > 0,
  };
}

/** The 401 for a request without the key `opened_by` names, such as "the API key of workflow
 * group <id>": `auth.missing_key` when it sent none, `auth.invalid_key` when it sent another. */
export function key_refusal(key_hash: Buffer | null, opened_by: string): AppError {
  if (key_hash === null) {
    return unauthorized(
      'auth.missing_key',
      `Send ${opened_by}, as \`Authorization: Bearer <key>\``
    );
  }
  return unauthorized('auth.invalid_key', `This key is not ${opened_by}`);
}

export const group_key = (workflow_group_id: string | null) =>
  `the API key of ${workflow_group_id ? `workflow group ${workflow_group_id}` : 'this workflow group'}`;

type Guarded = Pick<Context, 'request' | 'set'>;

/** What a request hook answers an error of its own check with: a refusal (`early_refusal`),
 * such as 503 `database.unavailable` while the database is not ready, or the error again. */
export function hook_refusal(set: Guarded['set'], error: unknown) {
  const known = known_app_error(error);
  if (known) return early_refusal(set, known);
  throw error;
}

/** Why a dashboard route of a workflow group refuses `request`, or null: the workflow group is
 * open, or the key its own. A workflow group with no row, or no id this API could record, is
 * nobody's. 401 only to a key that opens no workflow group; one that opens another, or a caller
 * who needs none, gets 404 `workflows.not_found`, as for a workflow that is not there, so the
 * dashboard keeps its session and learns nothing of what other workflow groups run. */
async function dashboard_refusal(request: Request): Promise<AppError | null> {
  require_database();
  const key_hash = sent_key_hash(request);
  const workflow_group_id = routed_workflow_group_id(request);
  const row = workflow_group_id ? await workflow_groups_repo.api_key_hash(workflow_group_id) : null;
  if (row && opens(key_hash, row.api_key_hash)) return null;
  const reach = await reach_of(key_hash);
  if (reach.unlocks || !reach.any_keyed) return workflow_not_found(routed_workflow_id(request));
  return key_refusal(key_hash, group_key(workflow_group_id));
}

/** Checks the key of a dashboard route under a workflow group as the request arrives, before
 * its body, params or query are read or checked, so a request without the key learns nothing
 * about what it sent. 503 `database.unavailable` until the database is ready. */
export async function requireApiKey({ request, set }: Guarded) {
  if (!is_routed_to(request, DASHBOARD_PATH)) return;
  try {
    const refusal = await dashboard_refusal(request);
    return refusal ? early_refusal(set, refusal) : undefined;
  } catch (error) {
    return hook_refusal(set, error);
  }
}

/** The workflow groups the key of `request` opens, for a route of API_KEY_PATHS to answer with
 * their workflows only; thrown as 401 when the key opens none of the workflow groups that have
 * one, and for /v1/auth/check with no key while any has one. While none has a key, a key sent is
 * ignored. A route's `derive` runs it before the route's params, query or body are checked. */
export async function opened_by_key(
  request: Request
): Promise<{ readonly ids: readonly string[] }> {
  const key_hash = sent_key_hash(request);
  const reach = await reach_of(key_hash);
  if (reach.any_keyed && !reach.unlocks) {
    if (key_hash) {
      throw unauthorized(
        'auth.invalid_key',
        'This key opens no workflow group. Send the API key a workflow group was deployed with'
      );
    }
    if (new URL(request.url).pathname === AUTH_CHECK_PATH) {
      throw key_refusal(null, 'the API key of a workflow group');
    }
  }
  return { ids: reach.ids };
}

/** Whether a caller needs a key: some workflow group has one. True too while the database is not
 * ready to say. */
export async function api_key_required(): Promise<boolean> {
  if (database_state() !== 'ready') return true;
  const groups = await workflow_groups_repo.api_key_hashes();
  return groups.some(({ api_key_hash }) => api_key_hash !== null);
}

/** Checks the key of every dashboard route. Mount it after the CORS plugin, so a preflight is
 * answered without a key and a 401 carries the CORS headers a browser needs to read it. */
export const apiKeyGuard = new Elysia({ name: 'auth.api-key' }).onRequest(requireApiKey);
