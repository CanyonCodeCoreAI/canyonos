// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from '@api/app';
import { API_KEY_PATHS, DASHBOARD_PATH, is_routed_to } from '@api/modules/auth/auth.plugin';
import { CONTROL_PATH_PREFIX } from '@api/modules/auth/control-key';

/** `METHOD path` as Elysia lists the route. */
export type RouteName = `${string} /${string}`;

/** Which key a route takes: the dashboard's API key, the CLI's control key, or none. `unguarded`
 * is a route in none of the three, which the auth test fails on. */
export type RouteKind = 'api_key' | 'control_key' | 'open' | 'unguarded';

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
  if (is_routed_to(new Request(`http://localhost${path}`), DASHBOARD_PATH)) return 'api_key';
  if (under(path, CONTROL_PATH_PREFIX)) return 'control_key';
  if (API_KEY_PATHS.some((prefix) => under(path, prefix))) return 'api_key';
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

/** `route`'s status and error code from the API at `url`, sent with `headers`, path parameters
 * no route takes, a query no route takes and, but on a GET, `body` (unparsable JSON unless
 * given): an answer that does not depend on the request was given before it was read. */
export async function sweep_answer(
  url: string,
  { route, method, path }: SweptRoute,
  headers: Record<string, string> = {},
  body = '{'
): Promise<SweepAnswer> {
  const target = `${path.replace(/:[^/]+/g, 'not-an-id')}?from=never&limit=lots&tail=lots`;
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
