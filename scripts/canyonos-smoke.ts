// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Compose smoke for the CanyonOS API and web images.
 *
 * The controller identity is one direct Redis `HSET` and the telemetry fixture is one direct
 * PostgreSQL insert. No receiver, collector, exporter, poller, Core, controller, or agent runs:
 * the point is to prove the image reads rows that already exist.
 */

import { $ } from 'bun';

const COMPOSE_FILE = '.docker/canyonos-smoke.compose.yml';
const PROJECT_ID = 'f1e2d3c4-b5a6-4798-8a9b-0c1d2e3f4a5b';
const TRACE_ID = 'smoke-trace';
const SMOKE_EMAIL = 'smoke@canyonos.test';
const SMOKE_PASSWORD = 'smoke-password-1';
const API_PORT = Bun.env.SMOKE_API_PORT ?? '53000';
const WEB_PORT = Bun.env.SMOKE_WEB_PORT ?? '58080';
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const compose = (...args: string[]) => $`docker compose -f ${COMPOSE_FILE} ${args}`;

const log = (message: string) => console.log(`[smoke] ${message}`);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const equal = (actual: unknown, expected: unknown, message: string) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );

async function waitFor<T>(label: string, budgetMs: number, probe: () => Promise<T | null>) {
  const deadline = Date.now() + budgetMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== null) return result;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
}

const getJson = async (path: string, token?: string): Promise<{ status: number; body: any }> => {
  const headers = token === undefined ? undefined : { authorization: `Bearer ${token}` };
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const postJson = async (url: string, payload: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

/** Register the smoke account, or log in once registration is closed by an earlier step. */
async function signIn(apiUrl: string): Promise<string> {
  const credentials = { email: SMOKE_EMAIL, password: SMOKE_PASSWORD };
  const registered = await postJson(`${apiUrl}/auth/register`, {
    ...credentials,
    password_confirmation: SMOKE_PASSWORD,
  });
  const closed = registered.status === 403;
  const session = closed ? await postJson(`${apiUrl}/auth/login`, credentials) : registered;
  equal(
    session.status,
    closed ? 200 : 201,
    'the smoke account registers, or logs in once registration is closed'
  );
  check(session.body?.token, 'the sign-in returns a token');
  equal(session.body.user.email, SMOKE_EMAIL, 'the token belongs to the smoke account');
  return session.body.token as string;
}

const waitForHealth = () =>
  waitFor('/healthz', 120_000, async () => {
    const { status } = await getJson('/healthz');
    return status === 200 ? true : null;
  });

const getProxiedJson = async (
  path: string,
  token: string
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${WEB_URL}/api${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const waitForWeb = () =>
  waitFor(`${WEB_URL}/healthz`, 120_000, async () => {
    const response = await fetch(`${WEB_URL}/healthz`);
    return response.ok ? await response.text() : null;
  });

/** One canonical span, inserted through the container's own psql so the host needs no driver. */
async function seedTelemetry() {
  const start = BigInt(Date.now()) * 1_000_000n - 600_000_000_000n;
  const attributes = JSON.stringify({
    'canyon.project.id': PROJECT_ID,
    'gen_ai.request.model': 'claude-opus-5',
    'gen_ai.usage.input_tokens': 120,
    'gen_ai.usage.output_tokens': 30,
    'gen_ai.usage.cost': 0.25,
  });
  const statement = `insert into otel_spans
      (span_id, trace_id, name, status_code, start_time_unix_nano, end_time_unix_nano,
       attributes, input, output)
    values ('smoke-span', '${TRACE_ID}', 'agent.run', 'STATUS_CODE_UNSET',
      ${start}, ${start + 60_000_000_000n}, '${attributes}'::jsonb, 'asked', 'answered')
    on conflict (span_id) do nothing;`;

  await compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'canyonos',
    '-d',
    'canyonos',
    '-c',
    statement
  );
}

const findProject = (body: any) => body?.find?.((row: any) => row.id === PROJECT_ID);

async function main() {
  log('building the images');
  await $`docker build -f packages/api/Dockerfile -t canyonos-api:smoke .`;
  // CI prebuilds the web image and names it in CANYONOS_WEB_IMAGE, which the compose file reads.
  if (!Bun.env.CANYONOS_WEB_IMAGE) {
    // The image bakes a relative API base URL, so the bundle carries no host or port.
    await $`docker build -f packages/web/Dockerfile --target canyonos --build-arg VITE_API_URL=/api -t canyonos-web:smoke .`;
  }

  log('starting postgres and redis');
  await compose('up', '-d', '--wait', 'postgres', 'redis');

  log('publishing the controller identity');
  await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    'HSET',
    'controller:identity',
    'project_id',
    PROJECT_ID
  );

  log('starting the api');
  await compose('up', '-d', 'api');
  await waitForHealth();

  log('registering the smoke account');
  const token = await signIn(BASE_URL);
  const profile = await getJson('/auth/profile', token);
  equal(profile.status, 200, 'the profile route accepts the new token');
  equal(profile.body.email, SMOKE_EMAIL, 'the profile is the smoke account');

  equal((await getJson('/projects')).status, 401, 'the project list still needs a token');

  log('checking the bootstrapped project');
  const projects = await getJson('/projects', token);
  equal(projects.status, 200, 'the user lists the bootstrapped project');
  const project = findProject(projects.body);
  check(project, 'the bootstrap used the controller id to create the project row');
  equal(project.name, 'project_1', 'the bootstrapped project uses the default name');
  equal(project.file_count, 0, 'the bootstrapped project has no files');

  log('inserting the telemetry fixture');
  await seedTelemetry();

  log('reading the fixture back through the image');
  const listing = await getJson(`/projects/${PROJECT_ID}/requests`, token);
  equal(listing.status, 200, 'the user reads the request listing');
  equal(listing.body.total, 1, 'the inserted trace is listed');
  equal(listing.body.items[0].session_id, TRACE_ID, 'the listed trace is the inserted one');

  log('starting the web image');
  await compose('up', '-d', 'web');
  equal((await waitForWeb()).trim(), 'ok', 'the web health path answers the Docker health check');

  log('checking the SPA fallback on a deep link');
  const deep_link = await fetch(`${WEB_URL}/projects/${PROJECT_ID}`);
  equal(deep_link.status, 200, 'a client-side route is served by the SPA fallback');
  check(
    deep_link.headers.get('content-type')?.includes('text/html'),
    'the SPA fallback returns the app document, not a 404'
  );
  check(
    deep_link.headers.get('x-frame-options') === 'DENY',
    'the security headers survive the proxy and fallback rules'
  );

  log('checking the /api proxy and the prefix strip');
  const proxied_health = await fetch(`${WEB_URL}/api/healthz`);
  equal(proxied_health.status, 200, 'the web image proxies /api to the api service by default');
  equal(
    (await fetch(`${WEB_URL}/api/projects`)).status,
    401,
    'the proxy forwards to the real API, which still refuses an unauthenticated read'
  );

  log('logging in through the web proxy, the way the dashboard does');
  const proxied_token = await signIn(`${WEB_URL}/api`);
  const proxied_profile = await getProxiedJson('/auth/profile', proxied_token);
  equal(proxied_profile.status, 200, 'the proxied profile route accepts the token it just issued');
  equal(proxied_profile.body.email, SMOKE_EMAIL, 'the proxied session is the smoke account');
  const proxied_projects = await getProxiedJson('/projects', proxied_token);
  equal(proxied_projects.status, 200, 'the user lists projects through the proxy');
  equal(
    findProject(proxied_projects.body)?.id,
    PROJECT_ID,
    'the proxied project list is the same one the API serves directly'
  );

  log('restarting to prove the bootstrap is idempotent');
  await compose('restart', 'api');
  await waitForHealth();
  const after = await getJson('/projects', await signIn(BASE_URL));
  equal(
    after.body.filter((row: any) => row.id === PROJECT_ID).length,
    1,
    'a restart does not duplicate the project'
  );

  log('PASS');
}

try {
  await main();
} catch (error) {
  console.error('[smoke] FAIL', error);
  await compose('logs', '--tail', '80', 'api', 'web').nothrow();
  process.exitCode = 1;
} finally {
  // Always runs, so a failed smoke never leaves containers or volumes behind.
  await compose('down', '-v', '--remove-orphans').nothrow();
}
