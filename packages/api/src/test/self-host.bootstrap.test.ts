import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { companies, projects, users } from '@api/db/schema';
import {
  ADMIN_EMAIL,
  bootstrap_canyonos,
  ensure_canyonos_project,
} from '@api/modules/canyonos/canyonos.bootstrap';
import { config } from '@core/env';

import { UserStatusEnum } from '../modules/auth/types';
import { api, setupE2ETests } from './e2e.setup';
import { bearer } from './project-test.utils';
import { write_project_span } from './telemetry-test.utils';

setupE2ETests();

const ADMIN_NAME = 'admin';
const BYPASS_CODE = '111111';
const NOW_NANOS = BigInt(Date.now()) * 1_000_000n;
const MINUTE_NANOS = 60_000_000_000n;

const count_projects = async (): Promise<number> =>
  (await db.select({ id: projects.id }).from(projects)).length;

async function read_admin(): Promise<
  | {
      id: string;
      name: string | null;
      status: string;
      companyId: string | null;
      lockedAt: string | null;
    }
  | undefined
> {
  const [row] = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  return row;
}

async function count_admin_rows(): Promise<{ users: number; companies: number }> {
  const admin_users = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL));
  const admin_companies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, ADMIN_NAME));
  return { users: admin_users.length, companies: admin_companies.length };
}

async function read_project(project_id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, project_id)).limit(1);
  return row;
}

async function seed_foreign_project(label: string): Promise<string> {
  const [company] = await db.insert(companies).values({ name: label }).returning();
  const [user] = await db
    .insert(users)
    .values({ email: `${label}@cc-forge.test`, name: label, companyId: company!.id })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ company_id: company!.id, created_by: user!.id, name: label })
    .returning();
  return project!.id;
}

async function sign_in_as_admin(): Promise<string> {
  const verify = await api.auth.verify.post({ email: ADMIN_EMAIL, code: BYPASS_CODE });
  expect(verify.error).toBeNull();
  const token = verify.data?.token;
  if (!token) throw new Error('Admin sign-in returned no token');
  return token;
}

describe('canyonos bootstrap', () => {
  test('the suite runs with AUTH_MODE=fixed_code', () => {
    expect(config.auth.mode).toBe('fixed_code');
  });

  // The suite points the Redis client at a closed port, so boot took the unreachable path.
  test('start-up created the admin company and user without Redis', async () => {
    expect(await count_admin_rows()).toEqual({ users: 1, companies: 1 });

    const admin = await read_admin();
    expect(admin?.name).toBe(ADMIN_NAME);
    expect(admin?.status).toBe('ACTIVE');
    expect(admin?.companyId).not.toBeNull();
  });

  test('an unusable identity still leaves the admin in place and creates no project', async () => {
    const before = await count_projects();

    for (const identity of ['0', '', '   ', 'not-a-uuid', null]) {
      expect(await ensure_canyonos_project(identity)).toBe(false);
    }
    await bootstrap_canyonos();

    expect(await count_projects()).toBe(before);
    expect(await count_admin_rows()).toEqual({ users: 1, companies: 1 });
  });

  test('the controller project is created under the admin company', async () => {
    const project_id = '11111111-1111-4111-8111-111111111111';
    expect(await ensure_canyonos_project(project_id)).toBe(true);

    const project = await read_project(project_id);
    const admin = await read_admin();
    expect(project?.name).toBe('project_1');
    expect(project?.company_id).toBe(admin!.companyId!);
    expect(project?.created_by).toBe(admin!.id);
  });

  test('a rerun with the same id writes no rows', async () => {
    const project_id = '22222222-2222-4222-8222-222222222222';
    await ensure_canyonos_project(project_id);
    const before = await count_projects();

    await ensure_canyonos_project(project_id);

    expect(await count_projects()).toBe(before);
    expect(await count_admin_rows()).toEqual({ users: 1, companies: 1 });
  });

  test('an existing project keeps its name, company, creator, and timestamps', async () => {
    const project_id = await seed_foreign_project('kept-owner');
    const before = await read_project(project_id);

    expect(await ensure_canyonos_project(project_id)).toBe(true);

    expect(await read_project(project_id)).toEqual(before!);
  });
});

describe('POST /auth/challenge under fixed_code', () => {
  test('succeeds with no SMTP configured, because the mode sends no mail', async () => {
    expect(config.email.enabled).toBe(false);
    expect(Bun.env.SMTP_HOST).toBeFalsy();

    const challenge = await api.auth.challenge.post({ email: 'no-smtp@example.com' });

    expect(challenge.error).toBeNull();
    expect(challenge.data).toEqual({ ok: true });
  });
});

describe('POST /v1/traces under fixed_code', () => {
  test('accepts an empty OTLP export unauthenticated', async () => {
    const response = await fetch(`${config.app.apiUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(),
    });

    expect(response.status).toBe(200);
  });
});

describe('canyonos admin sign-in', () => {
  test('the admin email verifies with the bypass code and no prior challenge', async () => {
    const verify = await api.auth.verify.post({ email: ADMIN_EMAIL, code: BYPASS_CODE });

    expect(verify.error).toBeNull();
    expect(verify.data?.token).toBeString();
    expect(verify.data?.user.email).toBe(ADMIN_EMAIL);
    expect(verify.data?.user.status).toBe(UserStatusEnum.ACTIVE);
  });

  test('the profile route returns the bootstrapped admin', async () => {
    const token = await sign_in_as_admin();
    const admin = await read_admin();

    const profile = await api.auth.profile.get({ $headers: bearer(token) });

    expect(profile.error).toBeNull();
    expect(profile.data?.id).toBe(admin!.id);
    expect(profile.data?.company_id).toBe(admin!.companyId!);
  });

  test('a request without a bearer token is rejected', async () => {
    const profile = await api.auth.profile.get();

    expect(profile.error?.status as number).toBe(401);
  });
});

describe('canyonos admin reads', () => {
  test('the admin lists, opens, and reads requests for the controller project', async () => {
    const project_id = '33333333-3333-4333-8333-333333333333';
    await ensure_canyonos_project(project_id);
    await write_project_span(project_id, {
      span_id: 'canyonos-admin-span',
      trace_id: 'canyonos-admin-trace',
      start_time_unix_nano: NOW_NANOS - MINUTE_NANOS,
      end_time_unix_nano: NOW_NANOS,
    });
    const token = await sign_in_as_admin();
    const headers = bearer(token);

    const listed = await api.projects.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data!.map((project) => project.id)).toContain(project_id);

    const detail = await api.projects[project_id]!.get({ $headers: headers });
    expect(detail.error).toBeNull();
    expect(detail.data?.name).toBe('project_1');

    const requests = await api.projects[project_id]!.requests.get({
      $headers: headers,
      $query: { limit: 20, offset: 0 },
    });
    expect(requests.error).toBeNull();
    expect(requests.data?.items.map((item) => item.session_id)).toEqual(['canyonos-admin-trace']);
  });

  test('the admin lists and opens a project owned by another company', async () => {
    const foreign_id = await seed_foreign_project('foreign-company');
    const token = await sign_in_as_admin();

    const listed = await api.projects.get({ $headers: bearer(token) });
    expect(listed.error).toBeNull();
    expect(listed.data!.map((project) => project.id)).toContain(foreign_id);

    const detail = await api.projects[foreign_id]!.get({ $headers: bearer(token) });
    expect(detail.data?.id).toBe(foreign_id);
  });
});
