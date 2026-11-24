// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from '@api/app';
import { API_KEY_PATHS, DASHBOARD_PATH, TELEMETRY_PATH } from '@api/modules/auth/auth.plugin';
import { WORKFLOW_GROUPS_PATH } from '@api/modules/workflow-groups/workflow-groups.caller';

/** `METHOD path` as Elysia lists the route. */
export type RouteName = `${string} /${string}`;

/** Which key a route takes on Docker: its workflow group's (`group_key`, a dashboard route under
 * one); the key of any workflow group (`workflows_key`, a route with no workflow group in its
 * path, which answers with what the key opens); the deploy key or its workflow group's
 * (`deploy_key`, the other /v1/workflow-groups routes); or none. `unguarded` is a route in none,
 * which the auth test fails on. */
export type RouteKind = 'group_key' | 'workflows_key' | 'deploy_key' | 'open' | 'unguarded';

// Written here, not read from the guards, so a route mounted outside them shows up: every route
// is one of these, or needs a key.
export const OPEN_ROUTES: readonly RouteName[] = [
  'OPTIONS /',
  'OPTIONS /*',
  'GET /docs',
  'GET /docs/json',
  'GET /v1/healthz',
  'GET /v1/readyz',
  'GET /v1/auth/status',
  // A workflow group's OTLP receivers: the Global Controller that sends them holds no key.
  'POST /v1/workflow-groups/:workflow_group_id/traces',
  'POST /v1/workflow-groups/:workflow_group_id/metrics',
  'POST /v1/workflow-groups/:workflow_group_id/logs',
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export interface SweptRoute {
  readonly route: RouteName;
  readonly method: string;
  readonly path: string;
  readonly kind: RouteKind;
}

function kind_of(route: RouteName, path: string): RouteKind {
  if (OPEN_ROUTES.includes(route)) return 'open';
  if (DASHBOARD_PATH.test(path)) return 'group_key';
  if (TELEMETRY_PATH.test(path)) return 'unguarded';
  if (under(path, WORKFLOW_GROUPS_PATH)) return 'deploy_key';
  if (API_KEY_PATHS.some((prefix) => under(path, prefix))) return 'workflows_key';
  return 'unguarded';
}

/** Every route the API serves, with the key it takes. */
export function sweep_routes(): SweptRoute[] {
  return app.routes.map(({ method, path }) => {
    const route = `${method} ${path}` as RouteName;
    return { route, method, path, kind: kind_of(route, path) };
  });
}

export interface SweepAnswer {
  readonly route: RouteName;
  readonly status: number;
  readonly error: string | undefined;
}

/** `route`'s status and error code from the API at `url`, sent with `headers`, the path
 * parameters `params` names and, for the rest, ones no route takes, a query no route takes and,
 * but on a GET, `body` (unparsable JSON unless given): an answer that does not depend on the
 * request was given before it was read. */
export async function sweep_answer(
  url: string,
  { route, method, path }: SweptRoute,
  headers: Record<string, string> = {},
  body = '{',
  params: Record<string, string> = {}
): Promise<SweepAnswer> {
  const filled = path.replace(/:([^/]+)/g, (_, name: string) => params[name] ?? 'not-an-id');
  const target = `${filled}?from=never&limit=lots&tail=lots`;
  const response = await fetch(`${url}${target}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body }),
  });
  const text = await response.text();
  let error: string | undefined;
  try {
    error = (JSON.parse(text) as { error?: string }).error;
  } catch {
    error = undefined;
  }
  return { route, status: response.status, error };
}
