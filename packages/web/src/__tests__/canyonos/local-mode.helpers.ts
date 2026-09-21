import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { UserStatusEnum } from '@cc-forge/api/auth';
import type { User } from '@cc-forge/api/auth';
import type { KpiWindow, MetricsWindow } from '@cc-forge/api/metrics';
import type { ProjectSummary } from '@cc-forge/api/projects';

import { validToken } from '../helpers/auth';
import { apiBaseUrl, failJson, fulfillJson } from '../helpers/projects';

const apiOrigin = new URL(apiBaseUrl).origin;

/** The address and code `signInAsCanyonOsAdmin` is expected to send, spelled out independently. */
export const ADMIN_EMAIL = 'admin@canyonos.invalid';
export const BYPASS_CODE = '111111';

export const PROJECT: ProjectSummary = {
  id: '44444444-4444-4444-8444-444444444401',
  name: 'Local Fraud Screen',
  file_count: 5,
  created_at: '2026-07-01T12:00:00.000Z',
  updated_at: '2026-07-01T12:00:00.000Z',
};

// `company_id` is null so the sidebar's account menu has no company to look up: one fewer endpoint
// standing between these specs and what they are actually about.
const ADMIN_USER: User = {
  id: '55555555-5555-4555-8555-555555555501',
  email: ADMIN_EMAIL,
  name: 'CanyonOS Admin',
  company_id: null,
  status: UserStatusEnum.ACTIVE,
  created_at: '2026-01-01T00:00:00.000Z',
};

export async function expectPath(page: Page, expected: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

const isGet = (route: Route) => route.request().method() === 'GET';

async function routePath(
  page: Page,
  pathname: string,
  handler: (route: Route, url: URL) => Promise<void>
): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === pathname,
    (route) => (isGet(route) ? handler(route, new URL(route.request().url())) : route.continue())
  );
}

export interface LocalSession {
  /** Every body posted to `/auth/verify`, in order, so a spec can assert both shape and count. */
  readonly verify_bodies: unknown[];
  /** Flipped by a spec to make the next sign-in attempt succeed or fail. */
  fails: boolean;
}

/**
 * Answer the two calls a local install makes to open its own session.
 *
 * Fulfilled rather than seeded: the account this signs in as belongs to the machine image, so a
 * spec that needed the real one could only run on a box that already is one.
 */
export async function stubLocalSession(
  page: Page,
  { fails = false }: { readonly fails?: boolean } = {}
): Promise<LocalSession> {
  const session: LocalSession = { verify_bodies: [], fails };

  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/auth/verify',
    (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      session.verify_bodies.push(route.request().postDataJSON());
      if (session.fails) {
        return fulfillJson(
          route,
          { error: 'auth.invalid_code', message: 'Invalid or expired code' },
          401
        );
      }
      return fulfillJson(route, { token: validToken, user: ADMIN_USER });
    }
  );
  await routePath(page, '/auth/profile', (route) => fulfillJson(route, ADMIN_USER));

  return session;
}

export async function stubProjectsList(
  page: Page,
  projects: readonly ProjectSummary[]
): Promise<void> {
  await routePath(page, '/projects', (route) => fulfillJson(route, projects));
}

/** The fleet rollup the overview rows read spend from. Local mode still asks; it answers empty. */
export async function stubFleetSpend(page: Page): Promise<void> {
  await routePath(page, '/resources/overview', (route) =>
    fulfillJson(route, { kpis: [], resources: [], projects: [], time_window: '30d' })
  );
}

const EMPTY_KPI_WINDOW: KpiWindow = {
  request_count: 0,
  block_count: 0,
  failed_block_count: 0,
  tokens: 0,
  per_block_tokens: null,
  harness_cost: '0.000000',
  llm_cost: '0.000000',
  total_cost: '0.000000',
  recoverable_cost: '0.000000',
  per_block_cost: null,
  per_block_latency_ms: null,
  costed_block_count: 0,
  costed_request_count: 0,
  per_costed_request_cost: null,
};

const requestedWindow = (url: URL): MetricsWindow =>
  (url.searchParams.get('time_window') as MetricsWindow | null) ?? '30d';

export interface ProjectDashboardOptions {
  /** Fail the KPI read, which is what the cost ribbon's error state is drawn from. */
  readonly kpis_fail?: boolean;
}

/**
 * A project dashboard that ran nothing: every metrics endpoint answers, and answers empty.
 *
 * Deploy endpoints are deliberately absent — `watchDeployRequests` owns those, so a request to one
 * is recorded rather than quietly served.
 */
export async function stubProjectDashboard(
  page: Page,
  project: ProjectSummary,
  { kpis_fail = false }: ProjectDashboardOptions = {}
): Promise<void> {
  const base = `/projects/${project.id}`;

  await routePath(page, base, (route) => fulfillJson(route, project));
  await routePath(page, `${base}/stats`, (route) =>
    fulfillJson(route, {
      project_id: project.id,
      file_count: project.file_count,
      workflow_count: 1,
      ready_workflow_count: 1,
      agent_count: 2,
      tool_count: 1,
    })
  );
  await routePath(page, `${base}/metrics/kpis`, (route) =>
    kpis_fail
      ? failJson(route, 'Could not read cost totals')
      : fulfillJson(route, {
          project_id: project.id,
          generated_at: '2026-07-29T12:00:00.000Z',
          windows: {
            '1d': EMPTY_KPI_WINDOW,
            '7d': EMPTY_KPI_WINDOW,
            '30d': EMPTY_KPI_WINDOW,
            '1q': EMPTY_KPI_WINDOW,
          },
        })
  );
  await routePath(page, `${base}/metrics/timeseries`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      time_window: requestedWindow(url),
      bucket_seconds: 86_400,
      points: [],
    })
  );
  await routePath(page, `${base}/metrics/blocks`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      time_window: requestedWindow(url),
      total_cost: '0.000000',
      blocks: [],
    })
  );
  await routePath(page, `${base}/metrics/distribution`, (route, url) =>
    fulfillJson(route, {
      project_id: project.id,
      metric: url.searchParams.get('metric') ?? 'cost_per_request',
      time_window: requestedWindow(url),
      request_count: 0,
      mean: null,
      std: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      buckets: [],
    })
  );
  await routePath(page, `${base}/requests`, (route) => fulfillJson(route, { total: 0, items: [] }));
  await routePath(page, `${base}/workflows`, (route) => fulfillJson(route, []));
  await routePath(page, `${base}/files`, (route) => fulfillJson(route, []));
}

/**
 * Record every deploy read the dashboard makes, and answer it.
 *
 * Answering matters: a spec asserting "nothing asked" has to fail on the assertion rather than on a
 * screen stuck behind an unanswered request.
 */
export async function watchDeployRequests(page: Page): Promise<string[]> {
  const hits: string[] = [];

  await page.route(
    (url) => url.origin === apiOrigin && url.pathname.endsWith('/deploy/summary'),
    (route) => {
      hits.push(new URL(route.request().url()).pathname);
      return fulfillJson(route, { active: null, latest: null });
    }
  );
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === '/projects/deployments',
    (route) => {
      hits.push(new URL(route.request().url()).pathname);
      return fulfillJson(route, []);
    }
  );

  return hits;
}
